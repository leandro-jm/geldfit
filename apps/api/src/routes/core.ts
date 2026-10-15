import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, withUserContext } from '@sf/db';
import type { Me } from '@sf/shared';
import type { AppContext } from '../context.js';
import { AppError, forbidden } from '../lib/errors.js';
import { actorOf, inActor } from '../lib/http.js';

export const CONSENT_VERSION = '2026-10';

export async function coreRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  f.get('/api/me', { preHandler: guards.user }, async (req): Promise<Me> => {
    const user = req.user!;
    return withUserContext(app.db, user.id, async (tx) => {
      const workspaces = await tx
        .selectFrom('memberships as m')
        .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
        .select(['w.id', 'w.name', 'w.plan', 'm.role'])
        .where('m.userId', '=', user.id)
        .where('w.deletedAt', 'is', null)
        .orderBy('m.createdAt')
        .execute();
      const consent = await tx
        .selectFrom('consents')
        .select('id')
        .where('userId', '=', user.id)
        .where('kind', '=', 'privacy')
        .where('version', '=', CONSENT_VERSION)
        .executeTakeFirst();
      return {
        user,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          plan: w.plan,
          role: w.role as Me['workspaces'][number]['role'],
        })),
        consented: Boolean(consent),
        features: { audio: app.transcriber !== null },
      };
    });
  });

  f.post('/api/me/consent', { preHandler: guards.user }, async (req) => {
    const body = z
      .object({ terms: z.literal(true), privacy: z.literal(true), llm: z.literal(true) })
      .parse(req.body);
    void body;
    await withUserContext(app.db, req.user!.id, async (tx) => {
      for (const kind of ['terms', 'privacy', 'llm_processing'] as const) {
        await tx
          .insertInto('consents')
          .values({ userId: req.user!.id, kind, version: CONSENT_VERSION, ip: req.ip })
          .execute();
      }
    });
    return { ok: true };
  });

  f.post('/api/workspaces', { preHandler: guards.user }, async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const id = await withUserContext(
      app.db,
      req.user!.id,
      async (tx) =>
        (await sql<{ id: string }>`select create_workspace(${name}) as id`.execute(tx)).rows[0]!.id,
    );
    return { id };
  });

  f.patch('/api/workspace', { preHandler: [guards.user, guards.ws] }, async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (a.role !== 'owner') throw forbidden();
      await tx.updateTable('workspaces').set({ name }).where('id', '=', a.workspaceId).execute();
      return { ok: true };
    });
  });

  // --- Membros e convites -------------------------------------------------------------------
  f.get('/api/members', { preHandler: [guards.user, guards.ws] }, async (req) =>
    inActor(app, req, async (tx, a) => {
      const members = await tx
        .selectFrom('memberships as m')
        .innerJoin('authUser as u', 'u.id', 'm.userId')
        .select(['u.id', 'u.name', 'u.email', 'u.image', 'm.role', 'm.createdAt'])
        .where('m.workspaceId', '=', a.workspaceId)
        .orderBy('m.createdAt')
        .execute();
      const invites =
        a.role === 'owner'
          ? await tx
              .selectFrom('invites')
              .select(['id', 'email', 'role', 'expiresAt', 'acceptedAt'])
              .where('workspaceId', '=', a.workspaceId)
              .where('acceptedAt', 'is', null)
              .execute()
          : [];
      return { members, invites };
    }),
  );

  f.post('/api/invites', { preHandler: [guards.user, guards.ws] }, async (req) => {
    const body = z.object({ email: z.string().email(), role: z.enum(['member', 'viewer']) }).parse(req.body);
    const token = randomBytes(24).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const wsName = await inActor(app, req, async (tx, a) => {
      if (a.role !== 'owner') throw forbidden('Só o dono do workspace pode convidar.');
      await tx
        .insertInto('invites')
        .values({
          workspaceId: a.workspaceId,
          email: body.email.toLowerCase(),
          role: body.role,
          tokenHash,
          invitedBy: a.userId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        })
        .execute();
      return (
        await tx
          .selectFrom('workspaces')
          .select('name')
          .where('id', '=', a.workspaceId)
          .executeTakeFirstOrThrow()
      ).name;
    });
    const url = `${app.config.PUBLIC_WEB_URL}/convite/${token}`;
    await app.mailer.send(
      body.email,
      `Convite para "${wsName}"`,
      `${req.user!.name} convidou você para o workspace "${wsName}" no Saúde Financeira.\nAceite em: ${url}\n(O convite vale por 7 dias.)`,
    );
    return { ok: true, url: app.config.NODE_ENV === 'production' ? undefined : url };
  });

  f.delete('/api/invites/:id', { preHandler: [guards.user, guards.ws] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx, a) => {
      await tx.deleteFrom('invites').where('id', '=', id).where('workspaceId', '=', a.workspaceId).execute();
      return { ok: true };
    });
  });

  f.post('/api/invites/accept', { preHandler: guards.user }, async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const hash = createHash('sha256').update(token).digest('hex');
    try {
      const ws = await withUserContext(
        app.db,
        req.user!.id,
        async (tx) =>
          (await sql<{ id: string }>`select accept_invite(${hash}) as id`.execute(tx)).rows[0]!.id,
      );
      return { workspaceId: ws };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P0002') throw new AppError(404, 'Convite inválido ou expirado.');
      if (code === '42501') throw new AppError(403, 'Este convite foi enviado para outro e-mail.');
      throw err;
    }
  });

  f.patch('/api/members/:userId', { preHandler: [guards.user, guards.ws] }, async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['owner', 'member', 'viewer']) }).parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (a.role !== 'owner') throw forbidden();
      if (userId === a.userId && role !== 'owner') {
        const owners = await tx
          .selectFrom('memberships')
          .select('userId')
          .where('workspaceId', '=', a.workspaceId)
          .where('role', '=', 'owner')
          .execute();
        if (owners.length < 2) throw new AppError(422, 'O workspace precisa de pelo menos um dono.');
      }
      await tx
        .updateTable('memberships')
        .set({ role })
        .where('workspaceId', '=', a.workspaceId)
        .where('userId', '=', userId)
        .execute();
      return { ok: true };
    });
  });

  f.delete('/api/members/:userId', { preHandler: [guards.user, guards.ws] }, async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    return inActor(app, req, async (tx, a) => {
      if (a.role !== 'owner' && userId !== a.userId) throw forbidden();
      const target = await tx
        .selectFrom('memberships')
        .select('role')
        .where('workspaceId', '=', a.workspaceId)
        .where('userId', '=', userId)
        .executeTakeFirst();
      if (target?.role === 'owner') {
        const owners = await tx
          .selectFrom('memberships')
          .select('userId')
          .where('workspaceId', '=', a.workspaceId)
          .where('role', '=', 'owner')
          .execute();
        if (owners.length < 2) throw new AppError(422, 'O workspace precisa de pelo menos um dono.');
      }
      await tx
        .deleteFrom('memberships')
        .where('workspaceId', '=', a.workspaceId)
        .where('userId', '=', userId)
        .execute();
      return { ok: true };
    });
  });

  // --- Configurações -----------------------------------------------------------------------
  f.get('/api/settings', { preHandler: [guards.user, guards.ws] }, async (req) =>
    inActor(app, req, async (tx, a) => {
      const settings = await tx
        .selectFrom('workspaceSettings')
        .selectAll()
        .where('workspaceId', '=', a.workspaceId)
        .executeTakeFirstOrThrow();
      const prefs = await tx
        .selectFrom('reminderPrefs')
        .select(['kind', 'enabled'])
        .where('workspaceId', '=', a.workspaceId)
        .where('userId', '=', a.userId)
        .execute();
      const ws = await tx
        .selectFrom('workspaces')
        .select(['name', 'plan'])
        .where('id', '=', a.workspaceId)
        .executeTakeFirstOrThrow();
      return { workspace: ws, settings, reminderPrefs: prefs, role: a.role };
    }),
  );
  void actorOf;
}
