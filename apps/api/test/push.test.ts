import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import { pushText, WebPushSender } from '../src/lib/push.js';
import { hasDb, makeApp, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

describe('pushText', () => {
  it('tira a marcação do WhatsApp e corta', () => {
    expect(pushText('*Fatura* de _maio_\n  fechou')).toBe('Fatura de maio fechou');
    expect(pushText('a'.repeat(300))).toHaveLength(200);
  });
});

describe.skipIf(!hasDb)('Web Push', () => {
  let env: TestEnv;
  let app: AppContext;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';
  const delivered: Array<{ endpoint: string; payload: string }> = [];
  const revoked = new Set<string>();

  async function signUp(name: string) {
    const email = `${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin, 'content-type': 'application/json' },
      payload: { name, email, password: 'senha-forte-123' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    const body = me.json() as { user: { id: string }; workspaces: Array<{ id: string }> };
    env.users.push(body.user.id);
    env.workspaces.push(...body.workspaces.map((w) => w.id));
    return { cookie, userId: body.user.id };
  }

  const subscribe = (cookie: string, endpoint: string) =>
    server.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { cookie, origin },
      payload: { endpoint, keys: { p256dh: 'BPk3y', auth: 'au7h' }, device: 'teste' },
    });

  beforeAll(async () => {
    env = setupEnv();
    const base = makeApp(env);
    app = {
      ...base,
      push: new WebPushSender(env.app.db, base.log, {
        publicKey: 'chave-publica',
        privateKey: 'chave-privada',
        subject: 'mailto:teste@example.test',
        transport: async (sub, payload) => {
          if (revoked.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
          delivered.push({ endpoint: sub.endpoint, payload });
        },
      }),
    };
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  it('chave pública e inscrição exigem login', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/push/key' })).statusCode).toBe(401);
    expect((await subscribe('', 'https://push.example.test/x')).statusCode).toBe(401);
    const a = await signUp('Ana');
    const key = await server.inject({ method: 'GET', url: '/api/push/key', headers: { cookie: a.cookie } });
    expect(key.json()).toEqual({ publicKey: 'chave-publica' });
    expect((await subscribe(a.cookie, 'http://inseguro.example.test/x')).statusCode).toBe(400);
  });

  it('envia para todos os aparelhos e apaga a inscrição revogada (410)', async () => {
    const a = await signUp('Bia');
    const phone = `https://push.example.test/bia-cel-${Date.now()}`;
    const laptop = `https://push.example.test/bia-note-${Date.now()}`;
    expect((await subscribe(a.cookie, phone)).statusCode).toBe(200);
    expect((await subscribe(a.cookie, laptop)).statusCode).toBe(200);
    revoked.add(laptop);

    const n = await app.push!.sendToUser(a.userId, {
      title: 'Fatura fechada',
      body: 'R$ 10,00',
      url: '/contas',
    });
    expect(n).toBe(1);
    expect(JSON.parse(delivered.at(-1)!.payload)).toMatchObject({ title: 'Fatura fechada', url: '/contas' });
    const rows = await env.owner.db
      .selectFrom('pushSubscriptions')
      .select(['endpoint', 'lastUsedAt'])
      .where('userId', '=', a.userId)
      .execute();
    expect(rows.map((r) => r.endpoint)).toEqual([phone]);
    expect(rows[0]!.lastUsedAt).not.toBeNull();
  });

  it('o mesmo navegador passa para quem ativou por último; DELETE remove', async () => {
    const a = await signUp('Caio');
    const b = await signUp('Duda');
    const endpoint = `https://push.example.test/compartilhado-${Date.now()}`;
    await subscribe(a.cookie, endpoint);
    expect((await subscribe(b.cookie, endpoint)).statusCode).toBe(200);
    expect(await app.push!.sendToUser(a.userId, { title: 'x' })).toBe(0);
    expect(await app.push!.sendToUser(b.userId, { title: 'x' })).toBe(1);

    // apagar o endpoint alheio não tem efeito (RLS)
    await server.inject({
      method: 'DELETE',
      url: '/api/push/subscriptions',
      headers: { cookie: a.cookie, origin },
      payload: { endpoint },
    });
    expect(await app.push!.sendToUser(b.userId, { title: 'x' })).toBe(1);
    await server.inject({
      method: 'DELETE',
      url: '/api/push/subscriptions',
      headers: { cookie: b.cookie, origin },
      payload: { endpoint },
    });
    expect(await app.push!.sendToUser(b.userId, { title: 'x' })).toBe(0);
  });
});
