import {
  addDays,
  addMonths,
  diffDays,
  normalizeDescription,
  startOfMonth,
  type AccountDTO,
  type CardDTO,
  type CategoryDTO,
  type RecurrenceDTO,
  type StatementDTO,
  type TransactionDTO,
  type UpcomingItem,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { nextOccurrence, ruleText } from './recurrence-rule.js';

export async function listAccounts(
  tx: Tx,
  ws: string,
  today: string,
  includeArchived = false,
): Promise<AccountDTO[]> {
  let q = tx
    .selectFrom('accounts as a')
    .select((eb) => [
      'a.id',
      'a.institution',
      'a.type',
      'a.name',
      'a.openingBalanceCents',
      'a.openingDate',
      'a.isPrivate',
      'a.ownerUserId',
      'a.archivedAt',
      sql<number>`account_balance(a.id, ${today}::date)`.as('balanceCents'),
      eb
        .selectFrom('transactions as t')
        .select(sql<string>`max(t.date)::text`.as('d'))
        .whereRef('t.accountId', '=', 'a.id')
        .where('t.status', '=', 'posted')
        .as('lastActivityDate'),
    ])
    .where('a.workspaceId', '=', ws)
    .orderBy('a.createdAt');
  if (!includeArchived) q = q.where('a.archivedAt', 'is', null);
  const rows = await q.execute();
  return rows.map((r) => {
    const last = r.lastActivityDate ?? r.openingDate;
    return {
      id: r.id,
      institution: r.institution,
      type: r.type as AccountDTO['type'],
      name: r.name,
      openingBalanceCents: r.openingBalanceCents,
      openingDate: r.openingDate,
      isPrivate: r.isPrivate,
      ownerUserId: r.ownerUserId,
      balanceCents: Number(r.balanceCents),
      lastActivityDate: r.lastActivityDate,
      stale: diffDays(today, last) > 30,
      archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
    };
  });
}

export async function listStatements(
  tx: Tx,
  ws: string,
  filter: { cardId?: string; from?: string; to?: string } = {},
): Promise<StatementDTO[]> {
  let q = tx.selectFrom('cardStatementTotals').selectAll().where('workspaceId', '=', ws).orderBy('refMonth');
  if (filter.cardId) q = q.where('cardId', '=', filter.cardId);
  if (filter.from) q = q.where('refMonth', '>=', filter.from);
  if (filter.to) q = q.where('refMonth', '<=', filter.to);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id!,
    cardId: r.cardId!,
    refMonth: r.refMonth!,
    closingDate: r.closingDate!,
    dueDate: r.dueDate!,
    totalCents: Number(r.totalCents ?? 0),
    paidCents: Number(r.paidCents ?? 0),
    reportedTotalCents: r.reportedTotalCents ?? null,
    status: (r.status === 'paid' || (Number(r.paidCents) >= Number(r.totalCents) && Number(r.totalCents) > 0)
      ? 'paid'
      : r.closingDate! <= new Date().toISOString().slice(0, 10)
        ? 'closed'
        : 'open') as StatementDTO['status'],
  }));
}

