import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Me } from '@sf/shared';
import { buildServer } from '../src/server.js';
import { hasDb, makeApp, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

describe.skipIf(!hasDb)('Minha conta: nome, e-mail e senha', () => {
  let env: TestEnv;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';
  const json = { origin, 'content-type': 'application/json' };

  beforeAll(async () => {
    env = setupEnv();
    ({ server } = await buildServer(makeApp(env), env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    ([] as string[])
      .concat((res.headers['set-cookie'] as string[] | string | undefined) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');

  it('atualiza o nome, troca o e-mail não verificado e a senha', async () => {
    const email = `conta-${Date.now()}@example.test`;
    const up = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: json,
      payload: { name: 'Demo', email, password: 'senha-forte-123' },
    });
    expect(up.statusCode).toBe(200);
    let cookie = cookieOf(up);
    const me = async () =>
      (await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json<Me>();
    const first = await me();
    env.users.push(first.user.id);
    env.workspaces.push(...first.workspaces.map((w) => w.id));
    expect(first.user.emailVerified).toBe(false);

    const name = await server.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: { ...json, cookie },
      payload: { name: 'Leandro Martins' },
    });
    expect(name.statusCode).toBe(200);
    expect((await me()).user.name).toBe('Leandro Martins');

    const newEmail = `novo-${Date.now()}@example.test`;
    const ch = await server.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers: { ...json, cookie },
      payload: { newEmail, callbackURL: `${origin}/configuracoes` },
    });
    expect(ch.statusCode, ch.body).toBe(200);
    cookie = cookieOf(ch) || cookie;
    expect((await me()).user.email).toBe(newEmail);

    const wrong = await server.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { ...json, cookie },
      payload: { currentPassword: 'errada-123', newPassword: 'outra-senha-456' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('INVALID_PASSWORD');

    const ok = await server.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { ...json, cookie },
      payload: { currentPassword: 'senha-forte-123', newPassword: 'outra-senha-456' },
    });
    expect(ok.statusCode).toBe(200);
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email: newEmail, password: 'outra-senha-456' },
    });
    expect(login.statusCode).toBe(200);
  });
});
