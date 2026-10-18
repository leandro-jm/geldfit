import { z } from 'zod';
import {
  AI_SETTING_FIELDS,
  AI_SETTING_KEYS,
  type AiSettingField,
  type AiSettingKey,
  type AiSettingsDTO,
  type AiSettingsPatch,
  type AiTestResult,
} from '@sf/shared';
import { LLMError } from '@sf/llm';
import { buildAi } from '../bootstrap.js';
import { aiConfigSchema } from '../config.js';
import type { AppContext } from '../context.js';
import { decryptSecret, encryptSecret } from './secret-box.js';

/**
 * Chaves e modelos de IA editáveis pela tela (admin). O valor salvo em `app_settings` sobrepõe o do
 * ambiente; ao recarregar, `app.config`, `app.llm` e `app.transcriber` são reatribuídos no mesmo objeto,
 * então quem lê `app.llm` na hora da chamada já usa a configuração nova (sem reiniciar).
 */

const FIELDS = new Map(AI_SETTING_FIELDS.map((f) => [f.key, f]));

interface State {
  /** Valores do ambiente antes de qualquer override (para onde volta quando o admin remove). */
  baseline: Partial<Record<AiSettingKey, unknown>>;
  dbKeys: Set<AiSettingKey>;
  stamp: string | null;
  timer?: NodeJS.Timeout;
}
const states = new WeakMap<AppContext, State>();

function stateOf(app: AppContext): State {
  let s = states.get(app);
  if (!s) {
    const baseline: State['baseline'] = {};
    for (const k of AI_SETTING_KEYS) baseline[k] = app.config[k];
    s = { baseline, dbKeys: new Set(), stamp: null };
    states.set(app, s);
  }
  return s;
}

async function readStamp(app: AppContext): Promise<string> {
  const r = await app.db
    .selectFrom('appSettings')
    .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('updatedAt').as('at')])
    .executeTakeFirst();
  return `${r?.n ?? 0}|${r?.at ? new Date(r.at).toISOString() : ''}`;
}

/** Lê o banco e aplica os overrides sobre o ambiente. */
export async function loadAiSettings(app: AppContext): Promise<void> {
  const state = stateOf(app);
  const stamp = await readStamp(app);
  const rows = await app.db.selectFrom('appSettings').selectAll().execute();
  const overrides: Partial<Record<AiSettingKey, unknown>> = {};
  const dbKeys = new Set<AiSettingKey>();
  for (const row of rows) {
    const key = row.key as AiSettingKey;
    if (!FIELDS.has(key)) continue;
    let value = row.value;
    if (row.secret) {
      try {
        value = decryptSecret(row.value, app.config.FILES_ENCRYPTION_KEY);
      } catch {
        app.log.warn(
          { key },
          'não consegui decifrar configuração salva (FILES_ENCRYPTION_KEY mudou?); usando o .env',
        );
        continue;
      }
    }
    const parsed = aiConfigSchema.shape[key].safeParse(value);
    if (!parsed.success) {
      app.log.warn({ key }, 'configuração salva inválida; usando o .env');
      continue;
    }
    overrides[key] = parsed.data;
    dbKeys.add(key);
  }

  const first = state.stamp === null;
  const wasFake = app.llm.name === 'fake';
  Object.assign(app.config, state.baseline, overrides);
  Object.assign(app, buildAi(app.config));
  state.dbKeys = dbKeys;
  state.stamp = stamp;
  if (app.llm.name === 'fake' && (first || !wasFake))
    app.log.warn('LLM em modo demonstração (sem chave da Anthropic): respostas por regras.');
}

/** Recarrega quando outro processo (worker, outra réplica da API) altera a configuração. */
export function watchAiSettings(app: AppContext, intervalMs = 30_000): () => void {
  const state = stateOf(app);
  const timer = setInterval(() => {
    readStamp(app)
      .then((stamp) => (stamp !== state.stamp ? loadAiSettings(app) : undefined))
      .catch((err) => app.log.warn({ err }, 'falha ao verificar configurações de IA'));
  }, intervalMs);
  timer.unref();
  state.timer = timer;
  return () => clearInterval(timer);
}

