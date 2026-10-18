import { z } from 'zod';
import { withUserContext, type Tx } from '@sf/db';
import type { ChatVisual, DraftDTO, VoiceSessionDTO, VoiceToolResponse } from '@sf/shared';
import type { Config } from '../config.js';
import type { Actor, AppContext } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import { recordUsage } from '../lib/usage.js';
import { cancelDraft, confirmDraft } from '../domain/drafts.js';
import { ensureConversation, loadWorkspaceContext, runTool } from '../agent/orchestrator.js';
import { dynamicContext, LIVE_PROMPT, VOICE_PROMPT } from '../agent/prompts.js';
import { toolDefs } from '../agent/registry.js';

/** Minutos de conversa por voz por dia, por plano. */
export const PLAN_DAILY_VOICE_MINUTES: Record<string, number> = { free: 20, pro: 120 };
/** Ferramentas que dependem de anexo enviado pelo chat escrito. */
const NOT_IN_VOICE = new Set(['parse_attachment', 'import_attachment']);
const MAX_OUTPUT = 16_000;

/** Chave da OpenAI para a conversa por voz (ou null quando o recurso está desligado). */
export function realtimeKey(config: Config): string | null {
  if (config.REALTIME_API_KEY) return config.REALTIME_API_KEY;
  const transcribeIsOpenAI = !config.TRANSCRIBE_URL || config.TRANSCRIBE_URL.includes('api.openai.com');
  return config.TRANSCRIBE_API_KEY && transcribeIsOpenAI ? config.TRANSCRIBE_API_KEY : null;
}

// Ferramentas que só existem na voz: a confirmação falada ("sim, pode gravar") vira chamada explícita.
const draftIdsSchema = z.object({
  draft_ids: z
    .array(z.string().uuid())
    .max(20)
    .optional()
    .describe('IDs das prévias (draft_id). Vazio = todas as prévias pendentes desta conversa.'),
});
const VOICE_TOOLS = [
  {
    name: 'confirm_drafts',
    description:
      'Grava as prévias que o usuário acabou de aprovar em voz alta ("sim", "pode gravar", "confirma"). Só chame depois de um sim claro.',
  },
  {
    name: 'cancel_drafts',
    description: 'Descarta as prévias que o usuário recusou ("não", "cancela", "deixa pra lá"). Nada é gravado.',
  },
];

function realtimeTools(readOnly: boolean) {
  const params = z.toJSONSchema(draftIdsSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete params.$schema;
  return [
    ...toolDefs({ readOnly })
      .filter((t) => !NOT_IN_VOICE.has(t.name))
      .map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema })),
    ...(readOnly ? [] : VOICE_TOOLS.map((t) => ({ type: 'function', ...t, parameters: params }))),
  ];
}

async function voiceSecondsToday(app: AppContext, actor: Actor) {
  return withUserContext(app.db, actor.userId, async (tx) => {
    const ws = await tx
      .selectFrom('workspaces')
      .select('plan')
      .where('id', '=', actor.workspaceId)
      .executeTakeFirstOrThrow();
    // a duração de cada conversa fica em latency_ms
    const r = await tx
      .selectFrom('llmUsage')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('latencyMs'), eb.lit(0)).as('ms'))
      .where('workspaceId', '=', actor.workspaceId)
      .where('userId', '=', actor.userId)
      .where('purpose', '=', 'voice')
      .where('at', '>', new Date(Date.now() - 86_400_000))
      .executeTakeFirst();
    return { plan: ws.plan, seconds: Math.round(Number(r?.ms ?? 0) / 1000) };
  });
}

/** Garante que a conversa é do usuário neste workspace. */
export async function assertConversation(tx: Tx, actor: Actor, conversationId: string) {
  const conv = await tx
    .selectFrom('conversations')
    .select('id')
    .where('id', '=', conversationId)
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .executeTakeFirst();
  if (!conv) throw notFound('Conversa');
}

const voiceFailed = () =>
  new AppError(502, 'Não consegui iniciar a conversa por voz agora. Tente de novo.', 'voice_failed');

/** POST JSON na OpenAI com a chave do servidor; erros viram mensagem amigável (detalhe só no log). */
async function openaiPost(app: AppContext, key: string, path: string, body: unknown): Promise<unknown> {
  const base = app.config.REALTIME_URL.replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    app.log.warn({ err, path }, 'falha ao criar sessão de voz');
    throw voiceFailed();
  }
  if (!res.ok) {
    app.log.warn({ status: res.status, path, body: (await res.text()).slice(0, 800) }, 'sessão de voz recusada');
    if (res.status === 429)
      throw new AppError(429, 'O serviço de voz está ocupado agora. Tente de novo em instantes.', 'voice_failed');
    throw voiceFailed();
  }
  return res.json();
}

