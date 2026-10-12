import { randomUUID } from 'node:crypto';
import {
  addMonths,
  planInstallments,
  splitInstallments,
  startOfMonth,
  todayISO,
  type ISODate,
} from '@sf/shared';
import { dedupeHash } from '@sf/shared/node';
import { sql, type Tx } from '@sf/db';
import type { Actor } from '../context.js';
import { audit } from './audit.js';
import { occurrences } from './recurrence-rule.js';

export interface NewTransaction {
  accountId?: string | null;
  cardId?: string | null;
  date: ISODate;
  amountCents: number;
  direction: 'in' | 'out';
  categoryId?: string | null;
  description: string;
  installments?: number; // >1 gera parcelas (só cartão ou conta)
  /** Parcela inicial (importação de fatura): amountCents passa a ser o valor de cada parcela. */
  installmentStart?: number;
  status?: 'posted' | 'scheduled';
  source?: 'chat' | 'import' | 'recurrence' | 'manual' | 'reminder';
  attachmentId?: string | null;
  confidence?: number | null;
  kind?: 'regular' | 'transfer' | 'card_payment';
  transferId?: string | null;
  paysStatementId?: string | null;
  recurrenceId?: string | null;
}

export async function workspaceToday(tx: Tx, ws: string): Promise<ISODate> {
  const r = await sql<{ d: string }>`select ws_today(${ws}::uuid)::text as d`.execute(tx);
  return r.rows[0]?.d ?? todayISO();
}

/** Insere lançamentos (expandindo parcelas) e registra auditoria. Retorna os ids criados. */
export async function insertTransactions(
  tx: Tx,
  actor: Actor,
  items: NewTransaction[],
  draftId?: string | null,
): Promise<string[]> {
  const today = await workspaceToday(tx, actor.workspaceId);
  const ids: string[] = [];
  for (const it of items) {
    const n = Math.max(1, it.installments ?? 1);
    // Lançamento real de uma conta prevista por recorrência: baixa a ocorrência agendada
    if (n === 1 && it.kind !== 'transfer' && it.kind !== 'card_payment' && !it.recurrenceId && (it.status ?? 'posted') === 'posted' && it.date <= today) {
      const reconciled = await reconcileWithScheduled(tx, actor, it, draftId);
      if (reconciled) {
        ids.push(reconciled);
        continue;
      }
    }
    let rows: Array<{ date: ISODate; amountCents: number; n: number | null }>;
    if (n > 1 && it.installmentStart) {
      rows = [];
      for (let k = it.installmentStart; k <= n; k++)
        rows.push({ date: addMonths(it.date, k - it.installmentStart), amountCents: it.amountCents, n: k });
    } else if (n > 1 && it.cardId) {
      const card = await tx
        .selectFrom('cards')
        .select(['closingDay', 'dueDay'])
        .where('id', '=', it.cardId)
        .executeTakeFirstOrThrow();
      rows = planInstallments(it.date, it.amountCents, n, card.closingDay, card.dueDay).map((p) => ({
        date: p.date,
        amountCents: p.amountCents,
        n: p.n,
      }));
    } else if (n > 1) {
      rows = splitInstallments(it.amountCents, n).map((a, i) => ({
        date: addMonths(it.date, i),
        amountCents: a,
        n: i + 1,
      }));
    } else {
      rows = [{ date: it.date, amountCents: it.amountCents, n: null }];
    }
    const group = n > 1 ? randomUUID() : null;
    const values = rows.map((r) => ({
      workspaceId: actor.workspaceId,
      accountId: it.accountId ?? null,
      cardId: it.cardId ?? null,
      date: r.date,
      amountCents: r.amountCents,
      direction: it.direction,
      kind: it.kind ?? ('regular' as const),
      categoryId: it.categoryId ?? null,
      description: n > 1 ? `${baseDescription(it.description)} (${r.n}/${n})` : it.description,
      status: it.status ?? (r.date > today ? ('scheduled' as const) : ('posted' as const)),
      source: it.source ?? ('chat' as const),
      attachmentId: it.attachmentId ?? null,
      confidence: it.confidence ?? null,
      transferId: it.transferId ?? null,
      paysStatementId: it.paysStatementId ?? null,
      recurrenceId: it.recurrenceId ?? null,
      installmentGroupId: group,
      installmentN: r.n,
      installmentTotal: n > 1 ? n : null,
      // parcelas: hash independe da data (a mesma parcela reaparece em faturas futuras)
      dedupeHash: dedupeHash({
        accountId: it.accountId,
        cardId: it.cardId,
        date: r.n ? `#${r.n}/${n}` : r.date,
        amountCents: r.amountCents,
        direction: it.direction,
        description: r.n ? baseDescription(it.description) : it.description,
      }),
      createdBy: actor.userId,
    }));
    const inserted = await tx.insertInto('transactions').values(values).returningAll().execute();
    for (const row of inserted) {
      ids.push(row.id);
    }
    await audit(tx, actor, {
      action: 'create',
      entity: 'transactions',
      entityId: inserted[0]!.id,
      after:
        inserted.length === 1
          ? inserted[0]
          : { installmentGroupId: group, ids: inserted.map((r) => r.id), first: inserted[0] },
      draftId,
    });
  }
  return ids;
}

/**
 * Procura a ocorrência agendada da mesma recorrência (mesma conta/cartão, sentido e categoria, até
 * 7 dias de distância e valor até 25% diferente) e a marca como paga com os valores reais.
 */
