import type { FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { withUserContext } from '@sf/db';
import type { Actor, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import type { Auth } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; name: string; email: string; image: string | null };
    actor?: Actor;
  }
}

export function sessionGuard(auth: Auth) {
  return async function requireUser(req: FastifyRequest) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) throw new AppError(401, 'Faça login para continuar.', 'unauthenticated');
    req.user = {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    };
  };
}

/** Resolve o workspace do cabeçalho X-Workspace-Id (ou o primeiro do usuário) e o papel. */
export function workspaceGuard(app: AppContext) {
  return async function requireWorkspace(req: FastifyRequest, _reply: FastifyReply) {
    if (!req.user) throw new AppError(401, 'Faça login para continuar.', 'unauthenticated');
    const fromQuery = (req.query as { ws?: string } | undefined)?.ws;
    const wanted = (req.headers['x-workspace-id'] as string | undefined) ?? (fromQuery && /^[0-9a-f-]{36}$/.test(fromQuery) ? fromQuery : null);
    const m = await withUserContext(app.db, req.user.id, async (tx) => {
      let q = tx
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
        .select(['m.workspaceId', 'm.role'])
        .where('m.userId', '=', req.user!.id)
        .where('w.deletedAt', 'is', null)
        .orderBy('m.createdAt');
      if (wanted) q = q.where('m.workspaceId', '=', wanted);
      return q.executeTakeFirst();
    });
    if (!m) throw new AppError(403, 'Workspace não encontrado ou sem acesso.', 'forbidden');
    req.actor = {
      userId: req.user.id,
      workspaceId: m.workspaceId,
      role: m.role as Actor['role'],
      channel: 'web',
    };
  };
}
