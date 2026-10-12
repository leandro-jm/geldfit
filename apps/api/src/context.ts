import type { Db } from '@sf/db';
import type { LLMProvider } from '@sf/llm';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { FileStorage } from './storage/file-storage.js';
import type { Mailer } from './lib/mailer.js';
import type { MessagingChannel } from './channels/types.js';

/** Dependências compartilhadas por rotas, agente e worker. */
export interface AppContext {
  config: Config;
  db: Db;
  llm: LLMProvider;
  storage: FileStorage;
  mailer: Mailer;
  whatsapp: MessagingChannel | null;
  log: Logger;
}

/** Contexto autenticado de uma operação (vindo da sessão web ou do número verificado no WhatsApp). */
export interface Actor {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'member' | 'viewer';
  channel: 'web' | 'whatsapp';
}
