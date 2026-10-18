import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createDb } from '@sf/db';
import { providerFromEnv, transcriberFromEnv } from '@sf/llm';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import { EvolutionChannel } from './channels/evolution.js';
import { createMailer } from './lib/mailer.js';
import { WebPushSender } from './lib/push.js';
import { LocalFileStorage } from './storage/file-storage.js';

/**
 * Provedor de LLM e transcrição a partir da configuração efetiva (ambiente + overrides do banco).
 * Sem chave da Anthropic, cai no modo demonstração.
 */
export function buildAi(config: Config): Pick<AppContext, 'llm' | 'transcriber'> {
  const noKey = config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY;
  return {
    llm: providerFromEnv({
      LLM_PROVIDER: noKey ? 'fake' : config.LLM_PROVIDER,
      ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      LLM_MODEL_SMALL: config.LLM_MODEL_SMALL,
      LLM_MODEL_LARGE: config.LLM_MODEL_LARGE,
    }),
    transcriber: transcriberFromEnv({
      TRANSCRIBE_API_KEY: config.TRANSCRIBE_API_KEY,
      TRANSCRIBE_URL: config.TRANSCRIBE_URL,
      TRANSCRIBE_MODEL: config.TRANSCRIBE_MODEL,
    }),
  };
}

/** Monta as dependências compartilhadas (usado pela API e pelo worker). */
export function createAppContext(
  opts: { name: string; databaseUrl?: string; env?: NodeJS.ProcessEnv } = { name: 'api' },
) {
  const config: Config = loadConfig(opts.env);
  // caminho relativo de FILES_DIR vale a partir da raiz do repositório, não do diretório do app
  if (!path.isAbsolute(config.FILES_DIR))
    config.FILES_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)), config.FILES_DIR);
  const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { svc: opts.name },
    redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.apikey'],
    ...(config.NODE_ENV !== 'production'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
  const handle = createDb(opts.databaseUrl ?? config.DATABASE_URL, { applicationName: `sf-${opts.name}` });
  const whatsapp = config.EVOLUTION_API_KEY
    ? new EvolutionChannel({
        baseUrl: config.EVOLUTION_URL,
        apiKey: config.EVOLUTION_API_KEY,
        instance: config.EVOLUTION_INSTANCE,
      })
    : null;
  const app: AppContext = {
    config,
    db: handle.db,
    ...buildAi(config),
    storage: new LocalFileStorage(
      config.FILES_DIR,
      config.FILES_ENCRYPTION_KEY,
      config.FILES_URL_SECRET,
      config.PUBLIC_API_URL,
    ),
    mailer: createMailer(
      {
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        from: config.SMTP_FROM,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        secure: config.SMTP_SECURE,
      },
      log,
    ),
    whatsapp,
    push:
      config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
        ? new WebPushSender(handle.db, log, {
            publicKey: config.VAPID_PUBLIC_KEY,
            privateKey: config.VAPID_PRIVATE_KEY,
            subject: config.VAPID_SUBJECT,
          })
        : null,
    log,
  };
  return { app, handle };
}
