import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withUserContext } from '@sf/db';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';

const subscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  device: z.string().max(200).optional(),
});

/** Web Push: inscrições por aparelho (o envio é feito pelo worker). */
export async function pushRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: guards.user };

  /** Chave pública VAPID (null = push desligado neste servidor). */
  f.get('/api/push/key', pre, async () => ({ publicKey: app.push?.publicKey ?? null }));

  f.post(
    '/api/push/subscriptions',
    { ...pre, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      if (!app.push) throw new AppError(503, 'As notificações não estão configuradas neste servidor.');
      const { endpoint, keys, device } = subscription.parse(req.body);
      await withUserContext(app.db, req.user!.id, (tx) =>
        sql`select claim_push_subscription(${endpoint}, ${keys.p256dh}, ${keys.auth}, ${device ?? null})`.execute(
          tx,
        ),
      );
      return { ok: true };
    },
  );

  f.delete('/api/push/subscriptions', pre, async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await withUserContext(app.db, req.user!.id, (tx) =>
      tx.deleteFrom('pushSubscriptions').where('endpoint', '=', endpoint).execute(),
    );
    return { ok: true };
  });
}