export async function listCards(tx: Tx, ws: string, today: string): Promise<CardDTO[]> {
  const cards = await tx
    .selectFrom('cards')
    .selectAll()
    .where('workspaceId', '=', ws)
    .where('archivedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
  const statements = await listStatements(tx, ws, { from: addMonths(startOfMonth(today), -2) });
  return cards.map((c) => {
    const mine = statements.filter((s) => s.cardId === c.id);
    const unpaid = mine.filter((s) => s.status !== 'paid');
    const current = mine.find((s) => s.closingDate > today) ?? null;
    return {
      id: c.id,
      name: c.name,
      accountId: c.accountId,
      last4: c.last4,
      holderTag: c.holderTag,
      limitCents: c.limitCents,
      closingDay: c.closingDay,
      dueDay: c.dueDay,
      isPrivate: c.isPrivate,
      usedCents: unpaid.reduce((a, s) => a + Math.max(0, s.totalCents - s.paidCents), 0),
      currentStatement: current,
    };
  });
}

export async function listCategories(tx: Tx, ws: string): Promise<CategoryDTO[]> {
  const rows = await tx
    .selectFrom('categories')
    .select(['id', 'name', 'kind', 'parentId', 'icon', 'color'])
    .where('workspaceId', '=', ws)
    .orderBy('kind')
    .orderBy('name')
    .execute();
  return rows.map((r) => ({ ...r, kind: r.kind as CategoryDTO['kind'] }));
}

export interface TxFilter {
  from?: string | null;
  to?: string | null;
  accountId?: string | null;
  cardId?: string | null;
  categoryId?: string | null;
  categoryIds?: string[] | null;
  text?: string | null;
  direction?: 'in' | 'out' | null;
  status?: 'posted' | 'scheduled' | null;
  includeTransfers?: boolean;
  limit?: number;
  offset?: number;
}

function txQuery(tx: Tx, ws: string, f: TxFilter) {
  let q = tx
    .selectFrom('transactions as t')
    .leftJoin('categories as c', 'c.id', 't.categoryId')
    .where('t.workspaceId', '=', ws);
  if (f.from) q = q.where('t.date', '>=', f.from);
  if (f.to) q = q.where('t.date', '<=', f.to);
  if (f.accountId) q = q.where('t.accountId', '=', f.accountId);
  if (f.cardId) q = q.where('t.cardId', '=', f.cardId);
  if (f.categoryId) q = q.where('t.categoryId', '=', f.categoryId);
  if (f.categoryIds?.length) q = q.where('t.categoryId', 'in', f.categoryIds);
  if (f.direction) q = q.where('t.direction', '=', f.direction);
  if (f.status) q = q.where('t.status', '=', f.status);
  if (!f.includeTransfers) q = q.where('t.kind', '=', 'regular');
  if (f.text) {
    const like = `%${normalizeDescription(f.text)}%`;
    q = q.where((eb) =>
      eb.or([
        eb(sql`normalize_text(t.description)`, 'like', like),
        eb(sql`normalize_text(c.name)`, 'like', like),
      ]),
    );
  }
  return q;
}

export async function queryTransactions(
  tx: Tx,
  ws: string,
  f: TxFilter,
): Promise<{ items: TransactionDTO[]; total: number }> {
  const rows = await txQuery(tx, ws, f)
    .selectAll('t')
    .select('c.name as categoryName')
    .orderBy('t.date', 'desc')
    .orderBy('t.createdAt', 'desc')
    .limit(f.limit ?? 50)
    .offset(f.offset ?? 0)
    .execute();
  const count = await txQuery(tx, ws, f)
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirst();
  return {
    total: count?.n ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      cardId: r.cardId,
      date: r.date,
      amountCents: r.amountCents,
      direction: r.direction as 'in' | 'out',
      kind: r.kind as TransactionDTO['kind'],
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      description: r.description,
      status: r.status as TransactionDTO['status'],
      source: r.source,
      installmentN: r.installmentN,
      installmentTotal: r.installmentTotal,
      installmentGroupId: r.installmentGroupId,
      transferId: r.transferId,
      recurrenceId: r.recurrenceId,
      createdBy: r.createdBy,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}

export async function aggregateTransactions(
  tx: Tx,
  ws: string,
  f: TxFilter,
  by: 'sum' | 'by_category' | 'by_month',
) {
  const base = txQuery(tx, ws, f);
  if (by === 'sum') {
    const r = await base
      .select([
        sql<number>`coalesce(sum(case when t.direction = 'out' then t.amount_cents else 0 end), 0)::bigint`.as(
          'outCents',
        ),
        sql<number>`coalesce(sum(case when t.direction = 'in' then t.amount_cents else 0 end), 0)::bigint`.as(
          'inCents',
        ),
        sql<number>`count(*)::int`.as('count'),
      ])
      .executeTakeFirst();
    return [{ outCents: Number(r?.outCents ?? 0), inCents: Number(r?.inCents ?? 0), count: r?.count ?? 0 }];
  }
  if (by === 'by_category') {
    return base
      .select([
        sql<string>`coalesce(c.name, 'Sem categoria')`.as('category'),
        sql<number>`sum(t.amount_cents)::bigint`.as('cents'),
        sql<number>`count(*)::int`.as('count'),
      ])
      .groupBy(sql`coalesce(c.name, 'Sem categoria')`)
      .orderBy(sql`sum(t.amount_cents)`, 'desc')
      .execute();
  }
  return base
    .select([
      sql<string>`to_char(date_trunc('month', t.date), 'YYYY-MM')`.as('month'),
      sql<number>`coalesce(sum(case when t.direction = 'out' then t.amount_cents else 0 end), 0)::bigint`.as(
        'outCents',
      ),
      sql<number>`coalesce(sum(case when t.direction = 'in' then t.amount_cents else 0 end), 0)::bigint`.as(
        'inCents',
      ),
    ])
    .groupBy(sql`date_trunc('month', t.date)`)
    .orderBy(sql`date_trunc('month', t.date)`)
    .execute();
}

export async function listRecurrences(tx: Tx, ws: string, today: string): Promise<RecurrenceDTO[]> {
  const rows = await tx
    .selectFrom('recurrences')
    .selectAll()
    .where('workspaceId', '=', ws)
    .orderBy('description')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    cardId: r.cardId,
    description: r.description,
    amountCents: r.amountCents,
    direction: r.direction as 'in' | 'out',
    categoryId: r.categoryId,
    rule: r.rule,
    ruleText: ruleText(r.rule),
    startDate: r.startDate,
    endDate: r.endDate,
    amountMode: r.amountMode as RecurrenceDTO['amountMode'],
    autoPost: r.autoPost,
    isBill: r.isBill,
    nextDate: r.pausedAt ? null : nextOccurrence(r.rule, r.startDate, r.endDate, today),
    pausedAt: r.pausedAt ? new Date(r.pausedAt).toISOString() : null,
  }));
}