function sourceOf(app: AppContext, key: AiSettingKey): AiSettingsDTO['fields'][number]['source'] {
  if (stateOf(app).dbKeys.has(key)) return 'db';
  return stateOf(app).baseline[key] !== undefined && process.env[key] ? 'env' : 'default';
}

/** Estado efetivo para a tela. Segredos nunca saem em claro: só se estão definidos e o final. */
export function describeAiSettings(app: AppContext): AiSettingsDTO {
  return {
    fields: AI_SETTING_FIELDS.map((f) => {
      const raw = app.config[f.key];
      const value = raw === undefined || raw === null || raw === '' ? null : String(raw);
      const source = sourceOf(app, f.key);
      if (f.secret)
        return { key: f.key, value: null, isSet: value !== null, last4: value?.slice(-4), source };
      return { key: f.key, value, isSet: value !== null, source };
    }),
  };
}

function valueSchema(f: AiSettingField) {
  if (f.kind === 'select') return z.enum(f.options as [string, ...string[]]);
  if (f.kind === 'url')
    return z
      .string()
      .trim()
      .max(500)
      .url('URL inválida.')
      .refine((u) => /^https?:\/\//i.test(u), 'Use uma URL http(s).');
  return z.string().trim().min(1).max(500).regex(/^\S+$/, 'Não pode ter espaços.');
}

/** Patch parcial: `null` ou texto vazio remove o valor salvo (volta para o .env/padrão). */
export const AI_SETTINGS_PATCH_SCHEMA = z
  .object(
    Object.fromEntries(
      AI_SETTING_FIELDS.map((f) => [
        f.key,
        z
          .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), valueSchema(f).nullable())
          .optional(),
      ]),
    ),
  )
  .strict();

export async function saveAiSettings(app: AppContext, userId: string, patch: AiSettingsPatch): Promise<void> {
  const keys = Object.keys(patch) as AiSettingKey[];
  if (!keys.length) return;
  await app.db.transaction().execute(async (tx) => {
    for (const key of keys) {
      const v = patch[key];
      if (v === null || v === undefined) {
        await tx.deleteFrom('appSettings').where('key', '=', key).execute();
        continue;
      }
      const secret = FIELDS.get(key)?.secret === true;
      const value = secret ? encryptSecret(v, app.config.FILES_ENCRYPTION_KEY) : v;
      await tx
        .insertInto('appSettings')
        .values({ key, value, secret, updatedBy: userId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value, secret, updatedBy: userId }))
        .execute();
    }
  });
  // só os nomes: valores (chaves de API) nunca vão para o log
  app.log.info({ keys, by: userId }, 'configurações de IA alteradas');
  await loadAiSettings(app);
}

const TEST_ERRORS: Partial<Record<LLMError['kind'], string>> = {
  auth: 'A chave foi recusada pelo provedor. Confira se copiou inteira e se não foi revogada.',
  rate_limit: 'O provedor limitou as requisições (ou acabou o crédito). Tente de novo em instantes.',
  unavailable: 'O provedor não respondeu agora. Tente de novo em instantes.',
  bad_request: 'O provedor recusou a requisição. Confira os nomes dos modelos.',
};

/** Chamada mínima aos dois modelos para validar chave e nomes. Não entra no uso de nenhum workspace. */
export async function testLlm(app: AppContext): Promise<AiTestResult> {
  if (app.llm.name === 'fake')
    return {
      ok: false,
      provider: 'fake',
      error: 'Nenhuma chave da Anthropic configurada: o assistente está em modo demonstração.',
    };
  const models: string[] = [];
  try {
    for (const tier of ['small', 'large'] as const) {
      const r = await app.llm.chat({
        tier,
        system: 'Responda apenas "ok".',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 16,
        effort: 'low',
        purpose: 'admin_test',
        signal: AbortSignal.timeout(30_000),
      });
      models.push(r.model);
    }
    return { ok: true, provider: app.llm.name, models };
  } catch (err) {
    app.log.warn({ err }, 'teste de conexão com o LLM falhou');
    const msg =
      (err instanceof LLMError && TEST_ERRORS[err.kind]) ||
      (err instanceof Error ? err.message : 'Falha desconhecida.');
    return { ok: false, provider: app.llm.name, models, error: msg };
  }
}
