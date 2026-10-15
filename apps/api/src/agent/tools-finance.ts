import { z } from 'zod';
import {
  addMonths,
  formatBRL,
  formatDateBR,
  formatMoney,
  monthLabel,
  startOfMonth,
  type Currency,
  type DraftPreview,
} from '@sf/shared';
import { sql } from '@sf/db';
import { AppError, notFound } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import { insertTransactions } from '../domain/ledger.js';
import { computeProjection } from '../domain/projection.js';
import {
  aggregateTransactions,
  listAccounts,
  listCards,
  listCategories,
  listRecurrences,
  queryTransactions,
} from '../domain/queries.js';
import { buildRule } from '../domain/recurrence-rule.js';
import { resolveAccount, resolveCard, resolveCategory } from '../domain/resolve.js';
import { findDuplicates } from '../domain/ledger.js';
import { dedupeHash } from '@sf/shared/node';
import {
  amountInput,
  dateInput,
  defineTool,
  monthInput,
  toCents,
  toDate,
  toMonth,
  type ToolCtx,
} from './tool-kit.js';

const dirLabel = (d: 'in' | 'out') => (d === 'in' ? 'Entrada' : 'Saída');

async function emit(
  ctx: ToolCtx,
  kind: Parameters<typeof createDraft>[2],
  payload: unknown,
  preview: DraftPreview,
) {
  const draft = await createDraft(ctx.tx, ctx.actor, kind, payload as never, preview, ctx.conversationId);
  ctx.emitDraft(draft);
  return {
    draft_id: draft.id,
    status: 'aguardando confirmação do usuário',
    preview: {
      title: preview.title,
      summary: preview.summary,
      warnings: preview.warnings,
      projection_impact: preview.projectionImpact ?? null,
    },
    instruction: 'Mostre a prévia em uma frase curta e peça confirmação. Não diga que já foi gravado.',
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export const listAccountsTool = defineTool({
  name: 'list_accounts',
  description:
    'Lista as contas do workspace (banco, tipo, moeda, saldo atual, se está desatualizada). Contas em USD trazem o saldo em dólar e o equivalente em reais pela PTAX. Use para resolver "no BB", "no Santander".',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const accounts = await listAccounts(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      currency: a.currency,
      balance: formatMoney(a.balanceCents, a.currency),
      ...(a.fx
        ? {
            balance_brl: formatBRL(a.balanceBrlCents),
            ptax: `${a.fx.rate.toLocaleString('pt-BR', { maximumFractionDigits: 4 })} em ${formatDateBR(a.fx.date)}`,
          }
        : {}),
      stale: a.stale,
      private: a.isPrivate,
    }));
  },
});

export const listCardsTool = defineTool({
  name: 'list_cards',
  description: 'Lista os cartões de crédito (fechamento, vencimento, limite, fatura atual).',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const cards = await listCards(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return cards.map((c) => ({
      id: c.id,
      name: c.name,
      closing_day: c.closingDay,
      due_day: c.dueDay,
      limit: formatBRL(c.limitCents),
      used: formatBRL(c.usedCents),
      current_statement: c.currentStatement
        ? {
            closes: c.currentStatement.closingDate,
            due: c.currentStatement.dueDate,
            total: formatBRL(c.currentStatement.totalCents),
          }
        : null,
    }));
  },
});

export const listCategoriesTool = defineTool({
  name: 'list_categories',
  description: 'Lista as categorias de receita e despesa do workspace.',
  kind: 'read',
  schema: z.object({ kind: z.enum(['income', 'expense']).optional() }),
  async run(ctx, input) {
    const cats = await listCategories(ctx.tx, ctx.actor.workspaceId);
    return cats
      .filter((c) => !input.kind || c.kind === input.kind)
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  },
});

export const listRecurrencesTool = defineTool({
  name: 'list_recurrences',
  description: 'Lista recorrências (salário, aluguel, assinaturas, contas fixas) com a próxima data.',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const recs = await listRecurrences(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return recs.map((r) => ({
      id: r.id,
      description: r.description,
      amount: formatBRL(r.amountCents),
      direction: r.direction,
      when: r.ruleText,
      next: r.nextDate,
      paused: Boolean(r.pausedAt),
    }));
  },
});

export const queryTransactionsTool = defineTool({
  name: 'query_transactions',
  description:
    'Consulta lançamentos com filtros (período, conta, cartão, categoria ou texto, direção) e agregações. Use para "quanto gastei com mercado em setembro?". Datas e meses aceitam pt-BR.',
  kind: 'read',
  schema: z.object({
    month: monthInput.optional(),
    from: dateInput.optional(),
    to: dateInput.optional(),
    account: z.string().optional().describe('Nome/apelido da conta'),
    card: z.string().optional().describe('Nome do cartão'),
    category: z.string().optional().describe('Nome da categoria'),
    text: z.string().optional().describe('Texto na descrição'),
    category_or_text: z.string().optional().describe('Categoria ou texto (tenta categoria primeiro)'),
    direction: z.enum(['in', 'out']).optional(),
    aggregate: z.enum(['none', 'sum', 'by_category', 'by_month']).default('none'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    let from = input.from ? toDate(input.from, ctx.today) : null;
    let to = input.to ? toDate(input.to, ctx.today) : null;
    const month = toMonth(input.month, ctx.today);
    if (month) {
      // "setembro" sem ano: mês passado mais recente, não o futuro
      let m = month;
      if (m > startOfMonth(ctx.today) && !/\d{4}/.test(input.month ?? '')) m = addMonths(m, -12);
      from = m;
      to = addMonths(m, 1).replace(/-\d{2}$/, '-01');
      to = new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);
    }
    const accountId = input.account ? (await resolveAccount(ctx.tx, ws, input.account)).id : null;
    const cardId = input.card ? (await resolveCard(ctx.tx, ws, input.card)).id : null;
    let categoryIds: string[] | null = null;
    let text = input.text ?? null;
    const catHint = input.category ?? input.category_or_text;
    if (catHint) {
      const cats = await listCategories(ctx.tx, ws);
      const h = catHint.toLowerCase();
      const hits = cats.filter((c) => c.name.toLowerCase().includes(h) || h.includes(c.name.toLowerCase()));
      if (hits.length) categoryIds = hits.map((c) => c.id);
      else if (input.category_or_text) text = input.category_or_text;
      else throw new AppError(422, `Categoria "${catHint}" não encontrada.`);
    }
    const filter = {
      from,
      to,
      accountId,
      cardId,
      categoryIds,
      text,
      direction: input.direction ?? null,
      limit: input.limit,
      status: 'posted' as const,
    };
    const period =
      from || to
        ? `${from ? formatDateBR(from) : 'início'} a ${to ? formatDateBR(to) : 'hoje'}`
        : 'todo o período';
    if (input.aggregate !== 'none') {
      const agg = await aggregateTransactions(ctx.tx, ws, filter, input.aggregate);
      if (input.aggregate === 'sum') {
        const s = agg[0] as { outCents: number; inCents: number; count: number };
        return {
          period,
          count: s.count,
          total_out: formatBRL(s.outCents),
          total_in: formatBRL(s.inCents),
          answer: `${s.count} lançamento(s) em ${period}: saídas ${formatBRL(s.outCents)}, entradas ${formatBRL(s.inCents)}.`,
        };
      }
      return { period, rows: agg };
    }
    const { items, total } = await queryTransactions(ctx.tx, ws, filter);
    return {
      period,
      total,
      items: items.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: formatMoney(t.amountCents, t.currency),
        ...(t.currency !== 'BRL' ? { amount_brl: formatBRL(t.amountBrlCents) } : {}),
        direction: t.direction,
        category: t.categoryName,
        status: t.status,
      })),
    };
  },
});

