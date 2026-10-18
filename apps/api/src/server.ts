import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type pg from 'pg';
import type { AppContext } from './context.js';
import { createAuth } from './auth/auth.js';
import { sessionGuard, workspaceGuard } from './auth/actor.js';
import { AppError } from './lib/errors.js';
import { MAX_UPLOAD_BYTES } from './import/service.js';
import { DataChangeNotifier } from './realtime/notifier.js';
import { coreRoutes } from './routes/core.js';
import { financeRoutes } from './routes/finance.js';
import { chatRoutes } from './routes/chat.js';
import { channelRoutes } from './routes/channels.js';
import { pushRoutes } from './routes/push.js';
import { lgpdRoutes } from './routes/lgpd.js';
import { voiceRoutes } from './routes/voice.js';
import { agentRoutes } from './routes/agent.js';
import { adminRoutes } from './routes/admin.js';
import { oauthRoutes } from './mcp/oauth.js';
import { mcpRoutes } from './mcp/server.js';
import { pgErrorCode } from '@sf/db';

export async function buildServer(
  app: AppContext,
  pool: pg.Pool,
): Promise<{ server: FastifyInstance; notifier: DataChangeNotifier }> {
  const server = Fastify({
    loggerInstance: app.log as unknown as FastifyBaseLogger,
    bodyLimit: 2 * 1024 * 1024,
    // só confia em X-Forwarded-For de proxies configurados (ex.: o nginx da web)
    trustProxy: app.config.TRUST_PROXY,
    disableRequestLogging: false,
  });
  const auth = createAuth({ config: app.config, pool, db: app.db, mailer: app.mailer });
  const notifier = new DataChangeNotifier(app.config.DATABASE_URL, app.log);

  await server.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  // Descoberta OAuth, token e MCP são chamados por clientes de outras origens (sem cookies)
  const openCors = /^\/(?:\.well-known\/oauth-|api\/oauth\/(?:token|register|revoke)$|api\/mcp$)/;
  await server.register(cors, {
    delegator: (req, cb) =>
      openCors.test((req.url ?? '').split('?')[0]!)
        ? cb(null, {
            origin: '*',
            credentials: false,
            methods: ['GET', 'POST', 'OPTIONS'],
            exposedHeaders: ['www-authenticate', 'mcp-session-id'],
          })
        : cb(null, {
            origin: [app.config.PUBLIC_WEB_URL],
            credentials: true,
            methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
          }),
  });
  await server.register(cookie);
  await server.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // o limite roda antes da checagem de sessão: a chave é o cookie de sessão (hash), o token
    // Bearer (MCP) ou, sem nenhum dos dois, o IP
    keyGenerator: (req) => {
      const token =
        /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ??
        /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      return token
        ? `s:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}`
        : `ip:${req.ip}`;
    },
  });
  await server.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.code(err.status).send({ error: err.message, code: err.code, details: err.details });
    if (err instanceof ZodError)
      return reply.code(400).send({
        error: 'Dados inválidos.',
        code: 'validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const code = pgErrorCode(err);
    if (code === '42501')
      return reply.code(403).send({ error: 'Você não tem permissão para esta ação.', code: 'forbidden' });
    if (code === '23505') return reply.code(409).send({ error: 'Registro duplicado.', code: 'conflict' });
    if (code === '23503')
      return reply.code(409).send({ error: 'Registro em uso por outros dados.', code: 'conflict' });
    if (code === '23514' || code === '22P02')
      return reply.code(400).send({ error: 'Dados inválidos.', code: 'validation' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({ error: (err as Error).message, code: 'error' });
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: 'Erro interno. Tente novamente.', code: 'internal' });
  });

  // Better Auth (rotas /api/auth/*)
  server.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    async handler(req, reply) {
      const url = new URL(req.url, app.config.PUBLIC_API_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.append(k, Array.isArray(v) ? v.join(', ') : String(v));
      const res = await auth.handler(
        new Request(url, {
          method: req.method,
          headers,
          body: req.body && req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
        }),
      );
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });

  const guards = { user: sessionGuard(auth), ws: workspaceGuard(app) };
  server.get('/api/health', async () => ({ ok: true, llm: app.llm.name, whatsapp: Boolean(app.whatsapp), push: Boolean(app.push) }));
  await coreRoutes(server, app, guards);
  await financeRoutes(server, app, guards);
  await chatRoutes(server, app, guards, notifier);
  await channelRoutes(server, app, guards);
  await pushRoutes(server, app, guards);
  await lgpdRoutes(server, app, guards);
  await voiceRoutes(server, app, guards);
  await agentRoutes(server, app, guards);
  await adminRoutes(server, app, guards);
  await oauthRoutes(server, app, guards);
  await mcpRoutes(server, app);
  return { server, notifier };
}
