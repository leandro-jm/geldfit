import { fold, todayISO, type ChatStreamEvent, type DraftDTO, type PageContext } from '@sf/shared';
import { withUserContext } from '@sf/db';
import { LLMError, textOf, toolCallsOf, type LLMContent, type LLMMessage, type ModelTier } from '@sf/llm';
import type { Actor, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { recordUsage } from '../lib/usage.js';
import { cancelDraft, confirmDraft, toDraftDTO } from '../domain/drafts.js';
import { workspaceToday } from '../domain/ledger.js';
import { processAttachment } from '../import/service.js';
import { looksLikeRecommendation, SAFE_INVESTMENT_REPLY } from './compliance.js';
import { dynamicContext, SYSTEM_PROMPT } from './prompts.js';
import { toolDefs, TOOLS_BY_NAME } from './registry.js';
import type { ToolCtx } from './tool-kit.js';

const MAX_ITERATIONS = 8;
const HISTORY = 12;
const PLAN_DAILY_MESSAGES: Record<string, number> = { free: 150, pro: 1000 };

const CONFIRM =
  /^(sim|s|ok|okay|confirm(a|ar|o)?|pode( gravar| salvar| registrar)?|isso|certo|correto|beleza|blz|manda|1|✅|👍)[.! ]*$/;
const CANCEL = /^(nao|n|cancela(r)?|deixa|esquece|3|❌)[.! ]*$/;
const EDIT = /^(2|editar|edita|corrigir)[.! ]*$/;
const WEEKDAYS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

export interface IncomingChat {
  conversationId?: string | null;
  text: string;
  attachmentIds?: string[];
  pageContext?: PageContext | null;
}

export interface ChatResult {
  conversationId: string;
  messageId: string;
  text: string;
  drafts: DraftDTO[];
}

/** Pipeline de uma mensagem (web ou WhatsApp). `emit` recebe os eventos de streaming. */
export async function handleMessage(
  app: AppContext,
  actor: Actor,
  input: IncomingChat,
  emit: (e: ChatStreamEvent) => void = () => {},
): Promise<ChatResult> {
  const text = input.text.trim();
  const attachmentIds = input.attachmentIds ?? [];
  if (!text && !attachmentIds.length) throw new AppError(400, 'Mensagem vazia.');

  // 0) Limite diário por plano e conversa
  const { conversationId, userName, workspaceName, plan, sentToday } = await withUserContext(
    app.db,
    actor.userId,
    async (tx) => {
      let conv = input.conversationId
        ? await tx
            .selectFrom('conversations')
            .select('id')
            .where('id', '=', input.conversationId)
            .executeTakeFirst()
        : await tx
            .selectFrom('conversations')
            .select('id')
            .where('workspaceId', '=', actor.workspaceId)
            .where('userId', '=', actor.userId)
            .where('channel', '=', actor.channel)
            .orderBy('lastMessageAt', 'desc')
            .executeTakeFirst();
      if (!conv)
        conv = await tx
          .insertInto('conversations')
          .values({ workspaceId: actor.workspaceId, userId: actor.userId, channel: actor.channel })
          .returning('id')
          .executeTakeFirstOrThrow();
      const user = await tx
        .selectFrom('authUser')
        .select('name')
        .where('id', '=', actor.userId)
        .executeTakeFirstOrThrow();
      const ws = await tx
        .selectFrom('workspaces')
        .select(['name', 'plan'])
        .where('id', '=', actor.workspaceId)
        .executeTakeFirstOrThrow();
      const count = await tx
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('workspaceId', '=', actor.workspaceId)
        .where('userId', '=', actor.userId)
        .where('role', '=', 'user')
        .where('createdAt', '>', new Date(Date.now() - 86_400_000))
        .executeTakeFirst();
      return {
        conversationId: conv.id,
        userName: user.name,
        workspaceName: ws.name,
        plan: ws.plan,
        sentToday: Number(count?.n ?? 0),
      };
    },
  );
  if (sentToday >= (PLAN_DAILY_MESSAGES[plan] ?? 150))
    throw new AppError(429, 'Você atingiu o limite diário de mensagens do seu plano.', 'plan_limit');

  // 1) Grava a mensagem do usuário
  const attachments = attachmentIds.length
    ? await withUserContext(app.db, actor.userId, (tx) =>
        tx
          .selectFrom('attachments')
          .select(['id', 'filename', 'mime'])
          .where('id', 'in', attachmentIds)
          .execute(),
      )
    : [];
  await withUserContext(app.db, actor.userId, async (tx) => {
    await tx
      .insertInto('messages')
      .values({
        workspaceId: actor.workspaceId,
        conversationId,
        userId: actor.userId,
        role: 'user',
        content: text,
        parts: JSON.stringify(attachments.map((a) => ({ type: 'attachment', ...a }))),
      })
      .execute();
    await tx
      .updateTable('conversations')
      .set({ lastMessageAt: new Date() })
      .where('id', '=', conversationId)
      .execute();
  });

  // 2) Confirmação/cancelamento por texto sem passar pelo LLM
  if (!attachmentIds.length) {
    const quick = await quickReply(app, actor, conversationId, text, emit);
    if (quick) return quick;
  }

  // 3) Normaliza anexos: armazenados e extraídos para JSON antes do LLM
  const markers: string[] = [];
  for (const a of attachments) {
    emit({ type: 'tool', name: 'parse_attachment', status: 'start' });
    try {
      const doc = await processAttachment(app, actor, a.id, text || null);
      markers.push(
        `[anexo:${a.id} nome="${a.filename}" tipo=${doc.doc_type} itens=${doc.transactions.length || doc.trades.length}]`,
      );
    } catch (err) {
      markers.push(
        `[anexo:${a.id} nome="${a.filename}" erro="${err instanceof Error ? err.message : 'falha na leitura'}"]`,
      );
    } finally {
      emit({ type: 'tool', name: 'parse_attachment', status: 'end' });
    }
  }

  // 4) Contexto do workspace + histórico
  const ctxData = await withUserContext(app.db, actor.userId, async (tx) => {
    const today = await workspaceToday(tx, actor.workspaceId);
    const accounts = await tx
      .selectFrom('accounts')
      .select(['name', 'institution', 'type', 'currency'])
      .where('workspaceId', '=', actor.workspaceId)
      .where('archivedAt', 'is', null)
      .execute();
    const cards = await tx
      .selectFrom('cards')
      .select(['name', 'closingDay', 'dueDay'])
      .where('workspaceId', '=', actor.workspaceId)
      .where('archivedAt', 'is', null)
      .execute();
    const categories = await tx
      .selectFrom('categories')
      .select('name')
      .where('workspaceId', '=', actor.workspaceId)
      .orderBy('name')
      .execute();
    const pending = await tx
      .selectFrom('drafts')
      .select(['id', 'preview'])
      .where('conversationId', '=', conversationId)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', new Date())
      .execute();
    const history = await tx
      .selectFrom('messages')
      .select(['role', 'content', 'parts'])
      .where('conversationId', '=', conversationId)
      .where('role', 'in', ['user', 'assistant'])
      .orderBy('createdAt', 'desc')
      .limit(HISTORY + 1)
      .execute();
    return {
      today,
      accounts,
      cards,
      categories: categories.map((c) => c.name),
      pending,
      history: history.reverse().slice(0, -1),
    };
  });

  const weekday = WEEKDAYS[new Date(`${ctxData.today}T12:00:00Z`).getUTCDay()]!;
  const systemDynamic = dynamicContext({
    today: ctxData.today,
    weekday,
    userName,
    workspaceName,
    role: actor.role,
    channel: actor.channel,
    accounts: ctxData.accounts,
    cards: ctxData.cards,
    categories: ctxData.categories,
    pendingDrafts: ctxData.pending.map((p) => ({
      id: p.id,
      title: (p.preview as { title: string }).title,
      summary: (p.preview as { summary: string }).summary,
    })),
    pageContext: input.pageContext,
  });

  const messages: LLMMessage[] = [];
  for (const h of ctxData.history) {
    if (!h.content) continue;
    const role = h.role as 'user' | 'assistant';
    if (messages.length === 0 && role === 'assistant') continue;
    messages.push({ role, content: [{ type: 'text', text: h.content }] });
  }
  const userText = [text, ...markers].filter(Boolean).join('\n');
  messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });

  const tier = routeTier(text, attachmentIds.length > 0);
  const tools = toolDefs({ readOnly: actor.role === 'viewer' });
  const drafts: DraftDTO[] = [];
  let finalText = '';
  const messageId = crypto.randomUUID();
  emit({ type: 'message_start', messageId });

  // 5) Loop de tool calling
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const res = await app.llm.chat(
        { tier, system: SYSTEM_PROMPT, systemDynamic, messages, tools, purpose: 'chat', maxTokens: 8_000 },
        (delta) => emit({ type: 'text_delta', text: delta }),
      );
      await recordUsage(app, actor, res.provider, res.model, 'chat', res.usage, res.latencyMs);
      const calls = toolCallsOf(res.content);
      const turnText = textOf(res.content);
      if (res.stopReason === 'refusal') {
        finalText = 'Não consigo ajudar com esse pedido.';
        break;
      }
      if (!calls.length || res.stopReason !== 'tool_use') {
        finalText += turnText;
        break;
      }
      if (turnText) finalText += `${turnText}\n`;
      messages.push({ role: 'assistant', content: res.content });
      const results: LLMContent[] = [];
      for (const call of calls) {
        emit({ type: 'tool', name: call.name, status: 'start' });
        const out = await runTool(app, actor, conversationId, attachmentIds, call.name, call.input, (d) => {
          drafts.push(d);
          emit({ type: 'draft', draft: d });
        });
        emit({ type: 'tool', name: call.name, status: 'end' });
        results.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: JSON.stringify(out.result).slice(0, 60_000),
          isError: out.isError,
        });
      }
      messages.push({ role: 'user', content: results });
      if (i === MAX_ITERATIONS - 1) finalText += '\nPreciso de mais detalhes para concluir. Pode reformular?';
    }
  } catch (err) {
    app.log.error({ err }, 'falha no loop do agente');
    finalText =
      err instanceof LLMError && err.kind === 'rate_limit'
        ? 'Estou recebendo muitas mensagens agora. Tente de novo em instantes.'
        : err instanceof LLMError && (err.kind === 'auth' || err.kind === 'unavailable')
          ? 'O assistente está indisponível no momento. Você ainda pode usar as telas do app.'
          : 'Tive um problema para processar sua mensagem. Pode tentar de novo?';
    emit({ type: 'text_replace', text: finalText });
  }

  // 6) Filtro de saída (CVM 19)
  if (looksLikeRecommendation(finalText)) {
    app.log.warn({ workspaceId: actor.workspaceId }, 'resposta bloqueada pelo filtro de recomendação');
    finalText = SAFE_INVESTMENT_REPLY;
    emit({ type: 'text_replace', text: finalText });
  }
  if (!finalText.trim() && drafts.length) {
    finalText =
      drafts.length === 1
        ? 'Confira a prévia e confirme para gravar.'
        : `Preparei ${drafts.length} prévias. Confira e confirme.`;
    emit({ type: 'text_replace', text: finalText });
  }
  finalText = finalText.trim();

  await withUserContext(app.db, actor.userId, (tx) =>
    tx
      .insertInto('messages')
      .values({
        id: messageId,
        workspaceId: actor.workspaceId,
        conversationId,
        role: 'assistant',
        content: finalText,
        parts: JSON.stringify(drafts.map((d) => ({ type: 'draft', draftId: d.id }))),
      })
      .execute(),
  );
  emit({ type: 'message_end', messageId });
  return { conversationId, messageId, text: finalText, drafts };
}

