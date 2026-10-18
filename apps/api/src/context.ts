import type { Db } from '@sf/db';
import type { LLMProvider, Transcriber } from '@sf/llm';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { FileStorage } from './storage/file-storage.js';
import type { Mailer } from './lib/mailer.js';
import type { MessagingChannel } from './channels/types.js';
import type { PushSender } from './lib/push.js';

/** Dependências compartilhadas por rotas, agente e worker. */
export interface AppContext {
  config: Config;
  db: Db;
  llm: LLMProvider;
  /** Transcrição de áudio (null quando não configurada). */
  transcriber: Transcriber | null;
  storage: FileStorage;
  mailer: Mailer;
  whatsapp: MessagingChannel | null;
  /** Web Push (null sem chaves VAPID). */
  push: PushSender | null;
  log: Logger;
}

/** Contexto autenticado de uma operação (sessão web, número verificado no WhatsApp ou token MCP). */
export interface Actor {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'member' | 'viewer';
  channel: 'web' | 'whatsapp' | 'mcp';
}
