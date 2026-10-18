import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  descriptionKey,
  normalizeDescription,
  type Currency,
  type DraftDTO,
  type DraftPreview,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import type { Actor } from '../context.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { insertTransactions, materializeRecurrence, workspaceToday } from './ledger.js';
import { PROFILE_PATCH_SCHEMA, upsertProfile } from './profile.js';
import { computeProjection, projectionImpact } from './projection.js';
import { resolveCategory } from './resolve.js';
import { editedScheduleYear, syncSeasonalPlanned } from './seasonal.js';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const cents = z.number().int();

const txItem = z.object({
  accountId: uuid.nullish(),
  cardId: uuid.nullish(),
  date: iso,
  amountCents: cents.positive(),
  direction: z.enum(['in', 'out']),
  categoryId: uuid.nullish(),
  description: z.string().max(200),
  installments: z.number().int().min(1).max(48).optional(),
  installmentStart: z.number().int().min(1).max(48).optional(),
  attachmentId: uuid.nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  status: z.enum(['posted', 'scheduled']).optional(),
  duplicate: z.boolean().optional(),
});

const accountFields = z.object({
  institution: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  type: z.enum(['checking', 'savings', 'investment', 'cash']),
  currency: z.enum(['BRL', 'USD']).default('BRL'),
  openingBalanceCents: cents,
  openingDate: iso,
  isPrivate: z.boolean().default(false),
});

const cardFields = z.object({
  name: z.string().min(1).max(80),
  accountId: uuid.nullish(),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullish(),
  holderTag: z.string().max(60).nullish(),
  limitCents: cents.nonnegative(),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  isPrivate: z.boolean().default(false),
});

const recurrenceFields = z.object({
  accountId: uuid.nullish(),
  cardId: uuid.nullish(),
  description: z.string().min(1).max(120),
  amountCents: cents.positive(),
  direction: z.enum(['in', 'out']),
  categoryId: uuid.nullish(),
  rule: z.string().min(5),
  startDate: iso,
  endDate: iso.nullish(),
  amountMode: z.enum(['fixed', 'average_n_months']).default('fixed'),
  averageMonths: z.number().int().min(2).max(12).nullish(),
  autoPost: z.boolean().default(false),
  isBill: z.boolean().default(false),
});

const goalFields = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['emergency', 'travel', 'purchase', 'other']).default('other'),
  targetCents: cents.positive(),
  savedCents: cents.nonnegative().default(0),
  monthlyContributionCents: cents.nonnegative().default(0),
  startMonth: iso,
  targetDate: iso.nullish(),
});

const seasonalEntry = z.object({
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  amountCents: cents.nonnegative(),
});

const tradeItem = z.object({
  assetId: uuid,
  broker: z.string().max(60).nullish(),
  date: iso,
  kind: z.enum(['buy', 'sell', 'dividend', 'jcp', 'contribution', 'redemption', 'split', 'valuation']),
  qty: z.number(),
  priceCents: cents,
  feesCents: cents.nonnegative().default(0),
  totalCents: cents,
  fxRate: z.number().positive().nullish(),
  attachmentId: uuid.nullish(),
  dedupeHash: z.string().nullish(),
});