export const getProjectionTool = defineTool({
  name: 'get_projection',
  description:
    'Projeção mensal de 24 meses (entradas, saídas, faturas, variável estimado, saldo base/otimista/pessimista). Com `month`, responde quanto sobra naquele mês e os maiores compromissos.',
  kind: 'read',
  schema: z.object({ month: monthInput.optional(), account: z.string().optional() }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const accountId = input.account ? (await resolveAccount(ctx.tx, ws, input.account)).id : null;
    const proj = await computeProjection(ctx.tx, ws, { accountId });
    const month = toMonth(input.month, ctx.today);
    if (month) {
      const m = proj.months.find((x) => x.month === month);
      if (!m) throw new AppError(422, 'A projeção cobre só os próximos 24 meses.');
      const monthEnd = addMonths(month, 1);
      const top = await sql<{ description: string; amount: number; kind: string }>`
        (select t.description, t.amount_brl_cents::bigint as amount, 'conta' as kind from transactions t
          where t.workspace_id = ${ws}::uuid and t.direction = 'out' and t.account_id is not null and t.kind = 'regular'
            and (t.status = 'scheduled' or t.date > ${ctx.today}::date) and t.date >= ${month}::date and t.date < ${monthEnd}::date)
        union all
        (select 'Fatura ' || c.name, (st.total_cents - st.paid_cents)::bigint, 'fatura' from card_statement_totals st join cards c on c.id = st.card_id
          where st.workspace_id = ${ws}::uuid and st.due_date >= ${month}::date and st.due_date < ${monthEnd}::date and st.total_cents > st.paid_cents)
        order by amount desc limit 3`.execute(ctx.tx);
      return {
        month: monthLabel(month, true),
        closing: formatBRL(m.closingCents),
        range: `${formatBRL(m.closingPessimisticCents)} a ${formatBRL(m.closingOptimisticCents)}`,
        income: formatBRL(m.incomeCents),
        expenses: formatBRL(m.expenseCents),
        card_bills: formatBRL(m.cardBillsCents),
        variable_estimate: formatBRL(m.variableCents),
        below_floor: m.belowFloor,
        top_commitments: top.rows.map((r) => `${r.description}: ${formatBRL(Number(r.amount))}`),
        answer: `Em ${monthLabel(month, true)} a projeção fecha em ${formatBRL(m.closingCents)} (faixa ${formatBRL(m.closingPessimisticCents)} a ${formatBRL(m.closingOptimisticCents)}).${top.rows.length ? ` Maiores compromissos: ${top.rows.map((r) => `${r.description} ${formatBRL(Number(r.amount))}`).join(', ')}.` : ''}`,
      };
    }
    return {
      floor: formatBRL(proj.floorCents),
      first_below_floor: proj.firstBelowFloor ? monthLabel(proj.firstBelowFloor, true) : null,
      min: proj.minClosing
        ? `${monthLabel(proj.minClosing.month)}: ${formatBRL(proj.minClosing.cents)}`
        : null,
      months: proj.months.map((m) => ({
        month: monthLabel(m.month),
        closing: formatBRL(m.closingCents),
        in: formatBRL(m.incomeCents),
        out: formatBRL(m.expenseCents + m.cardBillsCents + m.variableCents + m.goalsCents),
      })),
      answer: proj.firstBelowFloor
        ? `Atenção: ${monthLabel(proj.firstBelowFloor, true)} fica abaixo do piso. Menor saldo: ${formatBRL(proj.minClosing!.cents)} em ${monthLabel(proj.minClosing!.month, true)}.`
        : `Nos próximos 24 meses o menor saldo projetado é ${formatBRL(proj.minClosing?.cents ?? 0)} em ${monthLabel(proj.minClosing?.month ?? ctx.today, true)}.`,
    };
  },
});

