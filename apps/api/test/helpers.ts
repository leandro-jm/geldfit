import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { FakeProvider, type LLMProvider } from '@sf/llm';
import type { Actor, AppContext } from '../src/context.js';
import { LocalFileStorage } from '../src/storage/file-storage.js';
import { loadConfig } from '../src/config.js';
import { setupEnv, type TestEnv } from '../../../db/tests/helpers.js';

export { hasDb } from '../../../db/tests/helpers.js';

export function makeApp(env: TestEnv, llm: LLMProvider = new FakeProvider()): AppContext {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-files-'));
  const config = loadConfig({ ...process.env, LLM_PROVIDER: 'fake', FILES_DIR: dir });
  return {
    config,
    db: env.app.db,
    llm,
    transcriber: null,
    storage: new LocalFileStorage(
      dir,
      randomBytes(32).toString('base64'),
      'segredo-de-teste-123',
      'http://localhost:4000',
    ),
    mailer: { send: async () => {} },
    whatsapp: null,
    log: pino({ level: process.env.TEST_LOG ?? 'silent' }),
  };
}

export async function newActor(env: TestEnv, role: Actor['role'] = 'owner'): Promise<Actor> {
  const userId = await env.createUser('Leandro');
  const workspaceId = await env.createWorkspace(userId, 'Casa');
  return { userId, workspaceId, role, channel: 'web' };
}

export { setupEnv };
