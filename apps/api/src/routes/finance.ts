import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addMonths, startOfMonth, type PensionDTO } from '@sf/shared';
import type { AppContext } from '../context.js';
import { forbidden, notFound } from '../lib/errors.js';
import { inActor } from '../lib/http.js';
import { computeCommitment } from '../domain/commitment.js';
import { categorySpend, dashboardSummary, monthlyFlows } from '../domain/dashboard.js';
import { confirmDraft, createDraft, DRAFT_SCHEMAS, type DraftKind } from '../domain/drafts.js';
import { workspaceToday } from '../domain/ledger.js';
import { buildPortfolio } from '../domain/portfolio.js';
import { computeProjection } from '../domain/projection.js';
import { retirementScenario } from '../domain/retirement.js';
import { detectSeasonal, seasonalCalendar } from '../domain/seasonal.js';
import { emergencyReserve, safeToSpend } from '../domain/forecast.js';
import {
  listAccounts,
  listCards,
  listCategories,
  listRecurrences,
  listStatements,
  queryTransactions,
  upcoming,
} from '../domain/queries.js';

const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export async function financeRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, guards.ws] };

  f.get('/api/accounts', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      listAccounts(
        tx,
        a.workspaceId,
        await workspaceToday(tx, a.workspaceId),
        (req.query as { archived?: string }).archived === '1',
      ),
    ),
  );
  f.get('/api/cards', pre, async (req) =>
    inActor(app, req, async (tx, a) => listCards(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId))),
  );
  f.get('/api/cards/:id/statements', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx, a) => {
      const today = await workspaceToday(tx, a.workspaceId);
      const statements = await listStatements(tx, a.workspaceId, {
        cardId: id,
        from: addMonths(startOfMonth(today), -12),
      });
      const items = await tx
        .selectFrom('transactions')
        .select([
          'id',
          'date',
          'description',
          'amountCents',
          'direction',
          'installmentN',
          'installmentTotal',
          'cardStatementId',
          'status',
        ])
        .where('cardId', '=', id)
        .where('cardStatementId', 'in', [
          ...statements.map((s) => s.id),
          '00000000-0000-0000-0000-000000000000',
        ])
        .orderBy('date')
        .execute();
      return { statements, items };
    });
  });

  f.get('/api/categories', pre, async (req) =>
    inActor(app, req, (tx, a) => listCategories(tx, a.workspaceId)),
  );
  f.post('/api/categories', pre, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60),
        kind: z.enum(['income', 'expense']),
        parentId: z.string().uuid().nullish(),
        icon: z.string().max(40).nullish(),
        color: z.string().max(20).nullish(),
      })
      .parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (a.role === 'viewer') throw forbidden();
      return tx
        .insertInto('categories')
        .values({ workspaceId: a.workspaceId, ...body })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  });
  f.patch('/api/categories/:id', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        icon: z.string().max(40).nullish(),
        color: z.string().max(20).nullish(),
        parentId: z.string().uuid().nullish(),
      })
      .parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (a.role === 'viewer') throw forbidden();
      const r = await tx
        .updateTable('categories')
        .set(body)
        .where('id', '=', id)
        .where('workspaceId', '=', a.workspaceId)
        .returningAll()
        .executeTakeFirst();
      if (!r) throw notFound('Categoria');
      return r;
    });
  });
  f.delete('/api/categories/:id', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx, a) => {
      if (a.role === 'viewer') throw forbidden();
      await tx
        .deleteFrom('categories')
        .where('id', '=', id)
        .where('workspaceId', '=', a.workspaceId)
        .execute();
      return { ok: true };
    });
  });

  f.get('/api/transactions', pre, async (req) => {
    const q = z
      .object({
        from: optDate,
        to: optDate,
        account: z.string().uuid().optional(),
        card: z.string().uuid().optional(),
        category: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
        direction: z.enum(['in', 'out']).optional(),
        status: z.enum(['posted', 'scheduled']).optional(),
        transfers: z.enum(['0', '1']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return inActor(app, req, (tx, a) =>
      queryTransactions(tx, a.workspaceId, {
        from: q.from,
        to: q.to,
        accountId: q.account,
        cardId: q.card,
        categoryId: q.category,
        text: q.q,
        direction: q.direction,
        status: q.status,
        includeTransfers: q.transfers !== '0',
        limit: q.limit,
        offset: q.offset,
      }),
    );
  });

  f.get('/api/recurrences', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      listRecurrences(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );

  f.get('/api/projection', pre, async (req) => {
    const q = z
      .object({
        account: z.string().uuid().optional(),
        months: z.coerce.number().int().min(1).max(36).default(24),
      })
      .parse(req.query);
    return inActor(app, req, (tx, a) =>
      computeProjection(tx, a.workspaceId, {
        accountId: q.account ?? null,
        months: q.months,
        withSeasonal: true,
      }),
    );
  });

  // Calendário anual (IPVA, IPTU, 13º...): itens aprendidos do histórico e próximas ocorrências
  f.get('/api/calendar', pre, async (req) => {
    const { months } = z
      .object({ months: z.coerce.number().int().min(1).max(24).default(12) })
      .parse(req.query);
    return inActor(app, req, async (tx, a) =>
      seasonalCalendar(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId), months),
    );
  });
  // Refaz a detecção na hora (ex.: logo depois de importar um extrato antigo)
  f.post('/api/calendar/detect', pre, async (req) =>
    inActor(app, req, async (tx, a) => {
      if (a.role === 'viewer') throw forbidden('Seu papel neste workspace é só leitura.');
      const today = await workspaceToday(tx, a.workspaceId);
      const r = await detectSeasonal(tx, a.workspaceId, today);
      return { ...r, calendar: await seasonalCalendar(tx, a.workspaceId, today, 12) };
    }),
  );

  f.get('/api/dashboard/summary', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      dashboardSummary(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );
  f.get('/api/dashboard/safe-to-spend', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      safeToSpend(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );
  f.get('/api/dashboard/commitment', pre, async (req) => {
    const { months } = z
      .object({ months: z.coerce.number().int().min(1).max(24).default(12) })
      .parse(req.query);
    return inActor(app, req, async (tx, a) =>
      computeCommitment(tx, a.workspaceId, { months, today: await workspaceToday(tx, a.workspaceId) }),
    );
  });
  f.get('/api/dashboard/emergency-reserve', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      emergencyReserve(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );
  f.get('/api/dashboard/upcoming', pre, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(60).default(15) }).parse(req.query);
    return inActor(app, req, async (tx, a) =>
      upcoming(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId), days),
    );
  });
  f.get('/api/dashboard/flows', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      monthlyFlows(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );
  f.get('/api/dashboard/categories', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      categorySpend(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );

  f.get('/api/pension', pre, async (req) =>
    inActor(app, req, async (tx, a): Promise<PensionDTO> => {
      const plans = await tx
        .selectFrom('pensionPlans')
        .select(['id', 'provider', 'name'])
        .where('workspaceId', '=', a.workspaceId)
        .execute();
      const entries = await tx
        .selectFrom('pensionEntries')
        .selectAll()
        .where('workspaceId', '=', a.workspaceId)
        .orderBy('refMonth')
        .execute();
      return {
        plans: plans.map((p) => ({
          ...p,
          entries: entries
            .filter((e) => e.planId === p.id)
            .map((e) => ({
              refMonth: e.refMonth,
              balanceCents: e.balanceCents,
              participantCents: e.contribParticipantCents,
              sponsorCents: e.contribSponsorCents,
              attachmentId: e.attachmentId,
            })),
        })),
      };
    }),
  );

  // Cenário de aposentadoria: perfil salvo + ajustes pontuais pela query (taxas em fração ao ano)
  f.get('/api/retirement', pre, async (req) => {
    const rate = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();
    const q = z
      .object({
        birth_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        retire_year: z.coerce.number().int().min(1950).max(2150).optional(),
        retire_age: z.coerce.number().int().min(30).max(90).optional(),
        end_age: z.coerce.number().int().min(50).max(110).optional(),
        accumulation_rate: rate(-0.05, 0.2),
        withdrawal_rate: rate(-0.05, 0.2),
        contribution_growth: rate(-0.1, 0.1),
        target_income_cents: z.coerce.number().int().positive().optional(),
        inss_cents: z.coerce.number().int().nonnegative().optional(),
        include_investments: z.enum(['0', '1', 'true', 'false']).optional(),
      })
      .parse(req.query);
    return inActor(app, req, async (tx, a) =>
      retirementScenario(tx, a, await workspaceToday(tx, a.workspaceId), {
        birthDate: q.birth_date,
        retireYear: q.retire_year,
        retireAge: q.retire_age,
        endAge: q.end_age,
        accumulationRate: q.accumulation_rate,
        withdrawalRate: q.withdrawal_rate,
        contributionGrowth: q.contribution_growth,
        targetIncomeCents: q.target_income_cents,
        inssMonthlyCents: q.inss_cents,
        includeInvestments: q.include_investments ? ['1', 'true'].includes(q.include_investments) : undefined,
      }),
    );
  });

  f.get('/api/portfolio', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      buildPortfolio(tx, a.workspaceId, await workspaceToday(tx, a.workspaceId)),
    ),
  );
  f.get('/api/trades', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx
        .selectFrom('trades as t')
        .innerJoin('assets as s', 's.id', 't.assetId')
        .select([
          't.id',
          't.date',
          't.kind',
          't.qty',
          't.priceCents',
          't.feesCents',
          't.totalCents',
          't.fxRate',
          't.broker',
          's.ticker',
          's.name',
          's.kind as assetKind',
          's.currency',
        ])
        .where('t.workspaceId', '=', a.workspaceId)
        .orderBy('t.date', 'desc')
        .limit(500)
        .execute(),
    ),
  );
  f.get('/api/allocation-targets', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx.selectFrom('allocationTargets').selectAll().where('workspaceId', '=', a.workspaceId).execute(),
    ),
  );

  f.get('/api/insights', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx
        .selectFrom('insights')
        .select(['id', 'rule', 'severity', 'title', 'message', 'payload', 'createdAt'])
        .where('workspaceId', '=', a.workspaceId)
        .where('resolvedAt', 'is', null)
        .where('dismissedAt', 'is', null)
        .orderBy('createdAt', 'desc')
        .execute(),
    ),
  );
  f.post('/api/insights/:id/dismiss', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx, a) => {
      await tx
        .updateTable('insights')
        .set({ dismissedAt: new Date() })
        .where('id', '=', id)
        .where('workspaceId', '=', a.workspaceId)
        .execute();
      return { ok: true };
    });
  });
  f.post('/api/insights/mute', pre, async (req) => {
    const { rule, muted } = z.object({ rule: z.string().max(40), muted: z.boolean() }).parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (muted)
        await tx
          .insertInto('insightMutes')
          .values({ workspaceId: a.workspaceId, rule })
          .onConflict((oc) => oc.doNothing())
          .execute();
      else
        await tx
          .deleteFrom('insightMutes')
          .where('workspaceId', '=', a.workspaceId)
          .where('rule', '=', rule)
          .execute();
      return { ok: true };
    });
  });
  f.get('/api/insights/mutes', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx.selectFrom('insightMutes').select('rule').where('workspaceId', '=', a.workspaceId).execute(),
    ),
  );

  f.get('/api/budgets', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx
        .selectFrom('budgets as b')
        .innerJoin('categories as c', 'c.id', 'b.categoryId')
        .select(['b.id', 'b.categoryId', 'c.name', 'b.amountCents', 'b.alertPct'])
        .where('b.workspaceId', '=', a.workspaceId)
        .execute(),
    ),
  );
  f.get('/api/goals', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx
        .selectFrom('goals')
        .selectAll()
        .where('workspaceId', '=', a.workspaceId)
        .orderBy('createdAt')
        .execute(),
    ),
  );

  f.get('/api/audit', pre, async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return inActor(app, req, (tx, a) =>
      tx
        .selectFrom('auditLog as l')
        .leftJoin('authUser as u', 'u.id', 'l.actorId')
        .select(['l.id', 'l.action', 'l.entity', 'l.entityId', 'l.at', 'l.undoneAt', 'u.name as actorName'])
        .where('l.workspaceId', '=', a.workspaceId)
        .orderBy('l.id', 'desc')
        .limit(limit)
        .execute(),
    );
  });

  /**
   * Ações explícitas das telas (formulários e edição inline). Usam o mesmo mecanismo de draft
   * do agente — validação, auditoria e desfazer — com confirmação imediata pelo próprio envio.
   */
  f.post('/api/actions', pre, async (req) => {
    const body = z
      .object({
        kind: z.enum(Object.keys(DRAFT_SCHEMAS) as [DraftKind, ...DraftKind[]]),
        payload: z.unknown(),
      })
      .parse(req.body);
    return inActor(app, req, async (tx, a) => {
      const d = await createDraft(
        tx,
        a,
        body.kind,
        body.payload as never,
        { title: body.kind, summary: '', lines: [], warnings: [] },
        null,
        { computeImpact: false },
      );
      return confirmDraft(tx, a, d.id);
    });
  });
}
