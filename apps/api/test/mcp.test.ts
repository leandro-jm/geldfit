import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '@sf/db';
import { buildServer } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import { MCP_TOOLS } from '../src/mcp/server.js';
import { hasDb, makeApp, setupEnv } from './helpers.js';
import { insertAccount, type TestEnv } from '../../../db/tests/helpers.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_NAME = 'Teste MCP';

describe.skipIf(!hasDb)('MCP e OAuth', () => {
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
    const body = me.json() as { user: { id: string }; workspaces: Array<{ id: string }> };
    env.users.push(body.user.id);
    env.workspaces.push(...body.workspaces.map((w) => w.id));
    return { cookie, userId: body.user.id, ws: body.workspaces[0]!.id };
  }

  async function register() {
    const res = await server.inject({
      method: 'POST',
      url: '/api/oauth/register',
      payload: { client_name: CLIENT_NAME, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { client_id: string }).client_id;
  }

  /** Fluxo completo: registro → consentimento → troca do código (formulário) → tokens. */
  async function connect(user: { cookie: string; ws: string }) {
    const clientId = await register();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await server.inject({
      method: 'POST',
      url: '/api/oauth/authorize',
      headers: { cookie: user.cookie },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        workspace_id: user.ws,
        decision: 'allow',
      },
    });
    expect(auth.statusCode).toBe(200);
    const redirect = new URL((auth.json() as { redirect: string }).redirect);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    const code = redirect.searchParams.get('code')!;
    const token = await server.inject({
      method: 'POST',
      url: '/api/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const t = token.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(t.token_type).toBe('Bearer');
    return { clientId, code, verifier, ...t };
  }

  const rpc = (accessToken: string | null, body: unknown) =>
    server.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: body as object,
    });

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    if (env) await sql`delete from mcp_clients where client_name = ${CLIENT_NAME}`.execute(env.owner.db);
    await env?.cleanup();
  });

  it('publica os metadados de descoberta', async () => {
    const as = (
      await server.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    ).json();
    expect(as).toMatchObject({
      issuer: 'http://localhost:5173',
      authorization_endpoint: 'http://localhost:5173/oauth/autorizar',
      code_challenge_methods_supported: ['S256'],
    });
    const pr = (
      await server.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/mcp' })
    ).json();
    expect(pr).toMatchObject({
      resource: 'http://localhost:5173/api/mcp',
      authorization_servers: ['http://localhost:5173'],
    });
  });

  it('sem token responde 401 apontando para os metadados', async () => {
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource"',
    );
    expect((await rpc('sfa_invalido', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
  });

  it('recusa redirect inseguro e cliente desconhecido', async () => {
    const bad = await server.inject({
      method: 'POST',
      url: '/api/oauth/register',
      payload: { client_name: CLIENT_NAME, redirect_uris: ['http://evil.example/cb'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_redirect_uri' });

    const a = await signUp('Ana');
    const clientId = await register();
    const res = await server.inject({
      method: 'GET',
      url: `/api/oauth/client?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://outro.example/cb')}`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('conecta, lista só ferramentas de leitura e executa no espaço autorizado', async () => {
    const a = await signUp('Bruno');
    await env.as(a.userId, (tx) =>
      insertAccount(tx, a.ws, { name: 'Conta MCP', openingBalanceCents: 123_45, openingDate: '2026-01-01' }),
    );
    const { access_token } = await connect(a);

    const init = await rpc(access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'teste', version: '1' },
      },
    });
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({ result: { serverInfo: { name: 'saude-financeira' } } });

    const list = await rpc(access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toContain('get_projection');
    expect(names).toContain('list_accounts');
    expect(names.some((n) => n.startsWith('draft_'))).toBe(false);
    expect(names).not.toContain('remember');
    expect(names).toHaveLength(MCP_TOOLS.length);

    const call = await rpc(access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    });
    const result = (call.json() as { result: { content: Array<{ text: string }>; isError?: boolean } })
      .result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Conta MCP');

    const denied = await rpc(access_token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'draft_transactions', arguments: {} },
    });
    expect((denied.json() as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it('código é de uso único e exige o code_verifier certo', async () => {
    const a = await signUp('Carla');
    const first = await connect(a);
    const again = await server.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        code: first.code,
        client_id: first.clientId,
        redirect_uri: REDIRECT,
        code_verifier: first.verifier,
      },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refresh gira o token e revogar corta o acesso', async () => {
    const a = await signUp('Davi');
    const t = await connect(a);
    const refreshed = await server.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId },
    });
    expect(refreshed.statusCode).toBe(200);
    const t2 = refreshed.json() as { access_token: string };
    // o access e o refresh antigos deixam de valer
    expect((await rpc(t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
    const reuse = await server.inject({
      method: 'POST',
      url: '/api/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId },
    });
    expect(reuse.statusCode).toBe(400);
    expect((await rpc(t2.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(
      200,
    );

    const grants = await server.inject({
      method: 'GET',
      url: '/api/mcp/grants',
      headers: { cookie: a.cookie },
    });
    const list = grants.json() as Array<{ id: string; clientName: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.clientName).toBe(CLIENT_NAME);

    // outro usuário não vê nem revoga a conexão
    const b = await signUp('Eva');
    const other = await server.inject({
      method: 'DELETE',
      url: `/api/mcp/grants/${list[0]!.id}`,
      headers: { cookie: b.cookie },
    });
    expect(other.statusCode).toBe(404);

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/mcp/grants/${list[0]!.id}`,
      headers: { cookie: a.cookie },
    });
    expect(del.statusCode).toBe(200);
    expect((await rpc(t2.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(
      401,
    );
  });

  it('negar o consentimento devolve access_denied ao cliente', async () => {
    const a = await signUp('Fabio');
    const clientId = await register();
    const res = await server.inject({
      method: 'POST',
      url: '/api/oauth/authorize',
      headers: { cookie: a.cookie },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        state: 's1',
        workspace_id: a.ws,
        decision: 'deny',
      },
    });
    const url = new URL((res.json() as { redirect: string }).redirect);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
  });
});
