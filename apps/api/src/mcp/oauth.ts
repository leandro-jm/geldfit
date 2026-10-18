import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { sql, withUserContext } from '@sf/db';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';

/**
 * Servidor de autorização OAuth 2.1 mínimo para conectar assistentes externos via MCP.
 * - Clientes públicos com registro dinâmico (RFC 7591) e PKCE S256 obrigatório.
 * - A tela de consentimento é da web (/oauth/autorizar); ela chama /api/oauth/authorize com a sessão.
 * - Tokens opacos: só o hash SHA-256 vai para o banco. Refresh gira a cada uso.
 */

export const MCP_SCOPE = 'read';
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 90 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

export function mcpUrls(app: AppContext) {
  const issuer = app.config.PUBLIC_WEB_URL.replace(/\/$/, '');
  return {
    issuer,
    resource: `${issuer}/api/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource`,
    authorize: `${issuer}/oauth/autorizar`,
    token: `${issuer}/api/oauth/token`,
    register: `${issuer}/api/oauth/register`,
    revoke: `${issuer}/api/oauth/revoke`,
  };
}

/** https em qualquer host; http só em localhost (clientes locais, como o Claude Desktop). */
function validRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

const registerBody = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const authorizeBody = z.object({
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2000),
  code_challenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1000).optional(),
  scope: z.string().max(200).optional(),
  workspace_id: z.uuid(),
  decision: z.enum(['allow', 'deny']),
});

/** Erro no formato do RFC 6749 (o cliente OAuth lê `error`, não a mensagem). */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .send({ error, error_description: description });
}

async function findClient(app: AppContext, clientId: string, redirectUri?: string) {
  const client = await app.db
    .selectFrom('mcpClients')
    .select(['id', 'clientName', 'redirectUris'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client) return null;
  if (redirectUri !== undefined && !client.redirectUris.includes(redirectUri)) return null;
  return client;
}

/** Formulário (padrão OAuth) ou JSON. */
function formBody(req: FastifyRequest): Record<string, string> {
  const b = req.body;
  if (!b || typeof b !== 'object') return {};
  return Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'string')) as Record<
    string,
    string
  >;
}