/**
 * Cria a sessão de voz (sem expor a chave da OpenAI ao navegador):
 * - `realtime`: segredo efêmero com instruções, contexto e ferramentas; o navegador troca o SDP direto.
 * - `live`: o servidor cria a sessão GPT-Live com a oferta SDP do navegador e devolve a resposta.
 */
export async function createVoiceSession(
  app: AppContext,
  actor: Actor,
  opts: {
    conversationId?: string | null;
    pageContext?: { panel: string; detail?: string } | null;
    sdp?: string | null;
  },
): Promise<VoiceSessionDTO> {
  const key = realtimeKey(app.config);
  if (!key) throw new AppError(503, 'A conversa por voz não está configurada.', 'voice_off');
  const provider = app.config.VOICE_PROVIDER;
  if (provider === 'live' && !opts.sdp)
    throw new AppError(400, 'Oferta de conexão ausente. Recarregue a página e tente de novo.', 'voice_sdp');

  const { plan, seconds } = await voiceSecondsToday(app, actor);
  const remaining = (PLAN_DAILY_VOICE_MINUTES[plan] ?? PLAN_DAILY_VOICE_MINUTES.free!) * 60 - seconds;
  if (remaining < 30)
    throw new AppError(
      429,
      'Você atingiu o limite diário de conversa por voz do seu plano. Pode continuar pelo chat escrito.',
      'plan_limit',
    );

  if (opts.conversationId)
    await withUserContext(app.db, actor.userId, (tx) => assertConversation(tx, actor, opts.conversationId!));
  const conv = await ensureConversation(app, actor, opts.conversationId);
  const ctx = await loadWorkspaceContext(app, actor, conv.conversationId, 0);
  const context = dynamicContext({
    ...ctx.prompt,
    userName: conv.userName,
    workspaceName: conv.workspaceName,
    role: actor.role,
    channel: 'voice',
    pageContext: opts.pageContext,
  });
  const base = {
    conversationId: conv.conversationId,
    maxSeconds: Math.min(app.config.REALTIME_MAX_MINUTES * 60, remaining),
    userFirstName: conv.userName.trim().split(/\s+/)[0] ?? '',
  };

  if (provider === 'live') {
    // A camada de voz só conversa; dados e ações são delegados ao orquestrador (delegation: client).
    // Leva só o essencial do contexto para não responder sozinha o que precisa ser consultado.
    const firstName = base.userFirstName;
    const instructions = `${LIVE_PROMPT}

Contexto
- Hoje: ${ctx.prompt.today} (${ctx.prompt.weekday}). Usuário: ${conv.userName}. Workspace: ${conv.workspaceName}.${actor.role === 'viewer' ? ' O usuário só pode consultar; não ofereça registrar nada.' : ''}
- Ao começar, cumprimente ${firstName || 'o usuário'} pelo primeiro nome em uma frase curta e pergunte como pode ajudar com as finanças.`;
    const body = (await openaiPost(app, key, '/live/sessions', {
      session: {
        model: app.config.LIVE_MODEL,
        instructions,
        ...(app.config.LIVE_VOICE ? { audio: { output: { voice: app.config.LIVE_VOICE } } } : {}),
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: opts.sdp },
    })) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!body.session?.id || !body.transport?.sdp)
      throw new AppError(502, 'Resposta inválida do serviço de voz.', 'voice_failed');
    return {
      ...base,
      provider: 'live',
      model: app.config.LIVE_MODEL,
      sessionId: body.session.id,
      answerSdp: body.transport.sdp,
    };
  }

  const body = (await openaiPost(app, key, '/realtime/client_secrets', {
    expires_after: { anchor: 'created_at', seconds: 120 },
    session: {
      type: 'realtime',
      model: app.config.REALTIME_MODEL,
      instructions: `${VOICE_PROMPT}\n\nContexto atual\n${context}`,
      output_modalities: ['audio'],
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: app.config.REALTIME_TRANSCRIBE_MODEL, language: 'pt' },
          turn_detection: { type: 'semantic_vad', eagerness: 'auto' },
        },
        output: { voice: app.config.REALTIME_VOICE },
      },
      tools: realtimeTools(actor.role === 'viewer'),
      tool_choice: 'auto',
    },
  })) as { value?: string; expires_at?: number };
  if (!body.value) throw new AppError(502, 'Resposta inválida do serviço de voz.', 'voice_failed');
  return {
    ...base,
    provider: 'realtime',
    model: app.config.REALTIME_MODEL,
    clientSecret: body.value,
    expiresAt: body.expires_at ?? Math.floor(Date.now() / 1000) + 120,
    callsUrl: `${app.config.REALTIME_URL.replace(/\/$/, '')}/realtime/calls`,
  };
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Executa uma ferramenta pedida pelo modelo de voz, com as mesmas regras do chat escrito. */
export async function runVoiceTool(
  app: AppContext,
  actor: Actor,
  input: { conversationId: string; name: string; arguments: string },
): Promise<VoiceToolResponse> {
  await withUserContext(app.db, actor.userId, (tx) => assertConversation(tx, actor, input.conversationId));
  const out: VoiceToolResponse = { output: '', isError: false, drafts: [], visuals: [], confirmed: [], cancelled: [] };
  const args = parseArgs(input.arguments);
  const fail = (error: string) => ({ ...out, output: JSON.stringify({ error }), isError: true });
  if (args === undefined) return fail('Argumentos em JSON inválido.');

  if (input.name === 'confirm_drafts' || input.name === 'cancel_drafts') {
    if (actor.role === 'viewer') return fail('O usuário só tem permissão de leitura neste workspace.');
    const parsed = draftIdsSchema.safeParse(args);
    if (!parsed.success) return fail('Parâmetros inválidos.');
    return decideDrafts(app, actor, input.conversationId, input.name, parsed.data.draft_ids ?? []);
  }
  if (NOT_IN_VOICE.has(input.name)) return fail('Essa ação precisa de um anexo enviado pelo chat escrito.');

  const drafts: DraftDTO[] = [];
  const visuals: ChatVisual[] = [];
  const r = await runTool(
    app,
    actor,
    input.conversationId,
    [],
    input.name,
    args,
    (d) => drafts.push(d),
    (v) => visuals.push(v),
  );
  return { ...out, output: JSON.stringify(r.result).slice(0, MAX_OUTPUT), isError: r.isError, drafts, visuals };
}