/** Schemas dos payloads por tipo de draft. O payload já vem com ids resolvidos. */
export const DRAFT_SCHEMAS = {
  transactions: z.object({
    items: z.array(txItem).min(1).max(500),
    // 'manual' = formulário da tela (sem categoria escolhida, aplica as regras de categorização)
    source: z.enum(['chat', 'manual']).optional(),
  }),
  transfer: z.object({
    fromAccountId: uuid,
    toAccountId: uuid,
    amountCents: cents.positive(),
    // Valor recebido na moeda da conta de destino; obrigatório entre moedas diferentes (câmbio)
    toAmountCents: cents.positive().nullish(),
    date: iso,
    description: z.string().max(200),
    status: z.enum(['posted', 'scheduled']).optional(),
  }),
  recurrence: z.object({ mode: z.enum(['create', 'update']), id: uuid.nullish(), fields: recurrenceFields }),
  account: z.object({ mode: z.enum(['create', 'update']), id: uuid.nullish(), fields: accountFields }),
  card: z.object({ mode: z.enum(['create', 'update']), id: uuid.nullish(), fields: cardFields }),
  pension_entry: z.object({
    planId: uuid.nullish(),
    newPlan: z.object({ provider: z.string(), name: z.string() }).nullish(),
    refMonth: iso,
    balanceCents: cents,
    participantCents: cents.nonnegative().default(0),
    sponsorCents: cents.nonnegative().default(0),
    attachmentId: uuid.nullish(),
  }),
  // Perfil de aposentadoria do próprio usuário (payload completo; quem chama junta com o atual)
  retirement_profile: z.object({
    birthDate: iso,
    retireAge: z.number().int().min(30).max(90),
    endAge: z.number().int().min(50).max(110),
    accumulationRate: z.number().min(-0.05).max(0.2),
    withdrawalRate: z.number().min(-0.05).max(0.2),
    contributionGrowth: z.number().min(-0.1).max(0.1),
    inssMonthlyCents: cents.nonnegative().nullish(),
    targetIncomeCents: cents.positive().nullish(),
    includeInvestments: z.boolean(),
  }),
  edit: z.object({
    transactionIds: z.array(uuid).min(1),
    changes: z.object({
      amountCents: cents.positive().optional(),
      date: iso.optional(),
      description: z.string().max(200).optional(),
      categoryId: uuid.optional(),
      accountId: uuid.optional(),
      cardId: uuid.optional(),
      status: z.enum(['posted', 'scheduled']).optional(),
    }),
    learnRule: z.object({ pattern: z.string().min(2), categoryId: uuid }).nullish(),
  }),
  delete: z.object({
    entity: z.enum(['transactions', 'recurrences', 'accounts', 'cards', 'goals', 'budgets']),
    ids: z.array(uuid).min(1).max(1000),
  }),
  settings: z.object({
    workspace: z
      .object({
        balanceFloorCents: cents.optional(),
        variableMonthlyCents: cents.nonnegative().optional(),
        variableWindowMonths: z.number().int().min(3).max(6).optional(),
        optimisticFactor: z.number().positive().optional(),
        pessimisticFactor: z.number().positive().optional(),
        quietStart: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        quietEnd: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        reminderTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        emergencyMonthsTarget: z.number().positive().optional(),
        usdMinPct: z.number().min(0).max(100).nullish(),
        usdMaxPct: z.number().min(0).max(100).nullish(),
      })
      .optional(),
    reminderPrefs: z.array(z.object({ kind: z.string(), enabled: z.boolean() })).optional(),
  }),
  import: z.object({
    attachmentId: uuid,
    items: z.array(txItem).max(1000),
    skipDuplicates: z.boolean().default(true),
    statement: z.object({ cardId: uuid, refMonth: iso, reportedTotalCents: cents }).nullish(),
  }),
  card_payment: z.object({ statementId: uuid, accountId: uuid, amountCents: cents.positive(), date: iso }),
  mark_paid: z.object({ transactionId: uuid, date: iso, amountCents: cents.positive().optional() }),
  trades: z.object({ trades: z.array(tradeItem).min(1).max(200) }),
  allocation_targets: z.object({
    targets: z.array(
      z.object({
        assetClass: z.enum(['fixed_income', 'equities', 'funds', 'usd', 'pension', 'cash', 'crypto']),
        targetPct: z.number().min(0).max(100),
        minPct: z.number().nullish(),
        maxPct: z.number().nullish(),
      }),
    ),
  }),
  budget: z.object({
    categoryId: uuid,
    amountCents: cents.positive(),
    alertPct: z.number().int().min(1).max(200).default(100),
  }),
  goal: z.object({ mode: z.enum(['create', 'update']), id: uuid.nullish(), fields: goalFields }),
  // Calendário: confirmar (entra na projeção), editar valor/agenda (também confirma), ignorar ou criar à mão
  seasonal: z.object({
    mode: z.enum(['confirm', 'edit', 'dismiss', 'create']),
    id: uuid.nullish(),
    fields: z
      .object({
        label: z.string().min(1).max(80).optional(),
        direction: z.enum(['in', 'out']).optional(),
        categoryId: uuid.nullish(),
        schedule: z.array(seasonalEntry).min(1).max(12).optional(),
        leadDays: z.number().int().min(7).max(120).optional(),
        matchPattern: z.string().max(80).nullish(),
      })
      .default({}),
  }),
  undo: z.object({ auditId: z.number().int() }),
  // Perfil financeiro do próprio usuário (patch: só os campos informados mudam)
  financial_profile: PROFILE_PATCH_SCHEMA,
} as const;

export type DraftKind = keyof typeof DRAFT_SCHEMAS;
export type DraftPayload<K extends DraftKind> = z.infer<(typeof DRAFT_SCHEMAS)[K]>;

/** Rótulos para o resumo final. */
const DONE: Record<DraftKind, string> = {
  transactions: 'Lançamento registrado.',
  transfer: 'Transferência registrada.',
  recurrence: 'Recorrência salva.',
  account: 'Conta salva.',
  card: 'Cartão salvo.',
  pension_entry: 'Extrato da previdência registrado.',
  retirement_profile: 'Perfil de aposentadoria salvo.',
  edit: 'Lançamento corrigido.',
  delete: 'Removido.',
  settings: 'Preferências atualizadas.',
  import: 'Importação concluída.',
  card_payment: 'Pagamento da fatura registrado.',
  mark_paid: 'Marcado como pago.',
  trades: 'Operações registradas.',
  allocation_targets: 'Alocação-alvo salva.',
  budget: 'Orçamento salvo.',
  goal: 'Meta salva.',
  seasonal: 'Calendário atualizado.',
  undo: 'Desfeito.',
  financial_profile: 'Perfil financeiro atualizado.',
};

// Tipos que mexem na projeção (vale a pena calcular o impacto na prévia)
const AFFECTS_PROJECTION = new Set<DraftKind>([
  'transactions',
  'transfer',
  'recurrence',
  'account',
  'card',
  'edit',
  'delete',
  'import',
  'card_payment',
  'mark_paid',
  'goal',
  'seasonal',
  'settings',
  'undo',
]);

