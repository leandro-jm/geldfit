import {
  addDays,
  addMonths,
  startOfMonth,
  type CategorySpend,
  type DashboardSummary,
  type MonthlyFlow,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { buildPortfolio, portfolioValueAt } from './portfolio.js';
import { computeProjection } from './projection.js';
import { listAccounts } from './queries.js';

async function openBillsAt(tx: Tx, ws: string, date: string): Promise<number> {
  // faturas já fechadas ou a atual (fecha nos próximos ~31 dias), descontados pagamentos até a data
  const r = await sql<{ cents: number }>`
    select coalesce(sum(greatest(
      (select coalesce(sum(case when t.direction = 'out' then t.amount_cents else -t.amount_cents end), 0) from transactions t where t.card_statement_id = cs.id and t.date <= ${date}::date)
      - (select coalesce(sum(p.amount_cents), 0) from transactions p where p.pays_statement_id = cs.id and p.status = 'posted' and p.date <= ${date}::date), 0)), 0)::bigint as cents
    from card_statements cs
    where cs.workspace_id = ${ws}::uuid and cs.closing_date <= ${addDays(date, 31)}::date and cs.due_date >= ${addDays(date, -60)}::date`.execute(
    tx,
  );
  return Number(r.rows[0]?.cents ?? 0);
}

async function pensionAt(tx: Tx, ws: string, date: string): Promise<number> {
  const r = await sql<{ cents: number }>`
    select coalesce(sum(balance_cents), 0)::bigint as cents from (
      select distinct on (plan_id) balance_cents from pension_entries where workspace_id = ${ws}::uuid and ref_month <= ${date}::date order by plan_id, ref_month desc) x`.execute(
    tx,
  );
  return Number(r.rows[0]?.cents ?? 0);
}

/** KPIs do painel. Patrimônio = contas + investimentos + previdência − faturas abertas. */
export async function dashboardSummary(tx: Tx, ws: string, today: string): Promise<DashboardSummary> {
  const accounts = await listAccounts(tx, ws, today);
  const accountsBalanceCents = accounts
    .filter((a) => a.type !== 'investment')
    .reduce((s, a) => s + a.balanceCents, 0);
  const investmentAccounts = accounts
    .filter((a) => a.type === 'investment')
    .reduce((s, a) => s + a.balanceCents, 0);
  const openBillsCents = await openBillsAt(tx, ws, today);
  const pf = await portfolioValueAt(tx, ws, today);
  const investmentsCents = pf.valueCents + investmentAccounts;
  const pensionCents = await pensionAt(tx, ws, today);
  const proj = await computeProjection(tx, ws);

  const prevEnd = addDays(startOfMonth(today), -1);
  const prevBalances = await sql<{ cents: number }>`
    select coalesce(sum(account_balance(a.id, ${prevEnd}::date)), 0)::bigint as cents from accounts a
    where a.workspace_id = ${ws}::uuid and a.archived_at is null and a.type <> 'investment' and a.opening_date <= ${prevEnd}::date`.execute(
    tx,
  );
  const prevInvAccounts = await sql<{ cents: number }>`
    select coalesce(sum(account_balance(a.id, ${prevEnd}::date)), 0)::bigint as cents from accounts a
    where a.workspace_id = ${ws}::uuid and a.archived_at is null and a.type = 'investment' and a.opening_date <= ${prevEnd}::date`.execute(
    tx,
  );
  const prevBills = await openBillsAt(tx, ws, prevEnd);
  const prevPf = await portfolioValueAt(tx, ws, prevEnd);
  const prevPension = await pensionAt(tx, ws, prevEnd);
  const prevAccounts = Number(prevBalances.rows[0]?.cents ?? 0);
  const hasHistory = accounts.some((a) => a.openingDate <= prevEnd);

  const last = await sql<{ at: Date | null }>`
    select greatest((select max(created_at) from transactions where workspace_id = ${ws}::uuid),
                    (select max(created_at) from attachments where workspace_id = ${ws}::uuid)) as at`.execute(
    tx,
  );

  return {
    asOf: today,
    netWorthCents: accountsBalanceCents + investmentsCents + pensionCents - openBillsCents,
    accountsBalanceCents,
    openBillsCents,
    investmentsCents,
    pensionCents,
    minProjected: proj.minClosing,
    previousMonth: hasHistory
      ? {
          netWorthCents:
            prevAccounts +
            prevPf.valueCents +
            Number(prevInvAccounts.rows[0]?.cents ?? 0) +
            prevPension -
            prevBills,
          accountsBalanceCents: prevAccounts,
          openBillsCents: prevBills,
        }
      : null,
    lastUpdate: last.rows[0]?.at ? new Date(last.rows[0].at).toISOString() : null,
    staleAccounts: accounts
      .filter((a) => a.stale)
      .map((a) => ({ id: a.id, name: a.name, lastActivityDate: a.lastActivityDate })),
    alert: proj.firstBelowFloor
      ? {
          kind: 'below_floor',
          month: proj.firstBelowFloor,
          cents: proj.months.find((m) => m.month === proj.firstBelowFloor)!.closingCents,
        }
      : null,
  };
}

/** 12 meses realizados + 3 projetados. */
export async function monthlyFlows(tx: Tx, ws: string, today: string): Promise<MonthlyFlow[]> {
  const m0 = startOfMonth(today);
  const from = addMonths(m0, -11);
  const rows = await sql<{ month: string; inc: number; exp: number }>`
    select to_char(date_trunc('month', date), 'YYYY-MM-01') as month,
      coalesce(sum(case when direction = 'in' then amount_cents end), 0)::bigint as inc,
      coalesce(sum(case when direction = 'out' then amount_cents end), 0)::bigint as exp
    from transactions where workspace_id = ${ws}::uuid and status = 'posted' and kind = 'regular' and date >= ${from}::date and date <= ${today}::date
    group by 1`.execute(tx);
  const realized: MonthlyFlow[] = Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(from, i);
    const r = rows.rows.find((x) => x.month === month);
    return { month, incomeCents: Number(r?.inc ?? 0), expenseCents: Number(r?.exp ?? 0), projected: false };
  });
  const proj = await computeProjection(tx, ws, { months: 4 });
  const projected = proj.months.slice(1, 4).map((m) => ({
    month: m.month,
    incomeCents: m.incomeCents,
    expenseCents: m.expenseCents + m.cardBillsCents + m.variableCents + m.goalsCents,
    projected: true,
  }));
  return [...realized, ...projected];
}

