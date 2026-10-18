import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sql, withUserContext } from '@sf/db';
import type { Actor, AppContext } from '../context.js';
import { runTool } from '../agent/orchestrator.js';
import { TOOLS } from '../agent/registry.js';
import { hashToken, mcpUrls } from './oauth.js';

/**
 * Servidor MCP (Streamable HTTP, sem sessão): expõe as ferramentas de leitura do agente para
 * assistentes externos. Nada é gravado por aqui; lançamentos continuam no app e no WhatsApp.
 */

// Ferramentas de leitura que não fazem sentido fora do chat ou que gravam algo direto
const EXCLUDED = new Set(['parse_attachment', 'remember', 'forget']);
export const MCP_TOOLS = TOOLS.filter((t) => t.kind === 'read' && !EXCLUDED.has(t.name));
const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));
const MAX_RESULT_CHARS = 60_000;

const toolList = MCP_TOOLS.map((t) => {
  const inputSchema = z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name: t.name,
    description: t.description,
    inputSchema: inputSchema as { type: 'object'; [k: string]: unknown },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});

const INSTRUCTIONS = [
  'Dados financeiros pessoais do usuário no Saúde Financeira, em reais (BRL), restritos ao espaço que ele autorizou.',
  'Acesso somente leitura: para lançar, editar ou apagar, oriente o usuário a usar o app ou o WhatsApp do Saúde Financeira.',
  'Use get_projection, get_safe_to_spend, evaluate_purchase e get_income_commitment para perguntas sobre o futuro; os cálculos já vêm prontos, não refaça as contas.',
  'Não recomende compra ou venda de ativos específicos (Resolução CVM 19): descreva fatos da carteira, sem indicar o que fazer.',
].join(' ');

/** Resolve o token Bearer em um Actor (papel atual no espaço autorizado). */
async function actorFromToken(app: AppContext, req: FastifyRequest): Promise<Actor | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return null;
  const { rows } = await sql<{ userId: string; workspaceId: string }>`
    select user_id, workspace_id from mcp_resolve_access(${hashToken(token)})`.execute(app.db);
  const g = rows[0];
  if (!g) return null;
  const m = await withUserContext(app.db, g.userId, (tx) =>
    tx
      .selectFrom('memberships as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
      .select('m.role')
      .where('m.userId', '=', g.userId)
      .where('m.workspaceId', '=', g.workspaceId)
      .where('w.deletedAt', 'is', null)
      .executeTakeFirst(),
  );
  if (!m) return null;
  return { userId: g.userId, workspaceId: g.workspaceId, role: m.role as Actor['role'], channel: 'mcp' };
}

function buildMcpServer(app: AppContext, actor: Actor): Server {
  const server = new Server(
    { name: 'saude-financeira', title: 'Saúde Financeira', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!MCP_TOOL_NAMES.has(name))
      return { content: [{ type: 'text', text: `Ferramenta indisponível: ${name}` }], isError: true };
    const { result, isError } = await runTool(
      app,
      actor,
      '',
      [],
      name,
      req.params.arguments ?? {},
      () => {},
      () => {},
    );
    let text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}… [resultado truncado]`;
    return { content: [{ type: 'text', text }], isError };
  });
  return server;
}

export async function mcpRoutes(f: FastifyInstance, app: AppContext) {
  const urls = mcpUrls(app);

  const unauthorized = (reply: FastifyReply) =>
    reply
      .code(401)
      .header(
        'www-authenticate',
        `Bearer realm="saude-financeira", error="invalid_token", resource_metadata="${urls.resourceMetadata}"`,
      )
      .send({ error: 'Token ausente, expirado ou revogado.', code: 'unauthenticated' });

  f.post('/api/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const actor = await actorFromToken(app, req);
    if (!actor) return unauthorized(reply);

    const server = buildMcpServer(app, actor);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp: erro ao processar requisição');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno.' }, id: null }),
        );
      }
    }
  });

  // Sem sessão: não há stream de notificações nem sessão para encerrar
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'Use POST.', code: 'method_not_allowed' });
  f.get('/api/mcp', notAllowed);
  f.delete('/api/mcp', notAllowed);
}
