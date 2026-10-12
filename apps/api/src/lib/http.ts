import type { FastifyReply, FastifyRequest } from 'fastify';
import { withUserContext, type Tx } from '@sf/db';
import type { Actor, AppContext } from '../context.js';
import { AppError } from './errors.js';

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new AppError(401, 'Faça login para continuar.', 'unauthenticated');
  return req.actor;
}

export function inActor<T>(
  app: AppContext,
  req: FastifyRequest,
  fn: (tx: Tx, actor: Actor) => Promise<T>,
): Promise<T> {
  const actor = actorOf(req);
  return withUserContext(app.db, actor.userId, (tx) => fn(tx, actor));
}

/** Abre um stream SSE na resposta (o Fastify deixa de gerenciar a resposta). */
export function openSSE(req: FastifyRequest, reply: FastifyReply, allowOrigin: string) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
  });
  let closed = false;
  req.raw.on('close', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    send(data: unknown, event?: string) {
      if (closed) return;
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    end() {
      if (!closed) res.end();
      closed = true;
    },
    onClose(fn: () => void) {
      req.raw.on('close', fn);
    },
  };
}
