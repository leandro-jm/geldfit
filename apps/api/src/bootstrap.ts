import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createDb } from '@sf/db';
import { providerFromEnv, transcriberFromEnv } from '@sf/llm';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import { EvolutionChannel } from './channels/evolution.js';
import { createMailer } from './lib/mailer.js';
import { LocalFileStorage } from './storage/file-storage.js';

/** Monta as dependências compartilhadas (usado pela API e pelo worker). */
export function createAppContext(
  opts: { name: string; databaseUrl?: string; env?: NodeJS.ProcessEnv } = { name: 'api' },
) {
  const config: Config = loadConfig(opts.env);
  // caminho relativo de FILES_DIR vale a partir da raiz do repositório, não do diretório do app
  if (!path.isAbsolute(config.FILES_DIR)) config.FILES_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)), config.FILES_DIR);
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
    llm: providerFromEnv(
      config.LLM_PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY
        ? { ...process.env, LLM_PROVIDER: 'fake' }
        : process.env,
    ),
    transcriber: transcriberFromEnv(process.env),
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
    log,
  };
  if (app.llm.name === 'fake')
    log.warn('LLM em modo demonstração (sem ANTHROPIC_API_KEY): respostas por regras.');
  return { app, handle };
}
