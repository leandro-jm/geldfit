import type { FastifyInstance } from 'fastify';
import Papa from 'papaparse';
import { z } from 'zod';
import { withUserContext } from '@sf/db';
import type { AppContext } from '../context.js';
import { AppError, forbidden } from '../lib/errors.js';
import { actorOf, inActor } from '../lib/http.js';

/** LGPD: exportação dos dados e exclusão real (expurgo de banco e anexos feito pelo worker). */
export async function lgpdRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, guards.ws] };

  f.get('/api/export', pre, async (req, reply) => {
    const data = await inActor(app, req, async (tx, a) => {
      const ws = a.workspaceId;
      const pick = (
        t:
          | 'accounts'
          | 'cards'
          | 'categories'
          | 'transactions'
          | 'recurrences'
          | 'pensionPlans'
          | 'pensionEntries'
          | 'trades'
          | 'goals'
          | 'budgets'
          | 'cardStatements'
          | 'attachments'
          | 'allocationTargets'
          | 'insights',
      ) => tx.selectFrom(t).selectAll().where('workspaceId', '=', ws).execute();
      const user = await tx
        .selectFrom('authUser')
        .select(['id', 'name', 'email', 'createdAt'])
        .where('id', '=', a.userId)
        .executeTakeFirst();
      return {
        exportedAt: new Date().toISOString(),
        user,
        workspace: await tx
          .selectFrom('workspaces')
          .select(['id', 'name', 'plan', 'createdAt'])
          .where('id', '=', ws)
          .executeTakeFirst(),
        settings: await tx
          .selectFrom('workspaceSettings')
          .selectAll()
          .where('workspaceId', '=', ws)
          .executeTakeFirst(),
        accounts: await pick('accounts'),
        cards: await pick('cards'),
        cardStatements: await pick('cardStatements'),
        categories: await pick('categories'),
        transactions: await pick('transactions'),
        recurrences: await pick('recurrences'),
        pensionPlans: await pick('pensionPlans'),
        pensionEntries: await pick('pensionEntries'),
        trades: await pick('trades'),
        allocationTargets: await pick('allocationTargets'),
        goals: await pick('goals'),
        budgets: await pick('budgets'),
        insights: await pick('insights'),
        attachments: (await pick('attachments')).map(({ storageKey, ...rest }) => (void storageKey, rest)),
        conversations: await tx
          .selectFrom('messages')
          .select(['conversationId', 'role', 'content', 'createdAt'])
          .where('workspaceId', '=', ws)
          .orderBy('createdAt')
          .execute(),
        consents: await tx.selectFrom('consents').selectAll().where('userId', '=', a.userId).execute(),
      };
    });
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="saude-financeira-${new Date().toISOString().slice(0, 10)}.json"`,
      );
    return JSON.stringify(data, null, 2);
  });

  f.get('/api/export/transactions.csv', pre, async (req, reply) => {
    const rows = await inActor(app, req, (tx, a) =>
      tx
        .selectFrom('transactions as t')
        .leftJoin('accounts as a', 'a.id', 't.accountId')
        .leftJoin('cards as c', 'c.id', 't.cardId')
        .leftJoin('categories as g', 'g.id', 't.categoryId')
        .select([
          't.date',
          't.description',
          't.amountCents',
          't.direction',
          't.status',
          't.kind',
          'a.name as account',
          'c.name as card',
          'g.name as category',
          't.installmentN',
          't.installmentTotal',
          't.source',
        ])
        .where('t.workspaceId', '=', a.workspaceId)
        .orderBy('t.date')
        .execute(),
    );
    const csv = Papa.unparse(
      rows.map((r) => ({
        data: r.date,
        descricao: r.description,
        valor: (((r.direction === 'out' ? -1 : 1) * r.amountCents) / 100).toFixed(2).replace('.', ','),
        status: r.status,
        tipo: r.kind,
        conta: r.account ?? '',
        cartao: r.card ?? '',
        categoria: r.category ?? '',
        parcela: r.installmentN ? `${r.installmentN}/${r.installmentTotal}` : '',
        origem: r.source,
      })),
      { delimiter: ';' },
    );
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="lancamentos.csv"');
    return `﻿${csv}`;
  });

  /** Exclui o workspace: some imediatamente para todos; o worker expurga dados e anexos. */
  f.delete('/api/workspace', pre, async (req) => {
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (a.role !== 'owner') throw forbidden('Só o dono pode excluir o workspace.');
      const ws = await tx
        .selectFrom('workspaces')
        .select('name')
        .where('id', '=', a.workspaceId)
        .executeTakeFirstOrThrow();
      if (ws.name !== confirmName) throw new AppError(422, 'Digite o nome do workspace para confirmar.');
      await tx
        .updateTable('workspaces')
        .set({ deletedAt: new Date(), purgeAfter: new Date() })
        .where('id', '=', a.workspaceId)
        .execute();
      return { ok: true };
    });
  });

  /** Exclui a conta do usuário: sai dos workspaces, exclui os que só ele administra e anonimiza o login. */
  f.delete('/api/me', { preHandler: guards.user }, async (req) => {
    const { confirm } = z.object({ confirm: z.literal('EXCLUIR') }).parse(req.body);
    void confirm;
    const userId = req.user!.id;
    await withUserContext(app.db, userId, async (tx) => {
      const mine = await tx
        .selectFrom('memberships')
        .select(['workspaceId', 'role'])
        .where('userId', '=', userId)
        .execute();
      for (const m of mine) {
        if (m.role === 'owner') {
          const owners = await tx
            .selectFrom('memberships')
            .select('userId')
            .where('workspaceId', '=', m.workspaceId)
            .where('role', '=', 'owner')
            .execute();
          if (owners.length === 1) {
            await tx
              .updateTable('workspaces')
              .set({ deletedAt: new Date(), purgeAfter: new Date() })
              .where('id', '=', m.workspaceId)
              .execute();
            continue;
          }
        }
        await tx
          .deleteFrom('memberships')
          .where('workspaceId', '=', m.workspaceId)
          .where('userId', '=', userId)
          .execute();
      }
      await tx.deleteFrom('userChannels').where('userId', '=', userId).execute();
    });
    // dados de login fora da RLS
    await app.db.deleteFrom('authSession').where('userId', '=', userId).execute();
    await app.db.deleteFrom('authAccount').where('userId', '=', userId).execute();
    await app.db
      .updateTable('authUser')
      .set({ name: 'Usuário removido', email: `removido-${userId}@invalid.local`, image: null, phone: null })
      .where('id', '=', userId)
      .execute();
    return { ok: true };
  });
  void actorOf;
}