/** Modelo pequeno para lançamentos simples; grande para anexos, análises e simulações. */
export function routeTier(text: string, hasAttachments: boolean): ModelTier {
  if (hasAttachments) return 'large';
  const f = fold(text);
  if (f.length > 280) return 'large';
  if (
    /\b(simul|e se|projec|carteira|investimento|dolar|insight|compar|por que|porque|analis|planej|meta|reserva|aloca|rebalance|fundo|cdi|ibov|desempenho|rentab|tendencia|evolucao|posso comprar|vale a pena|a vista|demitid|desligad|sem salario)\w*/.test(
      f,
    )
  )
    return 'large';
  return 'small';
}

async function runTool(
  app: AppContext,
  actor: Actor,
  conversationId: string,
  attachmentIds: string[],
  name: string,
  rawInput: unknown,
  onDraft: (d: DraftDTO) => void,
): Promise<{ result: unknown; isError: boolean }> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { result: { error: `Ferramenta desconhecida: ${name}` }, isError: true };
  if (tool.kind === 'draft' && actor.role === 'viewer')
    return { result: { error: 'O usuário só tem permissão de leitura neste workspace.' }, isError: true };
  // O input do modelo é validado antes de executar (pode vir truncado ou malformado)
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      result: {
        error: 'Parâmetros inválidos.',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      isError: true,
    };
  }
  const pendingDrafts: DraftDTO[] = [];
  const t0 = Date.now();
  const trace = (isError: boolean, extra: Record<string, unknown> = {}) =>
    app.log.info(
      {
        tool: name,
        ms: Date.now() - t0,
        isError,
        ws: actor.workspaceId,
        channel: actor.channel,
        drafts: pendingDrafts.length,
        ...extra,
      },
      'tool call',
    );
  try {
    const result = await withUserContext(app.db, actor.userId, async (tx) => {
      const ctx: ToolCtx = {
        tx,
        actor,
        app,
        conversationId,
        today: await workspaceToday(tx, actor.workspaceId).catch(() => todayISO()),
        attachmentIds,
        emitDraft: (d) => pendingDrafts.push(d),
      };
      return tool.run(ctx, parsed.data);
    });
    // drafts só são anunciados depois do commit da transação da ferramenta
    pendingDrafts.forEach(onDraft);
    trace(false);
    return { result, isError: false };
  } catch (err) {
    trace(true, { code: err instanceof AppError ? err.code : 'internal' });
    if (err instanceof AppError) {
      return {
        result: { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
        isError: true,
      };
    }
    app.log.error({ err, tool: name }, 'erro na ferramenta');
    return { result: { error: 'Erro interno ao executar a ferramenta.' }, isError: true };
  }
}

