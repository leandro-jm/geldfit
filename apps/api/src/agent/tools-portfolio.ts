import { z } from 'zod';
import { formatBRL, formatDateBR, monthLabel, type DraftPreview } from '@sf/shared';
import { AppError } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import { buildPortfolio, CLASS_LABEL, latestBenchmark, resolveAsset } from '../domain/portfolio.js';
import { amountInput, dateInput, defineTool, toCents, toDate } from './tool-kit.js';

const fmtPct = (v: number | null) =>
  v === null ? 'sem dados' : `${v >= 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')}%`;

export const getPortfolioTool = defineTool({
  name: 'get_portfolio',
  description:
    'Carteira informada pelo usuário: posições, preço médio, valor de mercado, alocação por classe vs alvo, exposição ao dólar (com PTAX e data) e desempenho vs CDI/IBOV/IPCA. Fatos apenas — nunca recomende comprar ou vender um ativo.',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const pf = await buildPortfolio(ctx.tx, ctx.actor.workspaceId, ctx.today);
    return {
      total: formatBRL(pf.totalCents),
      by_class: pf.byClass.map((c) => ({
        class: CLASS_LABEL[c.assetClass],
        value: formatBRL(c.valueCents),
        pct: `${c.pct.toFixed(1)}%`,
        target: c.targetPct !== null ? `${c.targetPct}%` : null,
      })),
      usd: {
        exposure: `${pf.usd.pct.toFixed(1)}%`,
        target: pf.usd.minPct !== null ? `${pf.usd.minPct}–${pf.usd.maxPct}%` : null,
        avg_rate: pf.usd.avgRate,
        ptax: pf.usd.ptax,
        ptax_date: pf.usd.ptaxDate,
      },
      positions: pf.positions.slice(0, 30).map((p) => ({
        asset: p.ticker ?? p.name,
        qty: p.qty,
        avg_price: formatBRL(p.avgPriceCents),
        value: formatBRL(p.marketValueCents),
        pnl: formatBRL(p.pnlCents),
        price_date: p.priceDate,
      })),
      performance: pf.performance.map((p) => ({
        period: p.period,
        carteira: fmtPct(p.portfolioPct),
        cdi: fmtPct(p.cdiPct),
        ibov: fmtPct(p.ibovPct),
        ipca: fmtPct(p.ipcaPct),
      })),
      disclaimer:
        'Diagnóstico com base nas suas metas; o app não recomenda compra ou venda de ativos específicos.',
    };
  },
});

export const getInsightsTool = defineTool({
  name: 'get_insights',
  description: 'Insights ativos sobre a carteira e as finanças (regra, números usados, data da cotação).',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const rows = await ctx.tx
      .selectFrom('insights')
      .select(['id', 'rule', 'severity', 'title', 'message', 'payload', 'createdAt'])
      .where('workspaceId', '=', ctx.actor.workspaceId)
      .where('resolvedAt', 'is', null)
      .where('dismissedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .execute();
    return rows.map((r) => ({
      rule: r.rule,
      severity: r.severity,
      title: r.title,
      message: r.message,
      details: r.payload,
    }));
  },
});

export const getPensionTool = defineTool({
  name: 'get_pension',
  description: 'Histórico de saldo e contribuições da previdência (participante e patrocinadora).',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const rows = await ctx.tx
      .selectFrom('pensionEntries as e')
      .innerJoin('pensionPlans as p', 'p.id', 'e.planId')
      .select([
        'p.provider',
        'p.name',
        'e.refMonth',
        'e.balanceCents',
        'e.contribParticipantCents',
        'e.contribSponsorCents',
      ])
      .where('e.workspaceId', '=', ctx.actor.workspaceId)
      .orderBy('e.refMonth', 'desc')
      .limit(24)
      .execute();
    return rows.map((r) => ({
      plan: `${r.provider} — ${r.name}`,
      month: monthLabel(r.refMonth),
      balance: formatBRL(r.balanceCents),
      participant: formatBRL(r.contribParticipantCents),
      sponsor: formatBRL(r.contribSponsorCents),
    }));
  },
});