/** Próximos vencimentos: contas agendadas e faturas nos próximos `days` dias (inclui vencidos não pagos). */
export async function upcoming(tx: Tx, ws: string, today: string, days = 15): Promise<UpcomingItem[]> {
  const until = addDays(today, days);
  const scheduled = await tx
    .selectFrom('transactions as t')
    .leftJoin('accounts as a', 'a.id', 't.accountId')
    .leftJoin('recurrences as r', 'r.id', 't.recurrenceId')
    .select([
      't.id',
      't.date',
      't.description',
      't.amountCents',
      't.direction',
      'a.name as accountName',
      't.recurrenceId',
      'r.isBill',
    ])
    .where('t.workspaceId', '=', ws)
    .where('t.status', '=', 'scheduled')
    .where('t.accountId', 'is not', null)
    .where('t.kind', '<>', 'card_payment')
    .where('t.date', '<=', until)
    .where('t.date', '>=', addDays(today, -30))
    .orderBy('t.date')
    .execute();
  const statements = await sql<{
    id: string;
    dueDate: string;
    cardName: string;
    remaining: number;
    accountName: string | null;
  }>`
    select st.id, st.due_date::text as "dueDate", c.name as "cardName", (st.total_cents - st.paid_cents)::bigint as remaining, a.name as "accountName"
    from card_statement_totals st join cards c on c.id = st.card_id left join accounts a on a.id = c.account_id
    where st.workspace_id = ${ws}::uuid and st.status <> 'paid' and st.total_cents > st.paid_cents
      and st.due_date <= ${until}::date and st.due_date >= ${addDays(today, -30)}::date
    order by st.due_date`.execute(tx);
  const items: UpcomingItem[] = [
    ...scheduled.map((s) => ({
      kind: (s.recurrenceId ? (s.isBill ? 'bill' : 'recurrence') : 'scheduled') as UpcomingItem['kind'],
      id: s.id,
      date: s.date,
      description: s.description,
      amountCents: s.amountCents,
      direction: s.direction as 'in' | 'out',
      accountName: s.accountName,
      canMarkPaid: true,
    })),
    ...statements.rows.map((s) => ({
      kind: 'statement' as const,
      id: s.id,
      date: s.dueDate,
      description: `Fatura ${s.cardName}`,
      amountCents: Number(s.remaining),
      direction: 'out' as const,
      accountName: s.accountName,
      canMarkPaid: true,
    })),
  ];
  return items.sort((a, b) => a.date.localeCompare(b.date));
}
