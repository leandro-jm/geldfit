import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '@sf/llm';
import { handleMessage } from '@sf/api/agent/orchestrator';
import type { Actor, AppContext } from '@sf/api/context';
import { hasDb, makeApp, newActor, setupEnv } from '../../api/test/helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';
import type { WorkerContext } from '../src/context.js';
import { memoryExtraction } from '../src/jobs/memory.js';

describe.skipIf(!hasDb)('Worker: extração de memória das conversas', () => {
  let env: TestEnv;
  let app: AppContext;
  let ctx: WorkerContext;
  let actor: Actor;
  let calls = 0;

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(
      env,
      new FakeProvider(() => {
        calls++;
        return {
          ops: [
            {
              op: 'create',
              key: null,
              category: 'objetivo',
              content: 'Quer comprar um apartamento em 2030',
              sensitive: false,
              scope: 'personal',
              confidence: 0.95,
              importance: 5,
              expires_at: null,
              evidence_quote: 'quero comprar um apartamento em 2030',
            },
          ],
        };
      }),
    );
    ctx = { app, sys: env.owner.db, close: async () => {} };
    actor = await newActor(env);
  });
  afterAll(async () => env?.cleanup());

  it('espera a conversa assentar, extrai uma vez e não reprocessa', async () => {
    await handleMessage(app, actor, { text: 'Eu quero comprar um apartamento em 2030' });
    // conversa ainda "quente": nada acontece com o tempo de espera padrão
    await memoryExtraction(ctx);
    expect(calls).toBe(0);

    await memoryExtraction(ctx, { idleMinutes: 0 });
    expect(calls).toBe(1);
    const mem = await env.as(actor.userId, (tx) =>
      tx
        .selectFrom('agentMemories')
        .select(['content', 'status'])
        .where('userId', '=', actor.userId)
        .execute(),
    );
    expect(mem).toEqual([{ content: 'Quer comprar um apartamento em 2030', status: 'active' }]);

    await memoryExtraction(ctx, { idleMinutes: 0 });
    expect(calls).toBe(1);
  });

  it('AGENT_PROACTIVE diferente de full desliga a extração', async () => {
    await handleMessage(app, actor, { text: 'Meu sonho é morar na praia quando me aposentar' });
    app.config.AGENT_PROACTIVE = 'deterministic';
    const r = await memoryExtraction(ctx, { idleMinutes: 0 });
    app.config.AGENT_PROACTIVE = 'full';
    expect(r.processed).toBe(0);
    expect(calls).toBe(1);
  });
});
