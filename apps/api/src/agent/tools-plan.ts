import { z } from 'zod';
import {
  addMonths,
  annualFromDailyPct,
  diffDays,
  formatBRL,
  formatDateBR,
  impliedMonthlyRate,
  monthLabel,
  planInstallments,
  presentValueAtCdi,
  type PaymentFlow,
  type ProjectionDTO,
} from '@sf/shared';
import { sql } from '@sf/db';
import { AppError } from '../lib/errors.js';
import {
  emergencyReserve,
  emergencyReserveAnswer,
  safeToSpend,
  safeToSpendAnswer,
} from '../domain/forecast.js';
import { insertTransactions, type NewTransaction } from '../domain/ledger.js';
import { computeProjection } from '../domain/projection.js';
import { listAccounts } from '../domain/queries.js';
import { resolveCard } from '../domain/resolve.js';
import { amountInput, dateInput, defineTool, toCents, toDate, type ToolCtx } from './tool-kit.js';

const pct = (x: number, digits = 2) =>
  `${(x * 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

export const getSafeToSpendTool = defineTool({
  name: 'get_safe_to_spend',
  description:
    'Quanto o usuário pode gastar: folga para gastos extras sem nenhum mês dos próximos 24 fechar abaixo do piso, ritmo diário do dia a dia até o fim do mês e contas que vão ficar negativas nos próximos dias. Use para "quanto posso gastar?", "tenho folga?".',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const s = await safeToSpend(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return {
      extra: formatBRL(s.extraCents),
      extra_pessimistic: formatBRL(s.conservativeExtraCents),
      floor: formatBRL(s.floorCents),
      limiting_month: s.limitingMonth ? monthLabel(s.limitingMonth, true) : null,
      month_variable_left: formatBRL(s.monthVariableLeftCents),
      per_day: formatBRL(s.dailyCents),
      status: s.status,
      accounts_going_negative: s.shortfalls.map((f) => ({
        account: f.accountName,
        date: formatDateBR(f.date),
        balance: formatBRL(f.balanceCents),
        cause: f.cause ? `${f.cause.description} ${formatBRL(f.cause.amountCents)}` : null,
        suggestion: f.suggestion
          ? `transferir ${formatBRL(f.suggestion.amountCents)} da ${f.suggestion.fromAccountName} até ${formatDateBR(f.suggestion.date)}`
          : null,
      })),
      answer: safeToSpendAnswer(s),
    };
  },
});

interface OptionResult {
  label: string;
  totalCents: number;
  flows: PaymentFlow[];
  after: ProjectionDTO;
}

/** Aplica os lançamentos hipotéticos num savepoint, mede a projeção e desfaz. */
async function measure(ctx: ToolCtx, items: NewTransaction[]): Promise<ProjectionDTO> {
  await sql`savepoint evaluate_purchase`.execute(ctx.tx);
  try {
    await insertTransactions(ctx.tx, ctx.actor, items);
    return await computeProjection(ctx.tx, ctx.actor.workspaceId);
  } finally {
    await sql`rollback to savepoint evaluate_purchase`.execute(ctx.tx);
  }
}

export const evaluatePurchaseTool = defineTool({
  name: 'evaluate_purchase',
  description:
    'Avalia uma compra ANTES de fazê-la ("posso comprar uma TV de 4 mil?", "à vista com 8% de desconto ou 10x sem juros?"). Para cada forma de pagamento mostra se cabe sem furar o piso nos 24 meses, o menor saldo e a folga que sobra; compara o parcelado com o à vista pelo CDI líquido de IR e calcula juros embutidos. Não grava nada.',
  kind: 'read',
  schema: z.object({
    description: z.string().min(1),
    price: amountInput.describe('Preço cheio (ou total do parcelado sem juros)'),
    cash_price: amountInput.nullish().describe('Preço à vista com desconto, se houver'),
    cash_discount_pct: z.number().min(0).max(90).nullish().describe('Desconto à vista em %'),
    installments: z.number().int().min(2).max(48).nullish().describe('Número de parcelas da opção parcelada'),
    installment_amount: amountInput.nullish().describe('Valor de cada parcela, quando o parcelado tem juros'),
    card: z.string().nullish().describe('Cartão do parcelado'),
    date: dateInput.nullish().describe('Data da compra (padrão: hoje)'),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const price = toCents(input.price, 'preço');
    const date = toDate(input.date ?? null, ctx.today, { future: true });
    const cash = input.cash_price
      ? toCents(input.cash_price, 'preço à vista')
      : input.cash_discount_pct
        ? Math.round(price * (1 - input.cash_discount_pct / 100))
        : price;
    const account = (await listAccounts(ctx.tx, ws, ctx.today)).find(
      (a) => a.type !== 'investment' && a.currency === 'BRL',
    );
    if (!account) throw new AppError(422, 'Cadastre ao menos uma conta em reais para avaliar a compra.');
    const desc = `[simulação] ${input.description}`;
    const before = await computeProjection(ctx.tx, ws);

    const options: OptionResult[] = [];
    const cashLabel =
      cash < price ? `À vista com desconto (${formatBRL(cash)})` : `À vista (${formatBRL(cash)})`;
    options.push({
      label: cashLabel,
      totalCents: cash,
      flows: [{ days: diffDays(date, ctx.today), amountCents: cash }],
      after: await measure(ctx, [
        {
          accountId: account.id,
          date,
          amountCents: cash,
          direction: 'out',
          description: desc,
          status: 'scheduled',
        },
      ]),
    });

    if (input.installments) {
      const n = input.installments;
      const per = input.installment_amount ? toCents(input.installment_amount, 'valor da parcela') : null;
      const total = per ? per * n : price;
      const cards = await ctx.tx
        .selectFrom('cards')
        .select('id')
        .where('workspaceId', '=', ws)
        .where('archivedAt', 'is', null)
        .execute();
      if (input.card || cards.length) {
        const card = await resolveCard(ctx.tx, ws, input.card);
        const plan = planInstallments(date, total, n, card.closingDay, card.dueDay);
        options.push({
          label: `${n}x de ${formatBRL(plan[1]?.amountCents ?? plan[0]!.amountCents)} no cartão ${card.name}`,
          totalCents: total,
          flows: plan.map((p) => ({
            days: diffDays(p.statement.dueDate, ctx.today),
            amountCents: p.amountCents,
          })),
          after: await measure(ctx, [
            {
              cardId: card.id,
              date,
              amountCents: total,
              installments: n,
              direction: 'out',
              description: desc,
              status: 'scheduled',
            },
          ]),
        });
      } else {
        // sem cartão: carnê/boleto mensal a partir do mês seguinte
        const each = Math.floor(total / n);
        const items = Array.from({ length: n }, (_, k) => ({
          accountId: account.id,
          date: addMonths(date, k + 1),
          amountCents: k === 0 ? total - each * (n - 1) : each,
          direction: 'out' as const,
          description: desc,
          status: 'scheduled' as const,
        }));
        options.push({
          label: `${n}x de ${formatBRL(each)} (carnê)`,
          totalCents: total,
          flows: items.map((i) => ({ days: diffDays(i.date, ctx.today), amountCents: i.amountCents })),
          after: await measure(ctx, items),
        });
      }
    }

    const cdiRow = await ctx.tx
      .selectFrom('benchmarks')
      .select(['value', sql<string>`date::text`.as('date')])
      .where('series', '=', 'CDI')
      .orderBy('date', 'desc')
      .limit(1)
      .executeTakeFirst();
    const cdiAnnual = cdiRow ? annualFromDailyPct(Number(cdiRow.value)) : null;

    const floor = before.floorCents;
    const rows = options.map((o) => {
      const min = o.after.minClosing;
      const headroom = (min?.cents ?? 0) - floor;
      return {
        label: o.label,
        total: formatBRL(o.totalCents),
        fits: headroom >= 0,
        min_balance: min ? `${formatBRL(min.cents)} em ${monthLabel(min.month, true)}` : null,
        headroom_after: formatBRL(Math.max(0, headroom)),
        first_below_floor: o.after.firstBelowFloor ? monthLabel(o.after.firstBelowFloor, true) : null,
        present_value_at_cdi: cdiAnnual !== null ? formatBRL(presentValueAtCdi(o.flows, cdiAnnual)) : null,
        _headroom: headroom,
        _pv: cdiAnnual !== null ? presentValueAtCdi(o.flows, cdiAnnual) : null,
      };
    });

    const sentences: string[] = [];
    const alreadyBelow = before.firstBelowFloor !== null;
    for (const r of rows)
      sentences.push(
        r.fits
          ? `${r.label}: cabe; o menor saldo fica ${r.min_balance} e sobra folga de ${r.headroom_after}.`
          : `${r.label}: ${alreadyBelow ? 'a projeção já está abaixo do piso e piora' : `fura o piso de ${formatBRL(floor)} a partir de ${r.first_below_floor}`}; o menor saldo fica ${r.min_balance}.`,
      );
    const [cashRow, instRow] = rows;
    const instOpt = options[1];
    if (instRow && instOpt && cdiAnnual !== null && instRow._pv !== null) {
      const diff = cash - instRow._pv;
      sentences.push(
        `Pelo CDI líquido de IR (${pct(cdiAnnual)} ao ano bruto), as parcelas equivalem hoje a ${formatBRL(instRow._pv)}: ${
          diff > 0
            ? `parcelar e deixar o dinheiro rendendo sai ${formatBRL(diff)} mais barato que pagar ${formatBRL(cash)} à vista.`
            : `pagar ${formatBRL(cash)} à vista sai ${formatBRL(-diff)} mais barato.`
        }`,
      );
      const rate = impliedMonthlyRate(cash, instOpt.flows);
      if (rate !== null)
        sentences.push(
          `O parcelado embute juros de ${pct(rate)} ao mês (${pct((1 + rate) ** 12 - 1, 1)} ao ano) sobre o preço à vista.`,
        );
    } else if (instRow && cdiAnnual === null) {
      sentences.push('Sem a taxa do CDI atualizada, não comparei o custo do dinheiro no tempo.');
    }
    if (cashRow && instRow && cashRow.fits !== instRow.fits)
      sentences.push(
        cashRow.fits ? 'Só o à vista cabe sem furar o piso.' : 'Só o parcelado cabe sem furar o piso.',
      );

    return {
      note: 'Avaliação: nada foi gravado.',
      floor: formatBRL(floor),
      before_min: before.minClosing
        ? `${formatBRL(before.minClosing.cents)} em ${monthLabel(before.minClosing.month, true)}`
        : null,
      cdi_annual: cdiAnnual !== null ? pct(cdiAnnual) : null,
      cdi_date: cdiRow?.date ?? null,
      options: rows.map(({ _headroom, _pv, ...r }) => (void _headroom, void _pv, r)),
      answer: sentences.join(' '),
      instruction:
        'Apresente as opções e a comparação; a decisão é do usuário. Se ele decidir comprar, registre com draft_transactions.',
    };
  },
});

export const getEmergencyReserveTool = defineTool({
  name: 'get_emergency_reserve',
  description:
    'Reserva de emergência num desligamento: quantos meses a reserva atual (contas e investimentos com liquidez diária) paga as contas se o salário parar hoje, mês a mês pela projeção, comparado à meta do usuário. Use para "quanto tempo aguento sem salário?", "e se eu for demitido?".',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const r = await emergencyReserve(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return {
      reserve: formatBRL(r.reserveCents),
      months: r.months,
      runs_out: r.runsOutMonth ? monthLabel(r.runsOutMonth, true) : null,
      target_months: r.targetMonths,
      monthly_cost: formatBRL(r.monthlyCostCents),
      other_income: formatBRL(r.otherIncomeCents),
      salaries_stopping: r.salaries.map((s) => `${s.description} ${formatBRL(s.amountCents)}`),
      answer: emergencyReserveAnswer(r),
    };
  },
});

export const PLAN_TOOLS = [getSafeToSpendTool, evaluatePurchaseTool, getEmergencyReserveTool];