/** "sim" / "não" / "editar" respondendo a prévias pendentes. */
async function quickReply(
  app: AppContext,
  actor: Actor,
  conversationId: string,
  text: string,
  emit: (e: ChatStreamEvent) => void,
): Promise<ChatResult | null> {
  const f = fold(text);
  const isConfirm = CONFIRM.test(f);
  const isCancel = CANCEL.test(f);
  const isEdit = EDIT.test(f);
  if (!isConfirm && !isCancel && !isEdit) return null;

  const pending = await withUserContext(app.db, actor.userId, async (tx) => {
    const lastAssistant = await tx
      .selectFrom('messages')
      .select('createdAt')
      .where('conversationId', '=', conversationId)
      .where('role', '=', 'assistant')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const lastUserBefore = lastAssistant
      ? await tx
          .selectFrom('messages')
          .select('createdAt')
          .where('conversationId', '=', conversationId)
          .where('role', '=', 'user')
          .where('createdAt', '<', lastAssistant.createdAt)
          .orderBy('createdAt', 'desc')
          .executeTakeFirst()
      : null;
    let q = tx
      .selectFrom('drafts')
      .selectAll()
      .where('conversationId', '=', conversationId)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', new Date())
      .orderBy('createdAt');
    if (lastUserBefore) q = q.where('createdAt', '>', lastUserBefore.createdAt);
    return q.execute();
  });
  if (!pending.length) return null;

  const messageId = crypto.randomUUID();
  emit({ type: 'message_start', messageId });
  const parts: string[] = [];
  if (isEdit) {
    parts.push(
      'Claro. O que você quer mudar? Pode dizer, por exemplo, "o valor é 250" ou "foi no cartão Santander".',
    );
  } else {
    for (const d of pending) {
      try {
        if (isConfirm) {
          const r = await withUserContext(app.db, actor.userId, (tx) => confirmDraft(tx, actor, d.id));
          emit({ type: 'confirmed', draftId: d.id, summary: r.summary, impact: r.impact });
          parts.push([r.summary, r.impact].filter(Boolean).join(' '));
        } else {
          await withUserContext(app.db, actor.userId, (tx) => cancelDraft(tx, actor, d.id));
          parts.push('Cancelado, nada foi gravado.');
        }
      } catch (err) {
        parts.push(err instanceof AppError ? err.message : 'Não consegui concluir esta ação.');
        if (!(err instanceof AppError)) app.log.error({ err }, 'falha ao confirmar draft');
      }
    }
  }
  const reply = [...new Set(parts)].join('\n');
  emit({ type: 'text_delta', text: reply });
  await withUserContext(app.db, actor.userId, (tx) =>
    tx
      .insertInto('messages')
      .values({
        id: messageId,
        workspaceId: actor.workspaceId,
        conversationId,
        role: 'assistant',
        content: reply,
        parts: '[]',
      })
      .execute(),
  );
  emit({ type: 'message_end', messageId });
  const drafts = isEdit ? pending.map(toDraftDTO) : [];
  return { conversationId, messageId, text: reply, drafts };
}