/** Despesas por categoria: mês atual vs média dos 3 meses anteriores, com orçamento. */
export async function categorySpend(tx: Tx, ws: string, today: string): Promise<CategorySpend[]> {
  const m0 = startOfMonth(today);
  const from = addMonths(m0, -3);
  const rows = await sql<{
    categoryId: string | null;
    name: string | null;
    cur: number;
    prev: number;
    budget: number | null;
  }>`
    select t.category_id as "categoryId", c.name,
      coalesce(sum(case when t.date >= ${m0}::date then t.amount_cents end), 0)::bigint as cur,
      coalesce(sum(case when t.date < ${m0}::date then t.amount_cents end), 0)::bigint as prev,
      (select b.amount_cents from budgets b where b.workspace_id = ${ws}::uuid and b.category_id = t.category_id) as budget
    from transactions t left join categories c on c.id = t.category_id
    where t.workspace_id = ${ws}::uuid and t.direction = 'out' and t.kind = 'regular' and t.status = 'posted'
      and t.date >= ${from}::date and t.date <= ${today}::date
    group by t.category_id, c.name`.execute(tx);
  const budgetsOnly = await sql<{ categoryId: string; name: string; budget: number }>`
    select b.category_id as "categoryId", c.name, b.amount_cents as budget from budgets b join categories c on c.id = b.category_id
    where b.workspace_id = ${ws}::uuid`.execute(tx);
  const out: CategorySpend[] = rows.rows.map((r) => ({
    categoryId: r.categoryId,
    name: r.name ?? 'Sem categoria',
    currentCents: Number(r.cur),
    averageCents: Math.round(Number(r.prev) / 3),
    budgetCents: r.budget !== null ? Number(r.budget) : null,
  }));
  for (const b of budgetsOnly.rows)
    if (!out.some((o) => o.categoryId === b.categoryId))
      out.push({
        categoryId: b.categoryId,
        name: b.name,
        currentCents: 0,
        averageCents: 0,
        budgetCents: Number(b.budget),
      });
  return out.sort((a, b) => b.currentCents - a.currentCents || b.averageCents - a.averageCents);
}

export { buildPortfolio };