async function decideDrafts(
  app: AppContext,
  actor: Actor,
  conversationId: string,
  name: 'confirm_drafts' | 'cancel_drafts',
  ids: string[],
): Promise<VoiceToolResponse> {
  // só prévias pendentes desta conversa; sem IDs, todas as pendentes
  const pending = await withUserContext(app.db, actor.userId, async (tx) => {
    let q = tx
      .selectFrom('drafts')
      .select('id')
      .where('workspaceId', '=', actor.workspaceId)
      .where('conversationId', '=', conversationId)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', new Date())
      .orderBy('createdAt');
    if (ids.length) q = q.where('id', 'in', ids);
    return q.execute();
  });
  const res: VoiceToolResponse = { output: '', isError: false, drafts: [], visuals: [], confirmed: [], cancelled: [] };
  if (!pending.length) {
    return {
      ...res,
      isError: true,
      output: JSON.stringify({ error: 'Não há prévia pendente nesta conversa com esses IDs.' }),
    };
  }
  const results: Array<Record<string, unknown>> = [];
  for (const d of pending) {
    try {
      if (name === 'confirm_drafts') {
        const r = await withUserContext(app.db, actor.userId, (tx) => confirmDraft(tx, actor, d.id));
        res.confirmed.push({ draftId: d.id, summary: r.summary, impact: r.impact });
        results.push({ draft_id: d.id, status: 'gravado', summary: r.summary, impact: r.impact });
      } else {
        await withUserContext(app.db, actor.userId, (tx) => cancelDraft(tx, actor, d.id));
        res.cancelled.push(d.id);
        results.push({ draft_id: d.id, status: 'cancelado' });
      }
    } catch (err) {
      if (!(err instanceof AppError)) app.log.error({ err }, 'falha ao decidir draft por voz');
      results.push({
        draft_id: d.id,
        error: err instanceof AppError ? err.message : 'Não consegui concluir esta ação.',
      });
    }
  }
  return { ...res, output: JSON.stringify({ results }), isError: results.every((r) => 'error' in r) };
}

/** Registra a duração e o custo estimado de uma conversa encerrada. */
export async function endVoiceSession(app: AppContext, actor: Actor, seconds: number) {
  const s = Math.max(0, Math.min(seconds, app.config.REALTIME_MAX_MINUTES * 60 + 30));
  const live = app.config.VOICE_PROVIDER === 'live';
  // no GPT-Live a voz é barata; o raciocínio delegado já entra no uso do chat (Claude)
  const perMin = live ? app.config.LIVE_USD_PER_MIN : app.config.REALTIME_USD_PER_MIN;
  await recordUsage(
    app,
    actor,
    'openai',
    live ? app.config.LIVE_MODEL : app.config.REALTIME_MODEL,
    'voice',
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: Math.round((s / 60) * perMin * 1e6),
    },
    Math.round(s * 1000),
  );
}