async function reconcileWithScheduled(tx: Tx, actor: Actor, it: NewTransaction, draftId?: string | null): Promise<string | null> {
  if (!it.categoryId) return null;
  const lo = Math.round(it.amountCents * 0.75);
  const hi = Math.round(it.amountCents * 1.25);
  const match = await sql<{ id: string }>`
    select t.id from transactions t
    where t.workspace_id = ${actor.workspaceId}::uuid and t.status = 'scheduled' and t.recurrence_id is not null
      and t.direction = ${it.direction} and t.category_id = ${it.categoryId}::uuid
      and ${it.accountId ? sql`t.account_id = ${it.accountId}::uuid` : sql`t.card_id = ${it.cardId ?? null}::uuid`}
      and t.date between (${it.date}::date - 7) and (${it.date}::date + 7)
      and t.amount_cents between ${lo} and ${hi}
    order by abs(t.date - ${it.date}::date), abs(t.amount_cents - ${it.amountCents}) limit 1`.execute(tx);
  const id = match.rows[0]?.id;
  if (!id) return null;
  const before = await tx.selectFrom('transactions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const after = await tx
    .updateTable('transactions')
    .set({ status: 'posted', date: it.date, amountCents: it.amountCents, source: it.source ?? before.source, attachmentId: it.attachmentId ?? before.attachmentId })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(tx, actor, { action: 'update', entity: 'transactions', entityId: id, before: [before], after: [after], draftId });
  return id;
}

/** "TV 03/10" ou "TV (3/10)" → "TV" */
export function baseDescription(d: string): string {
  return d
    .replace(/\s*\(?\b\d{1,2}\s*\/\s*\d{1,2}\b\)?\s*$/, '')
    .replace(/\s*parc(ela)?\.?\s*\d+\s*(de|\/)\s*\d+\s*$/i, '')
    .trim();
}

export function installmentHash(
  cardOrAccount: { accountId?: string | null; cardId?: string | null },
  description: string,
  perInstallmentCents: number,
  n: number,
  total: number,
  direction: 'in' | 'out' = 'out',
) {
  return dedupeHash({
    ...cardOrAccount,
    date: `#${n}/${total}`,
    amountCents: perInstallmentCents,
    direction,
    description: baseDescription(description),
  });
}

export async function findDuplicates(tx: Tx, ws: string, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const rows = await tx
    .selectFrom('transactions')
    .select('dedupeHash')
    .where('workspaceId', '=', ws)
    .where('dedupeHash', 'in', hashes)
    .execute();
  return new Set(rows.map((r) => r.dedupeHash!).filter(Boolean));
}

/**
 * Materializa as ocorrências futuras de uma recorrência como transações agendadas (horizonte de
 * 25 meses). Remove as agendadas futuras e recria; ocorrências já postadas ou vencidas ficam.
 */
export async function materializeRecurrence(tx: Tx, recurrenceId: string, today?: ISODate): Promise<number> {
  const rec = await tx
    .selectFrom('recurrences')
    .selectAll()
    .where('id', '=', recurrenceId)
    .executeTakeFirst();
  if (!rec) return 0;
  const t = today ?? (await workspaceToday(tx, rec.workspaceId));
  await tx
    .deleteFrom('transactions')
    .where('recurrenceId', '=', rec.id)
    .where('status', '=', 'scheduled')
    .where('date', '>=', t)
    .execute();
  if (rec.pausedAt) return 0;

  const horizon = addMonths(startOfMonth(t), 25);
  const dates = occurrences(rec.rule, rec.startDate, rec.endDate, t, horizon);
  if (!dates.length) return 0;
  const existing = new Set(
    (
      await tx
        .selectFrom('transactions')
        .select('date')
        .where('recurrenceId', '=', rec.id)
        .where('date', 'in', dates)
        .execute()
    ).map((r) => r.date),
  );

  let amount = rec.amountCents;
  if (rec.amountMode === 'average_n_months') {
    const recent = await tx
      .selectFrom('transactions')
      .select('amountCents')
      .where('recurrenceId', '=', rec.id)
      .where('status', '=', 'posted')
      .orderBy('date', 'desc')
      .limit(rec.averageMonths ?? 3)
      .execute();
    if (recent.length) amount = Math.round(recent.reduce((a, r) => a + r.amountCents, 0) / recent.length);
  }

  const rows = dates
    .filter((d) => !existing.has(d))
    .map((d) => ({
      workspaceId: rec.workspaceId,
      accountId: rec.accountId,
      cardId: rec.cardId,
      date: d,
      amountCents: amount,
      direction: rec.direction,
      categoryId: rec.categoryId,
      description: rec.description,
      status: (rec.autoPost && d <= t ? 'posted' : 'scheduled') as 'posted' | 'scheduled',
      source: 'recurrence' as const,
      recurrenceId: rec.id,
      createdBy: rec.createdBy,
      dedupeHash: dedupeHash({
        accountId: rec.accountId,
        cardId: rec.cardId,
        date: d,
        amountCents: amount,
        direction: rec.direction as 'in' | 'out',
        description: rec.description,
      }),
    }));
  if (rows.length) await tx.insertInto('transactions').values(rows).execute();
  return rows.length;
}

/** Posta automaticamente ocorrências vencidas de recorrências com auto_post. */
export async function autoPostDue(tx: Tx, ws: string, today: ISODate): Promise<number> {
  const r = await tx
    .updateTable('transactions')
    .set({ status: 'posted' })
    .where('workspaceId', '=', ws)
    .where('status', '=', 'scheduled')
    .where('date', '<=', today)
    .where('recurrenceId', 'in', (eb) =>
      eb.selectFrom('recurrences').select('id').where('workspaceId', '=', ws).where('autoPost', '=', true),
    )
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}
