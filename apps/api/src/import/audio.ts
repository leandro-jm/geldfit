import { maskSensitive } from '@sf/shared';
import { LLMError } from '@sf/llm';
import { withUserContext } from '@sf/db';
import type { Actor, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { recordUsage } from '../lib/usage.js';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** Áudios transcritos por dia, por plano (cada um ainda conta como mensagem ao ser enviado). */
export const PLAN_DAILY_AUDIOS: Record<string, number> = { free: 30, pro: 300 };

const EXT: Array<[RegExp, string]> = [
  [/ogg|opus/, 'ogg'],
  [/webm/, 'webm'],
  [/mp4|m4a|aac/, 'm4a'],
  [/mpeg|mp3/, 'mp3'],
  [/wav/, 'wav'],
];

// Ajuda o modelo com nomes próprios e termos que aparecem nos lançamentos
const VOCABULARY =
  'Lançamentos financeiros em reais: Pix, boleto, fatura, cartão, parcelado, débito, salário. Bancos: Banco do Brasil, BB, Caixa, Itaú, Bradesco, Santander, Nubank, Inter, Cresol, Sicoob, Sicredi, C6, Nomad, Wise.';

export function audioAvailable(app: AppContext): boolean {
  return app.transcriber !== null;
}

/**
 * Transcreve um áudio do usuário para o texto que segue o fluxo normal do agente.
 * O texto é mascarado (CPF, cartão) antes de ir para o banco ou para o LLM.
 */
export async function transcribeAudio(
  app: AppContext,
  actor: Actor,
  file: { data: Buffer; mime: string },
): Promise<string> {
  if (!app.transcriber)
    throw new AppError(503, 'Ainda não entendo áudio. Pode mandar por texto?', 'audio_off');
  const mime = file.mime.split(';')[0]!.trim().toLowerCase();
  if (!mime.startsWith('audio/') && mime !== 'video/webm')
    throw new AppError(415, 'Formato de áudio não suportado.', 'unsupported_media');
  if (file.data.length === 0) throw new AppError(400, 'Áudio vazio.');
  if (file.data.length > MAX_AUDIO_BYTES)
    throw new AppError(413, 'Áudio longo demais. Mande mensagens de até uns 5 minutos.', 'too_large');

  const { plan, used } = await withUserContext(app.db, actor.userId, async (tx) => {
    const ws = await tx
      .selectFrom('workspaces')
      .select('plan')
      .where('id', '=', actor.workspaceId)
      .executeTakeFirstOrThrow();
    const n = await tx
      .selectFrom('llmUsage')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', actor.workspaceId)
      .where('userId', '=', actor.userId)
      .where('purpose', '=', 'transcribe')
      .where('at', '>', new Date(Date.now() - 86_400_000))
      .executeTakeFirst();
    return { plan: ws.plan, used: Number(n?.n ?? 0) };
  });
  if (used >= (PLAN_DAILY_AUDIOS[plan] ?? PLAN_DAILY_AUDIOS.free!))
    throw new AppError(
      429,
      'Você atingiu o limite diário de áudios do seu plano. Pode mandar por texto?',
      'plan_limit',
    );

  const ext = EXT.find(([re]) => re.test(mime))?.[1] ?? 'ogg';
  let res;
  try {
    res = await app.transcriber.transcribe({
      data: file.data,
      mime,
      filename: `audio.${ext}`,
      language: 'pt',
      prompt: VOCABULARY,
    });
  } catch (err) {
    app.log.warn({ err }, 'falha na transcrição');
    throw new AppError(
      err instanceof LLMError && err.kind === 'rate_limit' ? 429 : 502,
      'Não consegui ouvir o áudio agora. Pode tentar de novo ou mandar por texto?',
      'transcribe_failed',
    );
  }
  await recordUsage(
    app,
    actor,
    res.provider,
    res.model,
    'transcribe',
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: Math.round((res.seconds / 60) * app.config.TRANSCRIBE_USD_PER_MIN * 1e6),
    },
    res.latencyMs,
  );
  const text = maskSensitive(res.text).trim();
  if (!text)
    throw new AppError(422, 'Não consegui entender o áudio. Pode repetir ou escrever?', 'empty_audio');
  return text;
}