export const draftTradeTool = defineTool({
  name: 'draft_trade',
  description:
    'Registra operações de investimento informadas pelo usuário ("comprei 100 ITUB4 a 32,50 na XP", "comprei 2.000 dólares a 5,42", "recebi 120 de dividendos de TAEE11"). Gera prévia.',
  kind: 'draft',
  schema: z.object({
    trades: z
      .array(
        z.object({
          ticker: z.string().nullish(),
          name: z.string().nullish().describe('Para ativos sem ticker: "CDB Banco X 110% CDI", "Dólar"'),
          kind: z.enum(['buy', 'sell', 'dividend', 'jcp', 'contribution', 'redemption', 'valuation']),
          asset_kind: z
            .enum(['stock', 'fii', 'etf', 'bdr', 'fund', 'fixed_income', 'cash_usd', 'crypto'])
            .nullish(),
          qty: z.number().nullish().describe('Quantidade (para dólar, a quantidade de USD)'),
          price: amountInput.nullish().describe('Preço unitário (para dólar, a cotação paga)'),
          total: amountInput
            .nullish()
            .describe('Valor total em R$ (proventos, aportes em renda fixa, valuation)'),
          fees: amountInput.nullish(),
          date: dateInput.nullish(),
          broker: z.string().nullish(),
        }),
      )
      .min(1),
  }),
  async run(ctx, input) {
    const { parseAmount } = await import('@sf/shared');
    const trades = [];
    const items: NonNullable<DraftPreview['items']> = [];
    for (const t of input.trades) {
      const isUsdCash = t.asset_kind === 'cash_usd' || (!t.ticker && /d[oó]lar|usd/i.test(t.name ?? ''));
      const asset = await resolveAsset(ctx.tx, ctx.actor.workspaceId, {
        ticker: t.ticker,
        name: isUsdCash ? 'Dólar' : t.name,
        kind: isUsdCash ? 'cash_usd' : t.asset_kind,
        currency: isUsdCash ? 'USD' : 'BRL',
      });
      const date = toDate(t.date ?? null, ctx.today);
      const fees = t.fees ? (parseAmount(t.fees) ?? 0) : 0;
      let qty = t.qty ?? 0;
      let priceCents = 0;
      let totalCents: number;
      let fxRate: number | null = null;
      if (isUsdCash) {
        // "comprei 2.000 dólares a 5,42": qty = USD, preço unitário = 1 USD (100 centavos), câmbio = 5,42
        const rate = t.price ? (parseAmount(t.price) ?? 0) / 100 : null;
        if (!rate || !qty) throw new AppError(422, 'Informe quantos dólares e a cotação paga.');
        fxRate = rate;
        priceCents = 100;
        totalCents = Math.round(qty * rate * 100) + fees;
      } else if (
        t.kind === 'dividend' ||
        t.kind === 'jcp' ||
        t.kind === 'valuation' ||
        (t.kind === 'contribution' && !t.price)
      ) {
        totalCents = toCents(t.total ?? t.price, 'valor');
        if (t.kind === 'contribution') {
          qty = 1;
          priceCents = totalCents;
        }
      } else {
        if (!qty || !t.price) throw new AppError(422, 'Informe quantidade e preço da operação.');
        priceCents = toCents(t.price, 'preço');
        const gross = Math.round(qty * priceCents);
        totalCents = t.kind === 'sell' || t.kind === 'redemption' ? gross - fees : gross + fees;
      }
      trades.push({
        assetId: asset.id,
        broker: t.broker ?? null,
        date,
        kind: t.kind,
        qty,
        priceCents,
        feesCents: fees,
        totalCents,
        fxRate,
        attachmentId: null,
        dedupeHash: null,
      });
      const verb = {
        buy: 'Compra',
        sell: 'Venda',
        dividend: 'Dividendo',
        jcp: 'JCP',
        contribution: 'Aporte',
        redemption: 'Resgate',
        valuation: 'Atualização de valor',
      }[t.kind];
      items.push({
        date,
        description: `${verb} ${qty ? `${qty} ` : ''}${asset.name}${fxRate ? ` a R$ ${fxRate.toFixed(4).replace('.', ',')}` : priceCents && t.kind !== 'contribution' ? ` a ${formatBRL(priceCents)}` : ''}`,
        amountCents: totalCents,
        direction: t.kind === 'buy' || t.kind === 'contribution' ? 'out' : 'in',
        note: t.broker ?? undefined,
      });
    }
    const draft = await createDraft(
      ctx.tx,
      ctx.actor,
      'trades',
      { trades },
      {
        title: trades.length === 1 ? items[0]!.description : `${trades.length} operações`,
        summary: `${formatBRL(trades.reduce((a, t) => a + t.totalCents, 0))} em ${formatDateBR(trades[0]!.date)}`,
        lines: [],
        items,
        warnings: [
          'Operações de investimento não movimentam suas contas automaticamente. Se o dinheiro saiu de uma conta, registre a transferência ou o débito.',
        ],
      },
      ctx.conversationId,
    );
    ctx.emitDraft(draft);
    return { draft_id: draft.id, instruction: 'Mostre a prévia e peça confirmação.' };
  },
});