export const simulateTool = defineTool({
  name: 'simulate',
  description:
    'Simula eventos hipotéticos na projeção SEM gravar nada ("e se eu comprar um carro de 60 mil em 24x?"). Retorna o antes/depois por mês.',
  kind: 'read',
  schema: z.object({
    events: z
      .array(
        z.object({
          description: z.string(),
          amount: amountInput,
          direction: z.enum(['in', 'out']).default('out'),
          date: dateInput.optional(),
          installments: z
            .number()
            .int()
            .min(1)
            .max(120)
            .optional()
            .describe('Divide o valor em N parcelas mensais'),
          monthly: z.boolean().optional().describe('Repete o valor todo mês (ex.: aluguel novo)'),
          months: z.number().int().min(1).max(24).optional(),
        }),
      )
      .min(1),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const accounts = await listAccounts(ctx.tx, ws, ctx.today);
    const target = accounts.find((a) => a.type !== 'investment');
    if (!target) throw new AppError(422, 'Cadastre ao menos uma conta para simular.');
    const before = await computeProjection(ctx.tx, ws);
    await sql`savepoint simulate`.execute(ctx.tx);
    try {
      for (const ev of input.events) {
        const cents = toCents(ev.amount);
        const date = toDate(ev.date ?? null, ctx.today, { future: true });
        const n = ev.monthly ? (ev.months ?? 24) : (ev.installments ?? 1);
        const per = ev.monthly ? cents : Math.round(cents / n);
        const items = Array.from({ length: n }, (_, i) => ({
          accountId: target.id,
          date: addMonths(date, i),
          amountCents: per,
          direction: ev.direction,
          description: `[simulação] ${ev.description}`,
          status: 'scheduled' as const,
        }));
        await insertTransactions(ctx.tx, ctx.actor, items);
      }
      const after = await computeProjection(ctx.tx, ws);
      return {
        note: 'Simulação: nada foi gravado.',
        months: after.months.map((m, i) => ({
          month: monthLabel(m.month),
          before: formatBRL(before.months[i]!.closingCents),
          after: formatBRL(m.closingCents),
          below_floor: m.belowFloor,
        })),
        first_below_floor_after: after.firstBelowFloor ? monthLabel(after.firstBelowFloor, true) : null,
        min_after: after.minClosing
          ? `${formatBRL(after.minClosing.cents)} em ${monthLabel(after.minClosing.month, true)}`
          : null,
      };
    } finally {
      await sql`rollback to savepoint simulate`.execute(ctx.tx);
    }
  },
});

export const listRecentActionsTool = defineTool({
  name: 'list_recent_actions',
  description: 'Lista as últimas ações gravadas pelo usuário (para desfazer ou corrigir).',
  kind: 'read',
  schema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
  async run(ctx, input) {
    const rows = await ctx.tx
      .selectFrom('auditLog')
      .select(['id', 'action', 'entity', 'entityId', 'at', 'undoneAt', 'after'])
      .where('workspaceId', '=', ctx.actor.workspaceId)
      .where('actorId', '=', ctx.actor.userId)
      .where('action', '<>', 'undo')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map((r) => ({
      audit_id: r.id,
      action: r.action,
      entity: r.entity,
      at: new Date(r.at).toISOString(),
      undone: Boolean(r.undoneAt),
      summary: summarizeRow(r.after),
    }));
  },
});

function summarizeRow(v: unknown): string | null {
  const row = (Array.isArray(v) ? v[0] : ((v as { first?: unknown })?.first ?? v)) as Record<
    string,
    unknown
  > | null;
  if (!row || typeof row !== 'object') return null;
  const parts = [
    row.description ?? row.name,
    row.amountCents ? formatBRL(Number(row.amountCents)) : null,
    row.date,
  ].filter(Boolean);
  return parts.join(' · ') || null;
}

// ---------------------------------------------------------------------------
// Escrita (sempre draft)
// ---------------------------------------------------------------------------

export const draftTransactionsTool = defineTool({
  name: 'draft_transactions',
  description:
    'Prepara um ou mais lançamentos (receita ou despesa) para confirmação. Use `card` para compras no cartão de crédito (com `installments` para parcelado) e `account` para conta corrente. Nunca grava direto: gera uma prévia.',
  kind: 'draft',
  schema: z.object({
    items: z
      .array(
        z.object({
          description: z.string().min(1),
          amount: amountInput,
          direction: z.enum(['in', 'out']),
          date: dateInput.optional(),
          account: z.string().nullish().describe('Conta (nome/apelido). Omitir se for cartão.'),
          card: z.string().nullish().describe('Cartão de crédito (nome). Omitir se for conta.'),
          category: z.string().nullish(),
          installments: z.number().int().min(1).max(48).nullish(),
        }),
      )
      .min(1)
      .max(50),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const items = [];
    const previewItems: NonNullable<DraftPreview['items']> = [];
    const warnings: string[] = [];
    const currencies = new Set<Currency>();
    for (const it of input.items) {
      const amountCents = toCents(it.amount);
      const date = toDate(it.date ?? null, ctx.today);
      const n = it.installments ?? 1;
      let accountId: string | null = null;
      let cardId: string | null = null;
      let currency: Currency = 'BRL';
      let where: string;
      if (it.card) {
        const card = await resolveCard(ctx.tx, ws, it.card);
        cardId = card.id;
        where = `cartão ${card.name}`;
      } else {
        if (n > 1) throw new AppError(422, 'Parcelamento só em cartão de crédito. Em qual cartão foi?');
        const acc = await resolveAccount(ctx.tx, ws, it.account);
        accountId = acc.id;
        currency = acc.currency as Currency;
        where = acc.name;
      }
      currencies.add(currency);
      const cat = await resolveCategory(ctx.tx, ws, {
        hint: it.category,
        description: it.description,
        direction: it.direction,
      });
      items.push({
        accountId,
        cardId,
        date,
        amountCents,
        direction: it.direction,
        categoryId: cat.id,
        description: it.description,
        installments: n,
      });
      const hash = dedupeHash({
        accountId,
        cardId,
        date,
        amountCents,
        direction: it.direction,
        description: it.description,
      });
      const dup = (await findDuplicates(ctx.tx, ws, [hash])).size > 0;
      if (dup)
        warnings.push(
          `Já existe um lançamento igual: ${it.description} ${formatMoney(amountCents, currency)} em ${formatDateBR(date)}.`,
        );
      if (n > 1 && cardId) {
        const { planInstallments } = await import('@sf/shared');
        const card = await ctx.tx
          .selectFrom('cards')
          .select(['closingDay', 'dueDay'])
          .where('id', '=', cardId)
          .executeTakeFirstOrThrow();
        const plan = planInstallments(date, amountCents, n, card.closingDay, card.dueDay);
        previewItems.push({
          date,
          description: `${it.description} — ${n}x de ${formatBRL(plan[1]?.amountCents ?? plan[0]!.amountCents)}`,
          amountCents,
          direction: it.direction,
          category: cat.name,
          duplicate: dup,
          note: `${where}; faturas de ${monthLabel(plan[0]!.statement.refMonth)} a ${monthLabel(plan[n - 1]!.statement.refMonth)}`,
        });
      } else {
        previewItems.push({
          date,
          description: it.description,
          amountCents,
          currency,
          direction: it.direction,
          category: cat.name,
          duplicate: dup,
          note: where,
        });
      }
    }
    const total = items.reduce((a, i) => a + i.amountCents, 0);
    const first = previewItems[0]!;
    // Lançamentos em moedas diferentes não somam; o total só aparece quando a moeda é única
    const totalCurrency = currencies.size === 1 ? [...currencies][0]! : null;
    const preview: DraftPreview = {
      title:
        items.length === 1
          ? `${dirLabel(items[0]!.direction)}: ${first.description}`
          : `${items.length} lançamentos`,
      summary:
        items.length === 1
          ? `${formatMoney(total, totalCurrency!)} em ${formatDateBR(first.date)} · ${first.note} · ${first.category}`
          : totalCurrency
            ? `Total ${formatMoney(total, totalCurrency)}`
            : `${items.length} lançamentos em reais e dólares`,
      lines: [],
      items: previewItems,
      totals: {
        count: items.length,
        amountCents: total,
        currency: totalCurrency,
        duplicates: previewItems.filter((p) => p.duplicate).length,
        lowConfidence: 0,
      },
      warnings,
    };
    return emit(ctx, 'transactions', { items }, preview);
  },
});

export const draftTransferTool = defineTool({
  name: 'draft_transfer',
  description:
    'Prepara uma transferência entre duas contas do workspace (não conta como receita nem despesa). Entre conta em reais e conta em dólar (ex.: envio para a Nomad), amount é o valor que sai da origem e to_amount o que chegou no destino.',
  kind: 'draft',
  schema: z.object({
    amount: amountInput.describe('Valor que sai da conta de origem, na moeda dela'),
    to_amount: amountInput
      .nullish()
      .describe(
        'Valor recebido no destino, na moeda dele. Obrigatório quando as moedas das contas são diferentes',
      ),
    from_account: z.string(),
    to_account: z.string(),
    date: dateInput.optional(),
    description: z.string().optional(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const from = await resolveAccount(ctx.tx, ws, input.from_account);
    const to = await resolveAccount(ctx.tx, ws, input.to_account);
    if (from.id === to.id) throw new AppError(422, 'Origem e destino são a mesma conta.');
    const amountCents = toCents(input.amount);
    const fromCur = from.currency as Currency;
    const toCur = to.currency as Currency;
    const toAmountCents = fromCur !== toCur ? toCents(input.to_amount, 'valor recebido no destino') : null;
    const date = toDate(input.date ?? null, ctx.today);
    const description = input.description ?? `Transferência ${from.name} → ${to.name}`;
    const received = toAmountCents ? ` (chegam ${formatMoney(toAmountCents, toCur)})` : '';
    return emit(
      ctx,
      'transfer',
      { fromAccountId: from.id, toAccountId: to.id, amountCents, toAmountCents, date, description },
      {
        title: 'Transferência',
        summary: `${formatMoney(amountCents, fromCur)} de ${from.name} para ${to.name}${received} em ${formatDateBR(date)}`,
        lines: [],
        warnings: [],
      },
    );
  },
});

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
};

export const draftRecurrenceTool = defineTool({
  name: 'draft_recurrence',
  description:
    'Cria ou altera uma recorrência (salário, aluguel, assinatura, conta fixa). Ex.: "todo dia 5 entra 8.500 de salário no BB". Para alterar, passe recurrence_id.',
  kind: 'draft',
  schema: z.object({
    recurrence_id: z.string().uuid().nullish(),
    description: z.string().min(1),
    amount: amountInput,
    direction: z.enum(['in', 'out']),
    frequency: z.enum(['monthly', 'weekly', 'yearly']).default('monthly'),
    day_of_month: z.number().int().min(-1).max(31).nullish().describe('-1 = último dia do mês'),
    weekday: z.string().nullish().describe('Para semanal: segunda, terça...'),
    month: z.number().int().min(1).max(12).nullish().describe('Para anual'),
    interval: z.number().int().min(1).max(12).default(1),
    account: z.string().nullish(),
    card: z.string().nullish(),
    category: z.string().nullish(),
    start_date: dateInput.nullish(),
    end_date: dateInput.nullish(),
    auto_post: z
      .boolean()
      .nullish()
      .describe('Lançar automaticamente na data (padrão: sim para cartão e salário)'),
    is_bill: z.boolean().nullish().describe('Conta a pagar com lembrete de vencimento'),
    variable_amount: z.boolean().nullish().describe('Valor varia: usa a média dos últimos 3 meses'),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const amountCents = toCents(input.amount);
    let accountId: string | null = null;
    let cardId: string | null = null;
    let currency: Currency = 'BRL';
    let where: string;
    if (input.card) {
      const c = await resolveCard(ctx.tx, ws, input.card);
      cardId = c.id;
      where = `cartão ${c.name}`;
    } else {
      const a = await resolveAccount(ctx.tx, ws, input.account);
      accountId = a.id;
      currency = a.currency as Currency;
      where = a.name;
    }
    const cat = await resolveCategory(ctx.tx, ws, {
      hint: input.category,
      description: input.description,
      direction: input.direction,
    });
    const freq =
      input.frequency === 'weekly' ? 'WEEKLY' : input.frequency === 'yearly' ? 'YEARLY' : 'MONTHLY';
    const startDate = input.start_date ? toDate(input.start_date, ctx.today, { future: true }) : ctx.today;
    const day = input.day_of_month ?? Number(startDate.slice(8, 10));
    const wd = input.weekday ? WEEKDAYS[input.weekday.toLowerCase().replace('-feira', '')] : undefined;
    const rule = buildRule({
      freq,
      interval: input.interval,
      byMonthDay: freq === 'WEEKLY' ? undefined : day,
      byMonth: freq === 'YEARLY' ? (input.month ?? Number(startDate.slice(5, 7))) : undefined,
      byDay: freq === 'WEEKLY' ? [wd ?? new Date(startDate).getUTCDay()] : undefined,
    });
    const endDate = input.end_date ? toDate(input.end_date, ctx.today, { future: true }) : null;
    const isSalary =
      /salario|salário|pagamento/.test(input.description.toLowerCase()) && input.direction === 'in';
    const autoPost = input.auto_post ?? (Boolean(cardId) || isSalary);
    const isBill = input.is_bill ?? (input.direction === 'out' && !cardId);
    const { ruleText, nextOccurrence } = await import('../domain/recurrence-rule.js');
    const next = nextOccurrence(rule, startDate, endDate, ctx.today);
    const fields = {
      accountId,
      cardId,
      description: input.description,
      amountCents,
      direction: input.direction,
      categoryId: cat.id,
      rule,
      startDate,
      endDate,
      amountMode: input.variable_amount ? ('average_n_months' as const) : ('fixed' as const),
      averageMonths: input.variable_amount ? 3 : null,
      autoPost,
      isBill,
    };
    if (input.recurrence_id) {
      const exists = await ctx.tx
        .selectFrom('recurrences')
        .select('id')
        .where('id', '=', input.recurrence_id)
        .executeTakeFirst();
      if (!exists) throw notFound('Recorrência');
    }
    return emit(
      ctx,
      'recurrence',
      { mode: input.recurrence_id ? 'update' : 'create', id: input.recurrence_id ?? null, fields },
      {
        title: `${input.recurrence_id ? 'Alterar' : 'Nova'} recorrência: ${input.description}`,
        summary: `${input.direction === 'in' ? 'Entra' : 'Sai'} ${formatMoney(amountCents, currency)} ${ruleText(rule)} · ${where} · ${cat.name}`,
        lines: [
          { label: 'Próxima', value: next ? formatDateBR(next) : '—' },
          { label: 'Até', value: endDate ? formatDateBR(endDate) : 'sem data final' },
          { label: 'Lançamento automático', value: autoPost ? 'sim' : 'não (pergunto se foi pago)' },
        ],
        warnings: [],
      },
    );
  },
});

export const draftAccountTool = defineTool({
  name: 'draft_account',
  description:
    'Cadastra (ou altera, com account_id) uma conta: banco, tipo, moeda, saldo inicial e data do saldo. Contas internacionais em dólar (Nomad, Wise, Avenue...) usam currency USD e saldo em dólares.',
  kind: 'draft',
  schema: z.object({
    account_id: z.string().uuid().nullish(),
    institution: z.string().min(1),
    name: z.string().nullish(),
    type: z.enum(['checking', 'savings', 'investment', 'cash']).default('checking'),
    currency: z
      .enum(['BRL', 'USD'])
      .nullish()
      .describe('Moeda da conta: BRL (padrão) ou USD para conta em dólar. Na alteração, omita para manter'),
    opening_balance: amountInput.describe('Saldo na data informada, na moeda da conta (pode ser 0)'),
    opening_date: dateInput.nullish(),
    is_private: z.boolean().nullish().describe('Conta privada: só o usuário vê'),
  }),
  async run(ctx, input) {
    const raw =
      typeof input.opening_balance === 'number'
        ? Math.round(input.opening_balance * 100)
        : (await import('@sf/shared')).parseAmount(String(input.opening_balance));
    if (raw === null) throw new AppError(422, 'Não entendi o saldo inicial.');
    const openingDate = toDate(input.opening_date ?? null, ctx.today);
    const pretty = (v: string) =>
      v.trim().length <= 3 ? v.trim().toUpperCase() : v.trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    const name = pretty(input.name?.trim() || input.institution);
    let currency: Currency = input.currency ?? 'BRL';
    if (input.account_id && !input.currency) {
      const current = await ctx.tx
        .selectFrom('accounts')
        .select('currency')
        .where('id', '=', input.account_id)
        .executeTakeFirst();
      if (!current) throw notFound('Conta');
      currency = current.currency as Currency;
    }
    const fields = {
      institution: pretty(input.institution),
      name,
      type: input.type,
      currency,
      openingBalanceCents: raw,
      openingDate,
      isPrivate: input.is_private ?? false,
    };
    const types = {
      checking: 'Conta corrente',
      savings: 'Poupança',
      investment: 'Investimento',
      cash: 'Dinheiro',
    };
    return emit(
      ctx,
      'account',
      { mode: input.account_id ? 'update' : 'create', id: input.account_id ?? null, fields },
      {
        title: `${input.account_id ? 'Alterar' : 'Nova'} conta: ${name}`,
        summary: `${types[input.type]}${currency === 'USD' ? ' em dólar' : ''} · saldo ${formatMoney(raw, currency)} em ${formatDateBR(openingDate)}${fields.isPrivate ? ' · privada' : ''}`,
        lines: [],
        warnings: [],
      },
    );
  },
});

export const draftCardTool = defineTool({
  name: 'draft_card',
  description:
    'Cadastra (ou altera, com card_id) um cartão de crédito: dia de fechamento, vencimento, limite e conta que paga a fatura.',
  kind: 'draft',
  schema: z.object({
    card_id: z.string().uuid().nullish(),
    name: z.string().min(1),
    closing_day: z.number().int().min(1).max(31),
    due_day: z.number().int().min(1).max(31),
    limit: amountInput.nullish(),
    pay_account: z.string().nullish().describe('Conta que paga a fatura'),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .nullish(),
    holder_tag: z.string().nullish().describe('Cartão adicional de terceiro (ex.: "Maria")'),
    is_private: z.boolean().nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    let accountId: string | null = null;
    let accName = 'não definida';
    try {
      const acc = await resolveAccount(ctx.tx, ws, input.pay_account);
      accountId = acc.id;
      accName = acc.name;
    } catch (err) {
      if (input.pay_account) throw err;
    }
    const limitCents = input.limit ? toCents(input.limit, 'limite') : 0;
    const fields = {
      name: input.name.trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase()),
      accountId,
      last4: input.last4 ?? null,
      holderTag: input.holder_tag ?? null,
      limitCents,
      closingDay: input.closing_day,
      dueDay: input.due_day,
      isPrivate: input.is_private ?? false,
    };
    return emit(
      ctx,
      'card',
      { mode: input.card_id ? 'update' : 'create', id: input.card_id ?? null, fields },
      {
        title: `${input.card_id ? 'Alterar' : 'Novo'} cartão: ${fields.name}`,
        summary: `Fecha dia ${input.closing_day}, vence dia ${input.due_day} · limite ${formatBRL(limitCents)} · paga pela ${accName}`,
        lines: [],
        warnings: accountId
          ? []
          : ['Sem conta pagadora: a fatura entra na projeção consolidada, mas não na projeção por conta.'],
      },
    );
  },
});

export const draftPensionTool = defineTool({
  name: 'draft_pension_entry',
  description:
    'Registra saldo e contribuições mensais de previdência (ex.: Previsc): participante e patrocinadora.',
  kind: 'draft',
  schema: z.object({
    provider: z.string().default('Previsc'),
    plan_name: z.string().nullish(),
    ref_month: monthInput,
    balance: amountInput,
    participant: amountInput.nullish(),
    sponsor: amountInput.nullish(),
    attachment_id: z.string().uuid().nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const refMonth = toMonth(input.ref_month, ctx.today)!;
    const plans = await ctx.tx
      .selectFrom('pensionPlans')
      .select(['id', 'provider', 'name'])
      .where('workspaceId', '=', ws)
      .execute();
    const plan = plans.find(
      (p) =>
        p.provider.toLowerCase() === input.provider.toLowerCase() &&
        (!input.plan_name || p.name.toLowerCase() === input.plan_name.toLowerCase()),
    );
    const balanceCents = toCents(input.balance, 'saldo');
    const participantCents = input.participant ? toCents(input.participant) : 0;
    const sponsorCents = input.sponsor ? toCents(input.sponsor) : 0;
    return emit(
      ctx,
      'pension_entry',
      {
        planId: plan?.id ?? null,
        newPlan: plan ? null : { provider: input.provider, name: input.plan_name ?? input.provider },
        refMonth,
        balanceCents,
        participantCents,
        sponsorCents,
        attachmentId: input.attachment_id ?? null,
      },
      {
        title: `Previdência ${input.provider} — ${monthLabel(refMonth, true)}`,
        summary: `Saldo ${formatBRL(balanceCents)}`,
        lines: [
          { label: 'Contribuição participante', value: formatBRL(participantCents) },
          { label: 'Contribuição patrocinadora', value: formatBRL(sponsorCents) },
        ],
        warnings: plan ? [] : [`Plano novo: ${input.provider}.`],
      },
    );
  },
});

async function findTargets(
  ctx: ToolCtx,
  input: { target?: string | null; search?: string | null; scope?: 'one' | 'installment_group' | null },
) {
  const ws = ctx.actor.workspaceId;
  let row;
  if (input.target && /^[0-9a-f-]{36}$/.test(input.target)) {
    row = await ctx.tx
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', input.target)
      .executeTakeFirst();
  } else if (input.search) {
    const { items } = await queryTransactions(ctx.tx, ws, {
      text: input.search,
      limit: 5,
      includeTransfers: true,
    });
    if (items.length > 1) {
      const same = items.filter(
        (i) => i.installmentGroupId && i.installmentGroupId === items[0]!.installmentGroupId,
      );
      if (same.length !== items.length) {
        throw new AppError(
          409,
          `Encontrei ${items.length} lançamentos com "${input.search}". Qual deles?`,
          'ambiguous',
          {
            options: items.map(
              (i) => `${formatDateBR(i.date)} ${i.description} ${formatBRL(i.amountCents)} (id ${i.id})`,
            ),
          },
        );
      }
    }
    row = items[0]
      ? await ctx.tx.selectFrom('transactions').selectAll().where('id', '=', items[0].id).executeTakeFirst()
      : undefined;
  } else {
    // "o último lançamento": o mais recente criado pelo usuário
    row = await ctx.tx
      .selectFrom('transactions')
      .selectAll()
      .where('workspaceId', '=', ws)
      .where('createdBy', '=', ctx.actor.userId)
      .where('source', '<>', 'recurrence')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }
  if (!row) throw notFound('Lançamento');
  let rows = [row];
  if (input.scope === 'installment_group' && row.installmentGroupId) {
    rows = await ctx.tx
      .selectFrom('transactions')
      .selectAll()
      .where('installmentGroupId', '=', row.installmentGroupId)
      .orderBy('installmentN')
      .execute();
  }
  return rows;
}

export const draftEditTool = defineTool({
  name: 'draft_edit',
  description:
    'Corrige lançamento(s) existente(s): valor, data, descrição, categoria, conta ou cartão. `target: "last"` = último lançamento do usuário; ou `search` por texto; ou o id. `scope: installment_group` aplica a todas as parcelas.',
  kind: 'draft',
  schema: z.object({
    target: z.string().nullish().describe('"last" ou id do lançamento'),
    search: z.string().nullish(),
    scope: z.enum(['one', 'installment_group']).nullish(),
    changes: z.object({
      amount: amountInput.nullish(),
      date: dateInput.nullish(),
      description: z.string().nullish(),
      category: z.string().nullish(),
      account: z.string().nullish(),
      card: z.string().nullish(),
    }),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const rows = await findTargets(ctx, input);
    const first = rows[0]!;
    const changes: Record<string, unknown> = {};
    const lines: DraftPreview['lines'] = [];
    let learnRule: { pattern: string; categoryId: string } | null = null;
    if (input.changes.amount) {
      changes.amountCents = toCents(input.changes.amount);
      lines.push({
        label: 'Valor',
        value: `${formatBRL(first.amountCents)} → ${formatBRL(changes.amountCents as number)}`,
      });
    }
    if (input.changes.date) {
      changes.date = toDate(input.changes.date, ctx.today);
      lines.push({
        label: 'Data',
        value: `${formatDateBR(first.date)} → ${formatDateBR(changes.date as string)}`,
      });
    }
    if (input.changes.description) {
      changes.description = input.changes.description;
      lines.push({ label: 'Descrição', value: `${first.description} → ${input.changes.description}` });
    }
    if (input.changes.category) {
      const cat = await resolveCategory(ctx.tx, ws, {
        hint: input.changes.category,
        description: first.description,
        direction: first.direction as 'in' | 'out',
      });
      changes.categoryId = cat.id;
      lines.push({ label: 'Categoria', value: cat.name });
      learnRule = { pattern: first.description, categoryId: cat.id };
    }
    if (input.changes.account) {
      const a = await resolveAccount(ctx.tx, ws, input.changes.account);
      changes.accountId = a.id;
      lines.push({ label: 'Conta', value: a.name });
    }
    if (input.changes.card) {
      const c = await resolveCard(ctx.tx, ws, input.changes.card);
      changes.cardId = c.id;
      lines.push({ label: 'Cartão', value: c.name });
    }
    if (!lines.length) throw new AppError(422, 'O que você quer mudar nesse lançamento?');
    return emit(
      ctx,
      'edit',
      { transactionIds: rows.map((r) => r.id), changes, learnRule },
      {
        title: `Corrigir: ${first.description}`,
        summary: `${formatDateBR(first.date)} · ${formatBRL(first.amountCents)}${rows.length > 1 ? ` · ${rows.length} parcelas` : ''}`,
        lines,
        warnings: learnRule ? ['Vou lembrar esta categoria para lançamentos parecidos.'] : [],
      },
    );
  },
});

export const draftDeleteTool = defineTool({
  name: 'draft_delete',
  description:
    'Remove lançamento(s) ("apaga a compra da farmácia"), uma recorrência (entity=recurrence), conta ou cartão (arquiva). `target: "last"` = último lançamento.',
  kind: 'draft',
  schema: z.object({
    entity: z.enum(['transaction', 'recurrence', 'account', 'card']).default('transaction'),
    target: z.string().nullish(),
    search: z.string().nullish(),
    scope: z.enum(['one', 'installment_group']).nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    if (input.entity === 'recurrence') {
      const recs = await listRecurrences(ctx.tx, ws, ctx.today);
      const hit =
        input.target && /^[0-9a-f-]{36}$/.test(input.target)
          ? recs.filter((r) => r.id === input.target)
          : recs.filter((r) =>
              r.description.toLowerCase().includes((input.search ?? input.target ?? '').toLowerCase()),
            );
      if (hit.length !== 1)
        throw new AppError(
          409,
          hit.length ? 'Qual recorrência?' : 'Recorrência não encontrada.',
          'ambiguous',
          { options: recs.map((r) => r.description) },
        );
      return emit(
        ctx,
        'delete',
        { entity: 'recurrences', ids: [hit[0]!.id] },
        {
          title: `Remover recorrência: ${hit[0]!.description}`,
          summary: `${formatBRL(hit[0]!.amountCents)} ${hit[0]!.ruleText}`,
          lines: [],
          warnings: ['As ocorrências futuras saem da projeção.'],
        },
      );
    }
    if (input.entity === 'account' || input.entity === 'card') {
      const r =
        input.entity === 'account'
          ? await resolveAccount(ctx.tx, ws, input.search ?? input.target)
          : await resolveCard(ctx.tx, ws, input.search ?? input.target);
      return emit(
        ctx,
        'delete',
        { entity: input.entity === 'account' ? 'accounts' : 'cards', ids: [r.id] },
        {
          title: `Arquivar ${input.entity === 'account' ? 'conta' : 'cartão'}: ${r.name}`,
          summary: 'O histórico é mantido.',
          lines: [],
          warnings: [],
        },
      );
    }
    const rows = await findTargets(ctx, { ...input, target: input.target === 'last' ? null : input.target });
    const total = rows.reduce((a, r) => a + r.amountCents, 0);
    return emit(
      ctx,
      'delete',
      { entity: 'transactions', ids: rows.map((r) => r.id) },
      {
        title: `Apagar: ${rows[0]!.description}`,
        summary: `${formatDateBR(rows[0]!.date)} · ${formatBRL(total)}${rows.length > 1 ? ` · ${rows.length} parcelas` : ''}`,
        lines: [],
        warnings: rows[0]!.transferId ? ['É uma transferência: os dois lados serão removidos.'] : [],
      },
    );
  },
});

export const undoLastTool = defineTool({
  name: 'undo_last',
  description:
    'Desfaz a última ação gravada pelo usuário (ou a indicada por audit_id de list_recent_actions).',
  kind: 'draft',
  schema: z.object({ audit_id: z.number().int().nullish() }),
  async run(ctx, input) {
    const entry = await ctx.tx
      .selectFrom('auditLog')
      .select(['id', 'action', 'entity', 'after', 'before'])
      .where('workspaceId', '=', ctx.actor.workspaceId)
      .where('actorId', '=', ctx.actor.userId)
      .where('undoneAt', 'is', null)
      .where('action', 'in', ['create', 'update', 'delete', 'archive'])
      .$if(Boolean(input.audit_id), (q) => q.where('id', '=', input.audit_id!))
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!entry) throw notFound('Ação para desfazer');
    const verb = {
      create: 'Remover o que foi criado',
      update: 'Voltar ao valor anterior',
      delete: 'Recriar o que foi apagado',
      archive: 'Reativar',
    }[entry.action as 'create'];
    return emit(
      ctx,
      'undo',
      { auditId: entry.id },
      {
        title: 'Desfazer última ação',
        summary: `${verb}: ${summarizeRow(entry.after ?? entry.before) ?? entry.entity}`,
        lines: [],
        warnings: [],
      },
    );
  },
});

const REMINDER_KINDS = [
  'due_bill',
  'statement_closed',
  'statement_due',
  'balance_alert',
  'weekly_summary',
  'monthly_summary',
  'import_reminder',
  'budget_alert',
  'insights',
] as const;

export const setReminderPrefsTool = defineTool({
  name: 'set_reminder_prefs',
  description:
    'Altera preferências: piso de saldo para alerta, horário dos lembretes, horário silencioso, gasto variável mensal estimado, e liga/desliga tipos de lembrete ("para de mandar resumo").',
  kind: 'draft',
  schema: z.object({
    balance_floor: amountInput.nullish(),
    variable_monthly: amountInput.nullish(),
    reminder_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    quiet_start: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    quiet_end: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullish(),
    disable: z.array(z.enum(REMINDER_KINDS)).nullish(),
    enable: z.array(z.enum(REMINDER_KINDS)).nullish(),
  }),
  async run(ctx, input) {
    const { parseAmount } = await import('@sf/shared');
    const workspace: Record<string, unknown> = {};
    const lines: DraftPreview['lines'] = [];
    if (input.balance_floor !== null && input.balance_floor !== undefined) {
      const v = parseAmount(input.balance_floor);
      if (v === null) throw new AppError(422, 'Não entendi o piso.');
      workspace.balanceFloorCents = v;
      lines.push({ label: 'Piso de saldo', value: formatBRL(v) });
    }
    if (input.variable_monthly) {
      workspace.variableMonthlyCents = toCents(input.variable_monthly);
      lines.push({
        label: 'Gasto variável estimado',
        value: formatBRL(workspace.variableMonthlyCents as number),
      });
    }
    if (input.reminder_time)
      ((workspace.reminderTime = input.reminder_time),
        lines.push({ label: 'Horário dos lembretes', value: input.reminder_time }));
    if (input.quiet_start)
      ((workspace.quietStart = input.quiet_start),
        lines.push({ label: 'Silêncio a partir de', value: input.quiet_start }));
    if (input.quiet_end)
      ((workspace.quietEnd = input.quiet_end), lines.push({ label: 'Silêncio até', value: input.quiet_end }));
    const labels: Record<string, string> = {
      due_bill: 'vencimentos',
      statement_closed: 'fatura fechada',
      statement_due: 'fatura a vencer',
      balance_alert: 'alerta de saldo',
      weekly_summary: 'resumo semanal',
      monthly_summary: 'resumo mensal',
      import_reminder: 'lembrete de importação',
      budget_alert: 'orçamento',
      insights: 'insights',
    };
    const reminderPrefs = [
      ...(input.disable ?? []).map((k) => ({ kind: k, enabled: false })),
      ...(input.enable ?? []).map((k) => ({ kind: k, enabled: true })),
    ];
    for (const p of reminderPrefs)
      lines.push({ label: labels[p.kind]!, value: p.enabled ? 'ligado' : 'desligado' });
    if (!lines.length) throw new AppError(422, 'O que você quer ajustar?');
    return emit(
      ctx,
      'settings',
      { workspace, reminderPrefs },
      {
        title: 'Preferências',
        summary: lines.map((l) => `${l.label}: ${l.value}`).join(' · '),
        lines,
        warnings: [],
      },
    );
  },
});

export const draftCardPaymentTool = defineTool({
  name: 'draft_card_payment',
  description:
    'Registra o pagamento da fatura de um cartão (saída da conta pagadora). Sem valor, paga o restante da fatura vencida/mais próxima.',
  kind: 'draft',
  schema: z.object({
    card: z.string().nullish(),
    amount: amountInput.nullish(),
    date: dateInput.nullish(),
    account: z.string().nullish(),
    statement_id: z.string().uuid().nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    let st;
    if (input.statement_id) {
      st = (
        await sql<{
          id: string;
          card_id: string;
          due_date: string;
          remaining: number;
          ref_month: string;
        }>`select id, card_id, due_date::text, ref_month::text, (total_cents - paid_cents)::bigint as remaining from card_statement_totals where id = ${input.statement_id}::uuid`.execute(
          ctx.tx,
        )
      ).rows[0];
    } else {
      const card = await resolveCard(ctx.tx, ws, input.card);
      st = (
        await sql<{ id: string; card_id: string; due_date: string; remaining: number; ref_month: string }>`
        select id, card_id, due_date::text, ref_month::text, (total_cents - paid_cents)::bigint as remaining from card_statement_totals
        where card_id = ${card.id}::uuid and status <> 'paid' and total_cents > paid_cents and closing_date <= ${ctx.today}::date
        order by due_date limit 1`.execute(ctx.tx)
      ).rows[0];
    }
    if (!st) throw new AppError(422, 'Não há fatura fechada em aberto para este cartão.');
    const card = await ctx.tx
      .selectFrom('cards')
      .select(['name', 'accountId'])
      .where('id', '=', st.card_id)
      .executeTakeFirstOrThrow();
    const acc = await resolveAccount(ctx.tx, ws, input.account ?? card.accountId);
    const amountCents = input.amount ? toCents(input.amount) : Number(st.remaining);
    const date = toDate(input.date ?? null, ctx.today);
    return emit(
      ctx,
      'card_payment',
      { statementId: st.id, accountId: acc.id, amountCents, date },
      {
        title: `Pagar fatura ${card.name} (${monthLabel(st.ref_month)})`,
        summary: `${formatBRL(amountCents)} saindo da ${acc.name} em ${formatDateBR(date)}`,
        lines: [{ label: 'Restante da fatura', value: formatBRL(Number(st.remaining)) }],
        warnings:
          amountCents < Number(st.remaining) ? ['Pagamento parcial: o restante continua em aberto.'] : [],
      },
    );
  },
});

export const draftMarkPaidTool = defineTool({
  name: 'draft_mark_paid',
  description:
    'Marca uma conta agendada (ex.: lembrete "conta de luz vence amanhã") como paga, com data e valor reais.',
  kind: 'draft',
  schema: z.object({
    transaction_id: z.string().uuid().nullish(),
    search: z.string().nullish(),
    date: dateInput.nullish(),
    amount: amountInput.nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    let row;
    if (input.transaction_id)
      row = await ctx.tx
        .selectFrom('transactions')
        .selectAll()
        .where('id', '=', input.transaction_id)
        .executeTakeFirst();
    else {
      const { items } = await queryTransactions(ctx.tx, ws, {
        text: input.search ?? '',
        status: 'scheduled',
        to: addMonths(ctx.today, 1),
        limit: 5,
      });
      const sorted = items.sort((a, b) => a.date.localeCompare(b.date));
      row = sorted[0]
        ? await ctx.tx
            .selectFrom('transactions')
            .selectAll()
            .where('id', '=', sorted[0].id)
            .executeTakeFirst()
        : undefined;
    }
    if (!row || row.status !== 'scheduled') throw notFound('Conta agendada');
    const date = toDate(input.date ?? null, ctx.today);
    const amountCents = input.amount ? toCents(input.amount) : row.amountCents;
    return emit(
      ctx,
      'mark_paid',
      { transactionId: row.id, date, amountCents },
      {
        title: `Pago: ${row.description}`,
        summary: `${formatBRL(amountCents)} em ${formatDateBR(date)}`,
        lines:
          amountCents !== row.amountCents
            ? [{ label: 'Valor previsto', value: formatBRL(row.amountCents) }]
            : [],
        warnings: [],
      },
    );
  },
});

export const draftBudgetTool = defineTool({
  name: 'draft_budget',
  description: 'Define orçamento mensal para uma categoria, com alerta ao atingir o percentual.',
  kind: 'draft',
  schema: z.object({
    category: z.string(),
    amount: amountInput,
    alert_pct: z.number().int().min(1).max(200).nullish(),
  }),
  async run(ctx, input) {
    const cat = await resolveCategory(ctx.tx, ctx.actor.workspaceId, {
      hint: input.category,
      description: input.category,
      direction: 'out',
    });
    if (cat.source !== 'explicit') throw new AppError(422, `Categoria "${input.category}" não encontrada.`);
    const amountCents = toCents(input.amount);
    return emit(
      ctx,
      'budget',
      { categoryId: cat.id, amountCents, alertPct: input.alert_pct ?? 100 },
      {
        title: `Orçamento: ${cat.name}`,
        summary: `${formatBRL(amountCents)} por mês, alerta em ${input.alert_pct ?? 100}%`,
        lines: [],
        warnings: [],
      },
    );
  },
});

export const draftGoalTool = defineTool({
  name: 'draft_goal',
  description:
    'Cria ou altera uma meta (reserva de emergência, viagem) com aporte mensal que entra na projeção. Com data alvo, a prévia traz o aporte mensal necessário para cumprir o prazo; se o usuário não disser o aporte, sugira esse valor.',
  kind: 'draft',
  schema: z.object({
    goal_id: z.string().uuid().nullish(),
    name: z.string(),
    kind: z.enum(['emergency', 'travel', 'purchase', 'other']).nullish(),
    target: amountInput,
    monthly: amountInput.nullish(),
    saved: amountInput.nullish(),
    target_date: dateInput.nullish(),
    start_month: monthInput.nullish(),
  }),
  async run(ctx, input) {
    const { parseAmount } = await import('@sf/shared');
    const targetCents = toCents(input.target, 'valor da meta');
    const monthly = input.monthly ? toCents(input.monthly) : 0;
    const saved = input.saved ? (parseAmount(input.saved) ?? 0) : 0;
    const startMonth = toMonth(input.start_month ?? null, ctx.today) ?? addMonths(startOfMonth(ctx.today), 1);
    const targetDate = input.target_date ? toDate(input.target_date, ctx.today, { future: true }) : null;
    const remaining = Math.max(0, targetCents - saved);
    const months = monthly > 0 ? Math.ceil(remaining / monthly) : null;
    const { goalPlan } = await import('@sf/shared');
    const plan = goalPlan(
      { targetCents, savedCents: saved, monthlyContributionCents: monthly, startMonth, targetDate },
      ctx.today,
    );
    const lines: DraftPreview['lines'] = [];
    const warnings: string[] = [];
    if (months)
      lines.push({
        label: 'Previsão',
        value: `${months} meses (${monthLabel(addMonths(startMonth, months - 1), true)})`,
      });
    if (plan.recommendedMonthlyCents && targetDate) {
      lines.push({
        label: 'Aporte para o prazo',
        value: `${formatBRL(plan.recommendedMonthlyCents)}/mês (${plan.contributionsLeft} aportes até ${formatDateBR(targetDate)})`,
      });
      if (plan.status === 'behind')
        warnings.push(
          monthly
            ? `Com ${formatBRL(monthly)}/mês a meta não fica pronta até ${formatDateBR(targetDate)}: faltariam ${formatBRL(remaining - monthly * plan.contributionsLeft!)}.`
            : `Sem aporte mensal a meta não entra na projeção. Para o prazo, seriam ${formatBRL(plan.recommendedMonthlyCents)}/mês.`,
        );
    }
    return emit(
      ctx,
      'goal',
      {
        mode: input.goal_id ? 'update' : 'create',
        id: input.goal_id ?? null,
        fields: {
          name: input.name,
          kind: input.kind ?? (/reserva|emerg/i.test(input.name) ? 'emergency' : 'other'),
          targetCents,
          savedCents: saved,
          monthlyContributionCents: monthly,
          startMonth,
          targetDate,
        },
      },
      {
        title: `Meta: ${input.name}`,
        summary: `${formatBRL(targetCents)}${monthly ? ` · aporte de ${formatBRL(monthly)}/mês` : ''}`,
        lines,
        warnings,
      },
    );
  },
});

export const FINANCE_TOOLS = [
  listAccountsTool,
  listCardsTool,
  listCategoriesTool,
  listRecurrencesTool,
  queryTransactionsTool,
  getProjectionTool,
  simulateTool,
  listRecentActionsTool,
  draftTransactionsTool,
  draftTransferTool,
  draftRecurrenceTool,
  draftAccountTool,
  draftCardTool,
  draftPensionTool,
  draftEditTool,
  draftDeleteTool,
  undoLastTool,
  setReminderPrefsTool,
  draftCardPaymentTool,
  draftMarkPaidTool,
  draftBudgetTool,
  draftGoalTool,
];
