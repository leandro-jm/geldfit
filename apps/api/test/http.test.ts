import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import { hasDb, makeApp, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

describe.skipIf(!hasDb)('HTTP', () => {
  let env: TestEnv;
  let app: AppContext;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';

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
    const body = me.json() as { user: { id: string }; workspaces: Array<{ id: string; role: string }> };
    env.users.push(body.user.id);
    env.workspaces.push(...body.workspaces.map((w) => w.id));
    return { cookie, userId: body.user.id, ws: body.workspaces[0]!.id };
  }

  beforeAll(async () => {
    env = setupEnv();
    app = {
      ...makeApp(env),
      config: { ...makeApp(env).config, EVOLUTION_WEBHOOK_SECRET: 'segredo-do-webhook-123' },
    };
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  it('cadastro cria workspace pessoal e exige login nas rotas', async () => {
    const a = await signUp('Alice');
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
    expect(me.json()).toMatchObject({ workspaces: [{ name: 'Pessoal', role: 'owner' }], consented: false });
    const anon = await server.inject({ method: 'GET', url: '/api/accounts' });
    expect(anon.statusCode).toBe(401);
  });

  it('não acessa workspace de outro usuário pelo cabeçalho', async () => {
    const a = await signUp('Ana');
    const b = await signUp('Bruno');
    const res = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie: b.cookie, 'x-workspace-id': a.ws },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ações por formulário passam pelo draft (auditoria) e leitor é bloqueado', async () => {
    const a = await signUp('Carla');
    const ok = await server.inject({
      method: 'POST',
      url: '/api/actions',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: {
        kind: 'account',
        payload: {
          mode: 'create',
          fields: {
            institution: 'Cresol',
            name: 'Cresol',
            type: 'checking',
            openingBalanceCents: 100_000,
            openingDate: '2026-10-01',
            isPrivate: false,
          },
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ summary: 'Conta salva.' });

    const v = await signUp('Vitor');
    await env.owner.db
      .insertInto('memberships')
      .values({ workspaceId: a.ws, userId: v.userId, role: 'viewer' })
      .execute();
    const denied = await server.inject({
      method: 'POST',
      url: '/api/actions',
      headers: { cookie: v.cookie, 'x-workspace-id': a.ws, 'content-type': 'application/json' },
      payload: {
        kind: 'budget',
        payload: { categoryId: '00000000-0000-0000-0000-000000000000', amountCents: 100 },
      },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('webhook exige o segredo e download exige assinatura', async () => {
    const bad = await server.inject({ method: 'POST', url: '/webhooks/evolution/errado', payload: {} });
    expect(bad.statusCode).toBe(401);
    const good = await server.inject({
      method: 'POST',
      url: '/webhooks/evolution/segredo-do-webhook-123',
      payload: { event: 'connection.update' },
    });
    expect(good.statusCode).toBeLessThan(300);
    const file = await server.inject({
      method: 'GET',
      url: '/api/files/00000000-0000-0000-0000-000000000000?exp=9999999999&sig=abc',
    });
    expect(file.statusCode).toBe(403);
  });

  it('consentimento LGPD e exportação', async () => {
    const a = await signUp('Dora');
    const c = await server.inject({
      method: 'POST',
      url: '/api/me/consent',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: { terms: true, privacy: true, llm: true },
    });
    expect(c.statusCode).toBe(200);
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
    expect(me.json().consented).toBe(true);
    const exp = await server.inject({ method: 'GET', url: '/api/export', headers: { cookie: a.cookie } });
    expect(exp.statusCode).toBe(200);
    expect(JSON.parse(exp.body)).toHaveProperty('transactions');
  });
});