export function toDraftDTO(row: {
  id: string;
  kind: string;
  status: string;
  preview: unknown;
  expiresAt: Date | string;
}): DraftDTO {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as DraftDTO['status'],
    preview: row.preview as DraftPreview,
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

/**
 * Cria um draft (escrita pendente). Valida o payload e calcula o impacto na projeção aplicando
 * a escrita dentro de um savepoint que é desfeito em seguida.
 */
export async function createDraft<K extends DraftKind>(
  tx: Tx,
  actor: Actor,
  kind: K,
  payload: DraftPayload<K>,
  preview: DraftPreview,
  conversationId?: string | null,
  opts: { computeImpact?: boolean } = {},
): Promise<DraftDTO> {
  if (actor.role === 'viewer') throw forbidden('Seu papel neste workspace é só leitura.');
  const parsed = DRAFT_SCHEMAS[kind].parse(payload) as DraftPayload<K>;

  if (AFFECTS_PROJECTION.has(kind) && opts.computeImpact !== false) {
    try {
      const before = await computeProjection(tx, actor.workspaceId);
      await sql`savepoint draft_preview`.execute(tx);
      try {
        await applyDraft(tx, actor, kind, parsed, null);
        const after = await computeProjection(tx, actor.workspaceId);
        preview.projectionImpact = projectionImpact(before, after);
      } finally {
        await sql`rollback to savepoint draft_preview`.execute(tx);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Prévia sem impacto é aceitável; o erro reaparece (e é tratado) na confirmação.
      preview.warnings.push('Não foi possível calcular o efeito na projeção.');
    }
  }

  const row = await tx
    .insertInto('drafts')
    .values({
      workspaceId: actor.workspaceId,
      conversationId: conversationId ?? null,
      createdBy: actor.userId,
      kind,
      payload: JSON.stringify(parsed),
      preview: JSON.stringify(preview),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toDraftDTO(row);
}

export interface CommitResult {
  summary: string;
  impact: string | null;
  ids: string[];
}

/** Confirma um draft: aplica a escrita, audita e devolve o efeito na projeção. */
export async function confirmDraft(tx: Tx, actor: Actor, draftId: string): Promise<CommitResult> {
  if (actor.role === 'viewer') throw forbidden('Seu papel neste workspace é só leitura.');
  const draft = await tx
    .selectFrom('drafts')
    .selectAll()
    .where('id', '=', draftId)
    .forUpdate()
    .executeTakeFirst();
  if (!draft || draft.workspaceId !== actor.workspaceId) throw notFound('Rascunho');
  if (draft.status !== 'pending') throw new AppError(409, 'Este rascunho já foi decidido.', 'draft_decided');
  if (new Date(draft.expiresAt) < new Date()) {
    await tx
      .updateTable('drafts')
      .set({ status: 'expired', decidedAt: new Date() })
      .where('id', '=', draftId)
      .execute();
    throw new AppError(410, 'Este rascunho expirou. Peça de novo.', 'draft_expired');
  }
  const kind = draft.kind as DraftKind;
  const payload = DRAFT_SCHEMAS[kind].parse(draft.payload);

  const before = AFFECTS_PROJECTION.has(kind) ? await computeProjection(tx, actor.workspaceId) : null;
  const ids = await applyDraft(tx, actor, kind, payload as never, draftId);
  const after = before ? await computeProjection(tx, actor.workspaceId) : null;
  const impact = before && after ? projectionImpact(before, after) : null;

  const result = { summary: DONE[kind], impact, ids };
  await tx
    .updateTable('drafts')
    .set({ status: 'confirmed', decidedAt: new Date(), result: JSON.stringify(result) })
    .where('id', '=', draftId)
    .execute();
  await settleNudge(tx, draftId, 'accepted');
  return result;
}

/** Sugestão proativa ligada ao draft: confirmar aceita, cancelar dispensa (vale em qualquer canal). */
async function settleNudge(tx: Tx, draftId: string, status: 'accepted' | 'dismissed') {
  await tx
    .updateTable('agentNudges')
    .set({ status, respondedAt: new Date() })
    .where('draftId', '=', draftId)
    .where('status', 'in', ['candidate', 'scheduled', 'delivered', 'snoozed'])
    .execute();
}

export async function cancelDraft(tx: Tx, actor: Actor, draftId: string): Promise<void> {
  const r = await tx
    .updateTable('drafts')
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where('id', '=', draftId)
    .where('workspaceId', '=', actor.workspaceId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0)
    throw new AppError(409, 'Este rascunho já foi decidido.', 'draft_decided');
  await settleNudge(tx, draftId, 'dismissed');
}

/** Último draft pendente do usuário na conversa (para confirmações por texto no WhatsApp). */
export async function latestPendingDraft(tx: Tx, actor: Actor, conversationId: string) {
  return tx
    .selectFrom('drafts')
    .selectAll()
    .where('workspaceId', '=', actor.workspaceId)
    .where('conversationId', '=', conversationId)
    .where('status', '=', 'pending')
    .where('expiresAt', '>', new Date())
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Aplicação de cada tipo
// ---------------------------------------------------------------------------

async function applyDraft<K extends DraftKind>(
  tx: Tx,
  actor: Actor,
  kind: K,
  p: DraftPayload<K>,
  draftId: string | null,
): Promise<string[]> {
  const ws = actor.workspaceId;
  switch (kind) {
    case 'transactions': {
      const { items, source = 'chat' } = p as DraftPayload<'transactions'>;
      for (const i of items) {
        if (!i.accountId === !i.cardId) throw new AppError(422, 'Escolha uma conta ou um cartão.');
        if (source === 'manual' && !i.categoryId) i.categoryId = (await resolveCategory(tx, ws, i)).id;
      }
      return insertTransactions(
        tx,
        actor,
        items.map((i) => ({ ...i, source })),
        draftId,
      );
    }
    case 'import': {
      const { items, skipDuplicates, attachmentId, statement } = p as DraftPayload<'import'>;
      const chosen = items.filter((i) => !(skipDuplicates && i.duplicate));
      const ids = await insertTransactions(
        tx,
        actor,
        chosen.map((i) => ({ ...i, source: 'import' as const, attachmentId })),
        draftId,
      );
      await tx
        .updateTable('attachments')
        .set({ status: 'imported' })
        .where('id', '=', attachmentId)
        .execute();
      if (statement) {
        await tx
          .updateTable('cardStatements')
          .set({ reportedTotalCents: statement.reportedTotalCents })
          .where('cardId', '=', statement.cardId)
          .where('refMonth', '=', statement.refMonth)
          .execute();
      }
      return ids;
    }
    case 'transfer': {
      const t = p as DraftPayload<'transfer'>;
      if (t.fromAccountId === t.toAccountId)
        throw new AppError(422, 'Escolha contas diferentes para a transferência.');
      const [fromCur, toCur] = [
        await accountCurrency(tx, t.fromAccountId),
        await accountCurrency(tx, t.toAccountId),
      ];
      if (fromCur !== toCur && !t.toAmountCents)
        throw new AppError(
          422,
          'Transferência entre moedas diferentes: informe o valor recebido no destino.',
        );
      const transferId = randomUUID();
      const base = {
        date: t.date,
        amountCents: t.amountCents,
        description: t.description,
        kind: 'transfer' as const,
        transferId,
        status: t.status,
      };
      return insertTransactions(
        tx,
        actor,
        [
          { ...base, accountId: t.fromAccountId, direction: 'out' },
          {
            ...base,
            accountId: t.toAccountId,
            direction: 'in',
            amountCents: fromCur !== toCur ? t.toAmountCents! : t.amountCents,
          },
        ],
        draftId,
      );
    }
    case 'card_payment': {
      const t = p as DraftPayload<'card_payment'>;
      await assertBRLAccount(tx, t.accountId, 'A fatura do cartão precisa ser paga por uma conta em reais.');
      const st = await tx
        .selectFrom('cardStatements')
        .innerJoin('cards', 'cards.id', 'cardStatements.cardId')
        .select(['cards.name', 'cardStatements.refMonth'])
        .where('cardStatements.id', '=', t.statementId)
        .executeTakeFirstOrThrow();
      const ids = await insertTransactions(
        tx,
        actor,
        [
          {
            accountId: t.accountId,
            date: t.date,
            amountCents: t.amountCents,
            direction: 'out',
            kind: 'card_payment',
            paysStatementId: t.statementId,
            description: `Fatura ${st.name} ${st.refMonth.slice(0, 7)}`,
          },
        ],
        draftId,
      );
      const tot = await sql<{
        remaining: number;
      }>`select (total_cents - paid_cents)::bigint as remaining from card_statement_totals where id = ${t.statementId}::uuid`.execute(
        tx,
      );
      if ((tot.rows[0]?.remaining ?? 1) <= 0)
        await tx
          .updateTable('cardStatements')
          .set({ status: 'paid' })
          .where('id', '=', t.statementId)
          .execute();
      return ids;
    }
    case 'mark_paid': {
      const t = p as DraftPayload<'mark_paid'>;
      const before = await tx
        .selectFrom('transactions')
        .selectAll()
        .where('id', '=', t.transactionId)
        .executeTakeFirst();
      if (!before) throw notFound('Lançamento');
      const after = await tx
        .updateTable('transactions')
        .set({ status: 'posted', date: t.date, ...(t.amountCents ? { amountCents: t.amountCents } : {}) })
        .where('id', '=', t.transactionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, {
        action: 'update',
        entity: 'transactions',
        entityId: after.id,
        before: [before],
        after: [after],
        draftId,
      });
      return [after.id];
    }
    case 'edit': {
      const t = p as DraftPayload<'edit'>;
      const before = await tx
        .selectFrom('transactions')
        .selectAll()
        .where('id', 'in', t.transactionIds)
        .execute();
      if (before.length !== t.transactionIds.length) throw notFound('Lançamento');
      const legs = before.filter((b) => b.transferId);
      if (legs.length && (t.changes.accountId || t.changes.cardId || t.changes.categoryId))
        throw new AppError(
          422,
          'Transferência não tem categoria nem troca de conta. Apague e faça de novo entre as contas certas.',
        );
      if (t.changes.accountId || t.changes.cardId) {
        const target = t.changes.accountId ? await accountCurrency(tx, t.changes.accountId) : 'BRL';
        for (const b of before) {
          const current = b.accountId ? await accountCurrency(tx, b.accountId) : 'BRL';
          if (current !== target)
            throw new AppError(422, 'Não dá para mover um lançamento entre contas de moedas diferentes.');
        }
      }
      const after = [];
      for (const b of before) {
        const changes = { ...t.changes } as Record<string, unknown>;
        // Ao mudar o valor de uma parcela, mantém o rótulo "(n/N)" e altera só aquela linha
        if (t.changes.accountId) changes.cardId = null;
        if (t.changes.cardId) changes.accountId = null;
        after.push(
          await tx
            .updateTable('transactions')
            .set(changes)
            .where('id', '=', b.id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
      // Transferência anda em par: data, descrição e status vão para a outra perna; o valor só
      // quando as duas contas têm a mesma moeda (entre moedas o valor recebido é outro)
      const partners = legs.length
        ? await tx
            .selectFrom('transactions')
            .selectAll()
            .where(
              'transferId',
              'in',
              legs.map((l) => l.transferId!),
            )
            .where('id', 'not in', t.transactionIds)
            .execute()
        : [];
      for (const pr of partners) {
        const leg = legs.find((l) => l.transferId === pr.transferId)!;
        const changes: Record<string, unknown> = {};
        if (t.changes.date) changes.date = t.changes.date;
        if (t.changes.description !== undefined) changes.description = t.changes.description;
        if (t.changes.status) changes.status = t.changes.status;
        if (
          t.changes.amountCents &&
          (await accountCurrency(tx, leg.accountId!)) === (await accountCurrency(tx, pr.accountId!))
        )
          changes.amountCents = t.changes.amountCents;
        if (!Object.keys(changes).length) continue;
        before.push(pr);
        after.push(
          await tx
            .updateTable('transactions')
            .set(changes)
            .where('id', '=', pr.id)
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
      await audit(tx, actor, {
        action: 'update',
        entity: 'transactions',
        entityId: before[0]!.id,
        before,
        after,
        draftId,
      });
      if (t.learnRule) await learnCategoryRule(tx, ws, t.learnRule.pattern, t.learnRule.categoryId);
      return after.map((a) => a.id);
    }
    case 'delete': {
      const t = p as DraftPayload<'delete'>;
      const table = t.entity;
      const rows = await tx
        .selectFrom(table)
        .selectAll()
        .where('id', 'in', t.ids)
        .where('workspaceId', '=', ws)
        .execute();
      if (!rows.length) throw notFound();
      if (table === 'transactions') {
        // transferências saem em par
        const transferIds = (rows as Array<{ transferId: string | null }>)
          .map((r) => r.transferId)
          .filter(Boolean) as string[];
        if (transferIds.length) {
          const pairs = await tx
            .selectFrom('transactions')
            .selectAll()
            .where('transferId', 'in', transferIds)
            .execute();
          for (const pr of pairs) if (!rows.some((r) => r.id === pr.id)) (rows as unknown[]).push(pr);
        }
      }
      if (table === 'accounts' || table === 'cards') {
        await tx
          .updateTable(table)
          .set({ archivedAt: new Date() })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        await audit(tx, actor, {
          action: 'archive',
          entity: table,
          entityId: rows[0]!.id,
          before: rows,
          draftId,
        });
      } else {
        await tx
          .deleteFrom(table)
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        await audit(tx, actor, {
          action: 'delete',
          entity: table,
          entityId: rows[0]!.id,
          before: rows,
          draftId,
        });
      }
      return rows.map((r) => r.id);
    }
    case 'recurrence': {
      const t = p as DraftPayload<'recurrence'>;
      let id: string;
      if (t.mode === 'create') {
        const row = await tx
          .insertInto('recurrences')
          .values({ ...t.fields, workspaceId: ws, createdBy: actor.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
        id = row.id;
        await audit(tx, actor, {
          action: 'create',
          entity: 'recurrences',
          entityId: id,
          after: row,
          draftId,
        });
      } else {
        const before = await tx
          .selectFrom('recurrences')
          .selectAll()
          .where('id', '=', t.id!)
          .executeTakeFirst();
        if (!before) throw notFound('Recorrência');
        const row = await tx
          .updateTable('recurrences')
          .set(t.fields)
          .where('id', '=', t.id!)
          .returningAll()
          .executeTakeFirstOrThrow();
        id = row.id;
        await audit(tx, actor, {
          action: 'update',
          entity: 'recurrences',
          entityId: id,
          before: [before],
          after: [row],
          draftId,
        });
      }
      await materializeRecurrence(tx, id, await workspaceToday(tx, ws));
      return [id];
    }
    case 'account': {
      const t = p as DraftPayload<'account'>;
      const fields = { ...t.fields, ownerUserId: t.fields.isPrivate ? actor.userId : null };
      if (fields.currency === 'USD') {
        const ptax = await tx
          .selectFrom('benchmarks')
          .select('date')
          .where('series', '=', 'PTAX_USD')
          .executeTakeFirst();
        if (!ptax)
          throw new AppError(422, 'A cotação do dólar ainda não foi carregada. Tente de novo mais tarde.');
      }
      if (t.mode === 'create') {
        const row = await tx
          .insertInto('accounts')
          .values({ ...fields, workspaceId: ws, createdBy: actor.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, {
          action: 'create',
          entity: 'accounts',
          entityId: row.id,
          after: row,
          draftId,
        });
        return [row.id];
      }
      const before = await tx.selectFrom('accounts').selectAll().where('id', '=', t.id!).executeTakeFirst();
      if (!before) throw notFound('Conta');
      if (before.currency !== fields.currency) {
        const used = await tx
          .selectFrom('transactions')
          .select('id')
          .where('accountId', '=', before.id)
          .executeTakeFirst();
        if (used) throw new AppError(422, 'Não dá para trocar a moeda de uma conta que já tem lançamentos.');
        const card = await tx
          .selectFrom('cards')
          .select('id')
          .where('accountId', '=', before.id)
          .executeTakeFirst();
        if (card)
          throw new AppError(422, 'Esta conta paga a fatura de um cartão e precisa continuar em reais.');
      }
      const row = await tx
        .updateTable('accounts')
        .set(fields)
        .where('id', '=', t.id!)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, {
        action: 'update',
        entity: 'accounts',
        entityId: row.id,
        before: [before],
        after: [row],
        draftId,
      });
      return [row.id];
    }
    case 'card': {
      const t = p as DraftPayload<'card'>;
      const fields = { ...t.fields, ownerUserId: t.fields.isPrivate ? actor.userId : null };
      if (fields.accountId)
        await assertBRLAccount(
          tx,
          fields.accountId,
          'A conta que paga a fatura do cartão precisa ser em reais.',
        );
      if (t.mode === 'create') {
        const row = await tx
          .insertInto('cards')
          .values({ ...fields, workspaceId: ws, createdBy: actor.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, { action: 'create', entity: 'cards', entityId: row.id, after: row, draftId });
        return [row.id];
      }
      const before = await tx.selectFrom('cards').selectAll().where('id', '=', t.id!).executeTakeFirst();
      if (!before) throw notFound('Cartão');
      const row = await tx
        .updateTable('cards')
        .set(fields)
        .where('id', '=', t.id!)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (before.closingDay !== row.closingDay || before.dueDay !== row.dueDay) {
        // Reatribui faturas futuras com o novo ciclo
        await tx
          .updateTable('transactions')
          .set({ cardStatementId: null })
          .where('cardId', '=', row.id)
          .where('date', '>=', await workspaceToday(tx, ws))
          .execute();
      }
      await audit(tx, actor, {
        action: 'update',
        entity: 'cards',
        entityId: row.id,
        before: [before],
        after: [row],
        draftId,
      });
      return [row.id];
    }
    case 'pension_entry': {
      const t = p as DraftPayload<'pension_entry'>;
      let planId = t.planId ?? null;
      if (!planId && t.newPlan) {
        const plan = await tx
          .insertInto('pensionPlans')
          .values({
            workspaceId: ws,
            provider: t.newPlan.provider,
            name: t.newPlan.name,
            ownerUserId: actor.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        planId = plan.id;
        await audit(tx, actor, {
          action: 'create',
          entity: 'pension_plans',
          entityId: plan.id,
          after: plan,
          draftId,
        });
      }
      if (!planId) throw new AppError(422, 'Informe o plano de previdência.');
      const row = await tx
        .insertInto('pensionEntries')
        .values({
          workspaceId: ws,
          planId,
          refMonth: t.refMonth,
          balanceCents: t.balanceCents,
          contribParticipantCents: t.participantCents,
          contribSponsorCents: t.sponsorCents,
          attachmentId: t.attachmentId ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['planId', 'refMonth']).doUpdateSet({
            balanceCents: t.balanceCents,
            contribParticipantCents: t.participantCents,
            contribSponsorCents: t.sponsorCents,
            attachmentId: t.attachmentId ?? null,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, {
        action: 'upsert',
        entity: 'pension_entries',
        entityId: row.id,
        after: row,
        draftId,
      });
      return [row.id];
    }
    case 'retirement_profile': {
      const t = p as DraftPayload<'retirement_profile'>;
      if (t.endAge <= t.retireAge)
        throw new AppError(422, 'A idade final precisa ser maior que a de aposentadoria.');
      const fields = {
        ...t,
        inssMonthlyCents: t.inssMonthlyCents ?? null,
        targetIncomeCents: t.targetIncomeCents ?? null,
      };
      // userId sempre do ator: cada um grava só o próprio perfil
      await tx
        .insertInto('retirementProfiles')
        .values({ ...fields, workspaceId: ws, userId: actor.userId })
        .onConflict((oc) => oc.columns(['workspaceId', 'userId']).doUpdateSet(fields))
        .execute();
      // O log é visível ao workspace: data de nascimento fica de fora
      const { birthDate: _birthDate, ...safe } = fields;
      await audit(tx, actor, { action: 'upsert', entity: 'retirement_profiles', after: safe, draftId });
      return [];
    }
    case 'financial_profile': {
      const t = p as DraftPayload<'financial_profile'>;
      await upsertProfile(tx, actor, t);
      // O log é visível ao workspace: só registra quais campos mudaram
      await audit(tx, actor, {
        action: 'upsert',
        entity: 'user_financial_profiles',
        after: { fields: Object.keys(t) },
        draftId,
      });
      return [];
    }
    case 'settings': {
      const t = p as DraftPayload<'settings'>;
      if (t.workspace && Object.keys(t.workspace).length) {
        const before = await tx
          .selectFrom('workspaceSettings')
          .selectAll()
          .where('workspaceId', '=', ws)
          .executeTakeFirst();
        const after = await tx
          .updateTable('workspaceSettings')
          .set(t.workspace)
          .where('workspaceId', '=', ws)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, { action: 'update', entity: 'workspace_settings', before, after, draftId });
      }
      for (const pref of t.reminderPrefs ?? []) {
        await tx
          .insertInto('reminderPrefs')
          .values({ workspaceId: ws, userId: actor.userId, kind: pref.kind, enabled: pref.enabled })
          .onConflict((oc) =>
            oc.columns(['workspaceId', 'userId', 'kind']).doUpdateSet({ enabled: pref.enabled }),
          )
          .execute();
      }
      return [];
    }
    case 'trades': {
      const t = p as DraftPayload<'trades'>;
      const rows = await tx
        .insertInto('trades')
        .values(t.trades.map((tr) => ({ ...tr, workspaceId: ws, createdBy: actor.userId })))
        .returningAll()
        .execute();
      await audit(tx, actor, {
        action: 'create',
        entity: 'trades',
        entityId: rows[0]!.id,
        after: rows,
        draftId,
      });
      return rows.map((r) => r.id);
    }
    case 'allocation_targets': {
      const t = p as DraftPayload<'allocation_targets'>;
      for (const target of t.targets) {
        await tx
          .insertInto('allocationTargets')
          .values({ workspaceId: ws, ...target })
          .onConflict((oc) =>
            oc.columns(['workspaceId', 'assetClass']).doUpdateSet({
              targetPct: target.targetPct,
              minPct: target.minPct ?? null,
              maxPct: target.maxPct ?? null,
            }),
          )
          .execute();
      }
      await audit(tx, actor, { action: 'upsert', entity: 'allocation_targets', after: t.targets, draftId });
      return [];
    }
    case 'budget': {
      const t = p as DraftPayload<'budget'>;
      const row = await tx
        .insertInto('budgets')
        .values({ workspaceId: ws, ...t })
        .onConflict((oc) =>
          oc
            .columns(['workspaceId', 'categoryId'])
            .doUpdateSet({ amountCents: t.amountCents, alertPct: t.alertPct }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, { action: 'upsert', entity: 'budgets', entityId: row.id, after: row, draftId });
      return [row.id];
    }
    case 'goal': {
      const t = p as DraftPayload<'goal'>;
      if (t.mode === 'create') {
        const row = await tx
          .insertInto('goals')
          .values({ ...t.fields, workspaceId: ws })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, { action: 'create', entity: 'goals', entityId: row.id, after: row, draftId });
        return [row.id];
      }
      const before = await tx.selectFrom('goals').selectAll().where('id', '=', t.id!).executeTakeFirst();
      if (!before) throw notFound('Meta');
      const row = await tx
        .updateTable('goals')
        .set(t.fields)
        .where('id', '=', t.id!)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, actor, {
        action: 'update',
        entity: 'goals',
        entityId: row.id,
        before: [before],
        after: [row],
        draftId,
      });
      return [row.id];
    }
    case 'seasonal': {
      const t = p as DraftPayload<'seasonal'>;
      const f = t.fields;
      const today = await workspaceToday(tx, ws);
      let id: string;
      if (t.mode === 'create') {
        if (!f.label || !f.direction || !f.schedule)
          throw new AppError(422, 'Faltou o nome, o valor ou o mês do item.');
        const row = await tx
          .insertInto('seasonalItems')
          .values({
            workspaceId: ws,
            key: `manual:${randomUUID().slice(0, 8)}`,
            label: f.label,
            kind: f.direction === 'in' ? 'income' : 'expense',
            direction: f.direction,
            categoryId: f.categoryId ?? null,
            matchPattern: normalizeDescription(f.matchPattern ?? f.label) || null,
            schedule: JSON.stringify(f.schedule),
            leadDays: f.leadDays ?? 30,
            confidence: 'alta',
            status: 'confirmed',
            source: 'manual',
            confirmedAt: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, {
          action: 'create',
          entity: 'seasonal_items',
          entityId: row.id,
          after: row,
          draftId,
        });
        id = row.id;
      } else {
        const before = await tx
          .selectFrom('seasonalItems')
          .selectAll()
          .where('id', '=', t.id!)
          .executeTakeFirst();
        if (!before || before.workspaceId !== ws) throw notFound('Item do calendário');
        const set: Record<string, unknown> =
          t.mode === 'dismiss'
            ? { status: 'dismissed' }
            : { status: 'confirmed', confirmedAt: before.confirmedAt ?? new Date() };
        if (t.mode !== 'dismiss') {
          if (f.label) set.label = f.label;
          if (f.leadDays) set.leadDays = f.leadDays;
          if (f.categoryId !== undefined) set.categoryId = f.categoryId;
          if (f.schedule) {
            set.schedule = JSON.stringify(f.schedule);
            set.scheduleYear = editedScheduleYear(f.schedule, today);
          }
        }
        const row = await tx
          .updateTable('seasonalItems')
          .set({ ...set, updatedAt: new Date() })
          .where('id', '=', before.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(tx, actor, {
          action: 'update',
          entity: 'seasonal_items',
          entityId: row.id,
          before: [before],
          after: [row],
          draftId,
        });
        id = row.id;
      }
      await syncSeasonalPlanned(tx, ws, today);
      return [id];
    }
    case 'undo':
      return undoAudit(tx, actor, (p as DraftPayload<'undo'>).auditId, draftId);
  }
  throw new AppError(400, `Tipo de rascunho desconhecido: ${String(kind)}`);
}

const UNDOABLE = new Set(['transactions', 'recurrences', 'accounts', 'cards', 'goals', 'budgets', 'trades']);

/** Desfaz uma entrada de auditoria (create → apaga; update → restaura; delete → recria). */
async function accountCurrency(tx: Tx, accountId: string): Promise<Currency> {
  const row = await tx
    .selectFrom('accounts')
    .select('currency')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw notFound('Conta');
  return row.currency as Currency;
}

async function assertBRLAccount(tx: Tx, accountId: string, message: string) {
  if ((await accountCurrency(tx, accountId)) !== 'BRL') throw new AppError(422, message);
}

async function undoAudit(tx: Tx, actor: Actor, auditId: number, draftId: string | null): Promise<string[]> {
  const entry = await tx
    .selectFrom('auditLog')
    .selectAll()
    .where('id', '=', auditId)
    .where('workspaceId', '=', actor.workspaceId)
    .executeTakeFirst();
  if (!entry) throw notFound('Ação');
  if (entry.undoneAt) throw new AppError(409, 'Esta ação já foi desfeita.');
  if (!UNDOABLE.has(entry.entity))
    throw new AppError(422, 'Esta ação não pode ser desfeita automaticamente.');
  const table = entry.entity as
    'transactions' | 'recurrences' | 'accounts' | 'cards' | 'goals' | 'budgets' | 'trades';
  const asRows = (v: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(v) ? v : v ? [v] : []) as Array<Record<string, unknown>>;
  const touched: string[] = [];

  if (entry.action === 'create') {
    const after = entry.after as Record<string, unknown> | Array<Record<string, unknown>> | null;
    const ids = Array.isArray(after)
      ? after.map((r) => String(r.id))
      : after && Array.isArray((after as { ids?: unknown }).ids)
        ? (after as { ids: string[] }).ids
        : after
          ? [String((after as { id: string }).id)]
          : [];
    if (table === 'recurrences')
      await tx
        .deleteFrom('transactions')
        .where('recurrenceId', 'in', ids)
        .where('status', '=', 'scheduled')
        .execute();
    await tx.deleteFrom(table).where('id', 'in', ids).execute();
    touched.push(...ids);
  } else if (entry.action === 'update' || entry.action === 'archive') {
    for (const row of asRows(entry.before)) {
      const { id, createdAt, updatedAt, ...rest } = reviveRow(row);
      void createdAt;
      void updatedAt;
      await tx
        .updateTable(table)
        .set(rest as never)
        .where('id', '=', String(id))
        .execute();
      touched.push(String(id));
    }
  } else if (entry.action === 'delete') {
    const rows = asRows(entry.before).map(reviveRow);
    if (rows.length)
      await tx
        .insertInto(table)
        .values(rows as never)
        .execute();
    touched.push(...rows.map((r) => String(r.id)));
  } else {
    throw new AppError(422, 'Esta ação não pode ser desfeita automaticamente.');
  }
  await tx.updateTable('auditLog').set({ undoneAt: new Date() }).where('id', '=', auditId).execute();
  await audit(tx, actor, {
    action: 'undo',
    entity: entry.entity,
    entityId: entry.entityId,
    before: { auditId },
    draftId,
  });
  if (table === 'recurrences') for (const id of touched) await materializeRecurrence(tx, id);
  return touched;
}

/** JSON do audit → valores aceitos pelo insert/update (datas ISO viram Date onde preciso). */
function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'createdAt' || k === 'updatedAt' || k === 'archivedAt' || k === 'pausedAt')
      out[k] = v ? new Date(String(v)) : null;
    else out[k] = v;
  }
  return out;
}

/** RF-14: correção de categoria vira regra para lançamentos futuros com a mesma descrição. */
export async function learnCategoryRule(tx: Tx, ws: string, description: string, categoryId: string) {
  const pattern = descriptionKey(description);
  if (pattern.length < 3) return;
  await tx
    .insertInto('categorizationRules')
    .values({ workspaceId: ws, pattern, categoryId, hits: 1 })
    .onConflict((oc) =>
      oc
        .columns(['workspaceId', 'pattern'])
        .doUpdateSet((eb) => ({ categoryId, hits: eb('categorizationRules.hits', '+', 1) })),
    )
    .execute();
}
