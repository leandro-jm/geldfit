import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withUserContext } from '@sf/db';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { actorOf } from '../lib/http.js';
import { normalizePhone } from '../channels/types.js';
import { enqueueInbound } from '../channels/whatsapp-handler.js';
import { EvolutionChannel } from '../channels/evolution.js';

const hashCode = (code: string, address: string) =>
  createHash('sha256').update(`${address}:${code}`).digest('hex');

export async function channelRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, guards.ws] };

  f.get('/api/channels/whatsapp', pre, async (req) => {
    const actor = actorOf(req);
    const rows = await withUserContext(app.db, actor.userId, (tx) =>
      tx
        .selectFrom('userChannels')
        .select(['id', 'address', 'verifiedAt', 'defaultWorkspaceId', 'codeExpiresAt'])
        .where('kind', '=', 'whatsapp')
        .execute(),
    );
    return { enabled: Boolean(app.whatsapp), channels: rows };
  });

  /** Envia um código de 6 dígitos para o número informado. */
  f.post(
    '/api/channels/whatsapp',
    { ...pre, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req) => {
      if (!app.whatsapp) throw new AppError(503, 'O WhatsApp não está configurado neste servidor.');
      const actor = actorOf(req);
      const { phone } = z.object({ phone: z.string().min(8).max(20) }).parse(req.body);
      const address = normalizePhone(phone);
      if (!/^\d{12,13}$/.test(address))
        throw new AppError(422, 'Número inválido. Use DDD + número, ex.: (48) 99999-0000.');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        await withUserContext(app.db, actor.userId, (tx) =>
          sql`select claim_whatsapp(${address}, ${hashCode(code, address)}, ${new Date(Date.now() + 10 * 60_000)}, ${actor.workspaceId}::uuid)`.execute(
            tx,
          ),
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new AppError(409, 'Este número já está vinculado a outra conta.');
        throw err;
      }
      await app.whatsapp.sendText(
        address,
        `Seu código do Saúde Financeira: *${code}*\nDigite-o no app para vincular este WhatsApp. Ele vale por 10 minutos.`,
      );
      return { ok: true, address };
    },
  );

  f.post(
    '/api/channels/whatsapp/verify',
    { ...pre, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      const actor = actorOf(req);
      const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
      const ok = await withUserContext(app.db, actor.userId, async (tx) => {
        const row = await tx
          .selectFrom('userChannels')
          .selectAll()
          .where('kind', '=', 'whatsapp')
          .where('verifiedAt', 'is', null)
          .executeTakeFirst();
        if (!row?.verificationCodeHash || !row.codeExpiresAt || new Date(row.codeExpiresAt) < new Date())
          return false;
        const a = Buffer.from(row.verificationCodeHash);
        const b = Buffer.from(hashCode(code, row.address));
        if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
        await tx
          .updateTable('userChannels')
          .set({ verifiedAt: new Date(), verificationCodeHash: null, codeExpiresAt: null })
          .where('id', '=', row.id)
          .execute();
        return row.address;
      });
      if (!ok) throw new AppError(422, 'Código inválido ou expirado.');
      await app.whatsapp
        ?.sendText(
          ok,
          'WhatsApp vinculado! Você já pode lançar e consultar por aqui. Ex.: "paguei 230 de luz no BB ontem".',
        )
        .catch(() => {});
      return { ok: true };
    },
  );

  f.patch('/api/channels/whatsapp', pre, async (req) => {
    const actor = actorOf(req);
    const { workspaceId } = z.object({ workspaceId: z.string().uuid() }).parse(req.body);
    await withUserContext(app.db, actor.userId, async (tx) => {
      const m = await tx
        .selectFrom('memberships')
        .select('role')
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', actor.userId)
        .executeTakeFirst();
      if (!m) throw new AppError(403, 'Sem acesso a este workspace.');
      await tx
        .updateTable('userChannels')
        .set({ defaultWorkspaceId: workspaceId })
        .where('kind', '=', 'whatsapp')
        .execute();
    });
    return { ok: true };
  });

  f.delete('/api/channels/whatsapp', pre, async (req) => {
    const actor = actorOf(req);
    await withUserContext(app.db, actor.userId, (tx) =>
      tx.deleteFrom('userChannels').where('kind', '=', 'whatsapp').execute(),
    );
    return { ok: true };
  });

  f.get('/api/channels/whatsapp/status', pre, async () => {
    if (!(app.whatsapp instanceof EvolutionChannel)) return { enabled: false, state: null };
    const state = await app.whatsapp.connectionState().catch(() => 'unreachable');
    return { enabled: true, state };
  });

  /** Webhook da Evolution API. O segredo no caminho autentica a origem. */
  f.post(
    '/webhooks/evolution/:secret',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { secret } = req.params as { secret: string };
      const expected = Buffer.from(app.config.EVOLUTION_WEBHOOK_SECRET);
      const given = Buffer.from(secret ?? '');
      if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given))
        return reply.code(401).send({ error: 'unauthorized' });
      if (!app.whatsapp) return reply.code(202).send({ ok: true });
      const msg = app.whatsapp.parseWebhook(req.body);
      if (msg) enqueueInbound(app, msg); // processa em segundo plano; responde rápido para evitar reentrega
      return reply.code(200).send({ ok: true });
    },
  );
}