export const setAllocationTargetsTool = defineTool({
  name: 'set_allocation_targets',
  description:
    'Define a alocação-alvo por classe (renda fixa, renda variável, fundos, dólar, previdência, caixa), a faixa de exposição ao dólar e a meta de reserva de emergência em meses.',
  kind: 'draft',
  schema: z.object({
    targets: z
      .array(
        z.object({
          asset_class: z.enum(['fixed_income', 'equities', 'funds', 'usd', 'pension', 'cash', 'crypto']),
          target_pct: z.number().min(0).max(100),
          min_pct: z.number().nullish(),
          max_pct: z.number().nullish(),
        }),
      )
      .default([]),
    usd_min_pct: z.number().min(0).max(100).nullish(),
    usd_max_pct: z.number().min(0).max(100).nullish(),
    emergency_months: z.number().positive().nullish(),
  }),
  async run(ctx, input) {
    const sum = input.targets.reduce((a, t) => a + t.target_pct, 0);
    const warnings =
      input.targets.length && Math.abs(sum - 100) > 0.5 ? [`Os alvos somam ${sum}%, não 100%.`] : [];
    const lines: DraftPreview['lines'] = input.targets.map((t) => ({
      label: CLASS_LABEL[t.asset_class],
      value: `${t.target_pct}%`,
    }));
    if (input.usd_min_pct != null || input.usd_max_pct != null)
      lines.push({
        label: 'Faixa em dólar',
        value: `${input.usd_min_pct ?? 0}–${input.usd_max_pct ?? 100}%`,
      });
    if (input.emergency_months)
      lines.push({ label: 'Reserva de emergência', value: `${input.emergency_months} meses` });
    const ws = ctx.actor.workspaceId;
    if (input.targets.length) {
      const d = await createDraft(
        ctx.tx,
        ctx.actor,
        'allocation_targets',
        {
          targets: input.targets.map((t) => ({
            assetClass: t.asset_class,
            targetPct: t.target_pct,
            minPct: t.min_pct ?? null,
            maxPct: t.max_pct ?? null,
          })),
        },
        {
          title: 'Alocação-alvo',
          summary: lines.map((l) => `${l.label} ${l.value}`).join(' · '),
          lines,
          warnings,
        },
        ctx.conversationId,
      );
      ctx.emitDraft(d);
    }
    if (input.usd_min_pct != null || input.usd_max_pct != null || input.emergency_months) {
      const d = await createDraft(
        ctx.tx,
        ctx.actor,
        'settings',
        {
          workspace: {
            usdMinPct: input.usd_min_pct ?? null,
            usdMaxPct: input.usd_max_pct ?? null,
            ...(input.emergency_months ? { emergencyMonthsTarget: input.emergency_months } : {}),
          },
        },
        {
          title: 'Metas da carteira',
          summary: lines
            .slice(input.targets.length)
            .map((l) => `${l.label} ${l.value}`)
            .join(' · '),
          lines: [],
          warnings: [],
        },
        ctx.conversationId,
      );
      ctx.emitDraft(d);
    }
    void ws;
    return { status: 'prévia criada; peça confirmação' };
  },
});

export const getMarketTool = defineTool({
  name: 'get_market_data',
  description: 'Últimos valores de PTAX, CDI, Selic, IPCA e IBOV disponíveis (com data).',
  kind: 'read',
  schema: z.object({}),
  async run(ctx) {
    const out: Record<string, unknown> = {};
    for (const s of ['PTAX_USD', 'CDI', 'SELIC', 'IPCA', 'IBOV']) {
      const b = await latestBenchmark(ctx.tx, s);
      out[s] = b ? { value: Number(b.value), date: b.date } : null;
    }
    return out;
  },
});

export const PORTFOLIO_TOOLS = [
  getPortfolioTool,
  getInsightsTool,
  getPensionTool,
  draftTradeTool,
  setAllocationTargetsTool,
  getMarketTool,
];