export async function oauthRoutes(f: FastifyInstance, app: AppContext, guards: { user: any }) {
  const urls = mcpUrls(app);

  // --- Descoberta -------------------------------------------------------------------------
  const resourceMeta = async () => ({
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Saúde Financeira',
  });
  f.get('/.well-known/oauth-protected-resource', resourceMeta);
  f.get('/.well-known/oauth-protected-resource/api/mcp', resourceMeta);
  f.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
  }));

  // Formulários x-www-form-urlencoded só nas rotas de token (encapsulado neste plugin)
  await f.register(async (o) => {
    o.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // --- Registro dinâmico de cliente -----------------------------------------------------
    o.post(
      '/api/oauth/register',
      { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
      async (req, reply) => {
        const parsed = registerBody.safeParse(req.body);
        if (!parsed.success)
          return oauthError(reply, 400, 'invalid_client_metadata', 'Metadados do cliente inválidos.');
        const b = parsed.data;
        if (!b.redirect_uris.every(validRedirect))
          return oauthError(reply, 400, 'invalid_redirect_uri', 'Use https (ou http apenas em localhost).');
        if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none')
          return oauthError(
            reply,
            400,
            'invalid_client_metadata',
            'Só clientes públicos (PKCE) são aceitos.',
          );
        const id = newToken('mcpc');
        const clientName = b.client_name ?? 'Assistente MCP';
        await app.db
          .insertInto('mcpClients')
          .values({ id, clientName, redirectUris: b.redirect_uris })
          .execute();
        return reply
          .code(201)
          .header('cache-control', 'no-store')
          .send({
            client_id: id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_name: clientName,
            redirect_uris: b.redirect_uris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          });
      },
    );

    // --- Token: troca do código e refresh -------------------------------------------------
    o.post(
      '/api/oauth/token',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const b = formBody(req);
        if (b.grant_type === 'authorization_code') {
          if (!b.code || !b.client_id || !b.redirect_uri || !b.code_verifier)
            return oauthError(reply, 400, 'invalid_request', 'Faltam parâmetros.');
          const { rows } = await sql<{
            clientId: string;
            userId: string;
            workspaceId: string;
            redirectUri: string;
            codeChallenge: string;
            scope: string;
            expiresAt: Date;
          }>`select * from mcp_consume_code(${hashToken(b.code)})`.execute(app.db);
          const code = rows[0];
          const challenge = createHash('sha256').update(b.code_verifier).digest('base64url');
          const okChallenge =
            code &&
            challenge.length === code.codeChallenge.length &&
            timingSafeEqual(Buffer.from(challenge), Buffer.from(code.codeChallenge));
          if (
            !code ||
            new Date(code.expiresAt) <= new Date() ||
            code.clientId !== b.client_id ||
            code.redirectUri !== b.redirect_uri ||
            !okChallenge
          )
            return oauthError(reply, 400, 'invalid_grant', 'Código inválido, expirado ou já usado.');

          const access = newToken('sfa');
          const refresh = newToken('sfr');
          const ok = await withUserContext(app.db, code.userId, async (tx) => {
            const member = await sql<{
              ok: boolean;
            }>`select is_member(${code.workspaceId}::uuid) as ok`.execute(tx);
            if (!member.rows[0]?.ok) return false;
            await tx
              .insertInto('mcpGrants')
              .values({
                userId: code.userId,
                workspaceId: code.workspaceId,
                clientId: code.clientId,
                scope: code.scope,
                accessHash: hashToken(access),
                accessExpiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
                refreshHash: hashToken(refresh),
                refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
              })
              .execute();
            return true;
          });
          if (!ok) return oauthError(reply, 400, 'invalid_grant', 'Sem acesso a este espaço.');
          await app.db
            .updateTable('mcpClients')
            .set({ lastUsedAt: new Date() })
            .where('id', '=', code.clientId)
            .execute();
          app.log.info({ client: code.clientId, ws: code.workspaceId }, 'mcp: conexão autorizada');
          return reply.header('cache-control', 'no-store').send({
            access_token: access,
            token_type: 'Bearer',
            expires_in: ACCESS_TTL_S,
            refresh_token: refresh,
            scope: code.scope,
          });
        }

        if (b.grant_type === 'refresh_token') {
          if (!b.refresh_token || !b.client_id)
            return oauthError(reply, 400, 'invalid_request', 'Faltam parâmetros.');
          const access = newToken('sfa');
          const refresh = newToken('sfr');
          const { rows } = await sql<{ grantId: string; scope: string }>`select * from mcp_rotate_refresh(
            ${hashToken(b.refresh_token)}, ${b.client_id}, ${hashToken(access)},
            ${new Date(Date.now() + ACCESS_TTL_S * 1000)}, ${hashToken(refresh)},
            ${new Date(Date.now() + REFRESH_TTL_S * 1000)})`.execute(app.db);
          if (!rows[0]) return oauthError(reply, 400, 'invalid_grant', 'Refresh token inválido ou revogado.');
          return reply.header('cache-control', 'no-store').send({
            access_token: access,
            token_type: 'Bearer',
            expires_in: ACCESS_TTL_S,
            refresh_token: refresh,
            scope: rows[0].scope,
          });
        }

        return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code ou refresh_token.');
      },
    );

    // --- Revogação pelo cliente (RFC 7009: sempre 200) -----------------------------------
    o.post(
      '/api/oauth/revoke',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const token = formBody(req).token;
        if (token) await sql`select mcp_revoke_token(${hashToken(token)})`.execute(app.db);
        return reply.code(200).send({});
      },
    );
  });

  // --- Consentimento (chamado pela tela /oauth/autorizar, com a sessão do usuário) ----------
  const pre = { preHandler: guards.user };

  f.get('/api/oauth/client', pre, async (req) => {
    const q = z
      .object({ client_id: z.string().max(100), redirect_uri: z.string().max(2000) })
      .parse(req.query);
    const client = await findClient(app, q.client_id, q.redirect_uri);
    if (!client)
      throw new AppError(
        400,
        'Este aplicativo não está registrado ou o endereço de retorno não confere.',
        'invalid_client',
      );
    return { name: client.clientName, redirectHost: new URL(q.redirect_uri).host };
  });

  f.post(
    '/api/oauth/authorize',
    { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = authorizeBody.parse(req.body);
      const client = await findClient(app, b.client_id, b.redirect_uri);
      if (!client)
        throw new AppError(
          400,
          'Este aplicativo não está registrado ou o endereço de retorno não confere.',
          'invalid_client',
        );
      const target = new URL(b.redirect_uri);
      if (b.state) target.searchParams.set('state', b.state);
      target.searchParams.set('iss', urls.issuer);
      if (b.decision === 'deny') {
        target.searchParams.set('error', 'access_denied');
        return { redirect: target.toString() };
      }
      const code = newToken('sfc');
      await withUserContext(app.db, req.user!.id, async (tx) => {
        const member = await sql<{ ok: boolean }>`select is_member(${b.workspace_id}::uuid) as ok`.execute(
          tx,
        );
        if (!member.rows[0]?.ok)
          throw new AppError(403, 'Workspace não encontrado ou sem acesso.', 'forbidden');
        await tx
          .insertInto('mcpAuthCodes')
          .values({
            codeHash: hashToken(code),
            clientId: client.id,
            userId: req.user!.id,
            workspaceId: b.workspace_id,
            redirectUri: b.redirect_uri,
            codeChallenge: b.code_challenge,
            scope: MCP_SCOPE,
            expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
          })
          .execute();
      });
      target.searchParams.set('code', code);
      return { redirect: target.toString() };
    },
  );

  // --- Conexões ativas (Configurações) -----------------------------------------------------
  f.get('/api/mcp/grants', pre, async (req) =>
    withUserContext(app.db, req.user!.id, (tx) =>
      tx
        .selectFrom('mcpGrants as g')
        .innerJoin('mcpClients as c', 'c.id', 'g.clientId')
        .innerJoin('workspaces as w', 'w.id', 'g.workspaceId')
        .select(['g.id', 'c.clientName', 'w.name as workspaceName', 'g.createdAt', 'g.lastUsedAt'])
        .where('g.revokedAt', 'is', null)
        .where('g.refreshExpiresAt', '>', new Date())
        .orderBy('g.createdAt', 'desc')
        .execute(),
    ),
  );

  f.delete('/api/mcp/grants/:id', pre, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const res = await withUserContext(app.db, req.user!.id, (tx) =>
      tx
        .updateTable('mcpGrants')
        .set({ revokedAt: new Date() })
        .where('id', '=', id)
        .where('revokedAt', 'is', null)
        .executeTakeFirst(),
    );
    if (!res.numUpdatedRows) throw new AppError(404, 'Conexão não encontrada.', 'not_found');
    return { ok: true };
  });
}
