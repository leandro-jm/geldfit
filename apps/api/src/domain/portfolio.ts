import { addMonths, type AssetClass, type PortfolioDTO, type PositionDTO } from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { listAccounts } from './queries.js';

export function assetClassOf(kind: string, currency: string, international: boolean): AssetClass {
  if (kind === 'cash_usd' || kind === 'bdr' || currency === 'USD' || (kind === 'etf' && international))
    return 'usd';
  if (kind === 'stock' || kind === 'fii' || kind === 'etf') return 'equities';
  if (kind === 'fund') return 'funds';
  if (kind === 'fixed_income') return 'fixed_income';
  if (kind === 'pension') return 'pension';
  if (kind === 'crypto') return 'crypto';
  return 'cash';
}

export const CLASS_LABEL: Record<AssetClass, string> = {
  fixed_income: 'Renda fixa',
  equities: 'Renda variável',
  funds: 'Fundos',
  usd: 'Dólar',
  pension: 'Previdência',
  cash: 'Caixa',
  crypto: 'Cripto',
};

interface TradeRow {
  assetId: string;
  date: string;
  kind: string;
  qty: number;
  priceCents: number;
  feesCents: number;
  totalCents: number;
  fxRate: number | null;
}

export interface Holding {
  assetId: string;
  qty: number;
  avgPriceCents: number; // na moeda do ativo, incluindo taxas de compra
  investedBRLCents: number; // custo de aquisição em BRL das unidades restantes
  avgFx: number | null; // câmbio médio (USD)
  realizedBRLCents: number;
  incomeBRLCents: number; // dividendos/JCP recebidos
}

/** Preço médio: compras alteram o custo; vendas reduzem a quantidade mantendo o médio. */
export function computeHoldings(trades: TradeRow[]): Map<string, Holding> {
  const out = new Map<string, Holding>();
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'buy' ? -1 : 1));
  for (const t of sorted) {
    const h = out.get(t.assetId) ?? {
      assetId: t.assetId,
      qty: 0,
      avgPriceCents: 0,
      investedBRLCents: 0,
      avgFx: null,
      realizedBRLCents: 0,
      incomeBRLCents: 0,
    };
    const qty = Number(t.qty);
    if (t.kind === 'buy' || t.kind === 'contribution') {
      const costAsset = qty * t.priceCents + t.feesCents / (t.fxRate ?? 1);
      const newQty = h.qty + qty;
      h.avgPriceCents = newQty > 0 ? (h.avgPriceCents * h.qty + costAsset) / newQty : 0;
      if (t.fxRate) h.avgFx = h.avgFx && h.qty > 0 ? (h.avgFx * h.qty + t.fxRate * qty) / newQty : t.fxRate;
      h.investedBRLCents += t.totalCents;
      h.qty = newQty;
    } else if (t.kind === 'sell' || t.kind === 'redemption') {
      const sellQty = Math.min(qty, h.qty);
      const costOut = h.qty > 0 ? (h.investedBRLCents * sellQty) / h.qty : 0;
      h.realizedBRLCents += t.totalCents - costOut;
      h.investedBRLCents -= costOut;
      h.qty -= sellQty;
      if (h.qty <= 1e-9) {
        h.qty = 0;
        h.avgPriceCents = 0;
        h.investedBRLCents = 0;
        h.avgFx = null;
      }
    } else if (t.kind === 'dividend' || t.kind === 'jcp') {
      h.incomeBRLCents += t.totalCents;
    } else if (t.kind === 'split' && qty > 0) {
      // qty = fator (ex.: 2 = desdobramento 1:2)
      h.qty *= qty;
      h.avgPriceCents /= qty;
    } else if (t.kind === 'valuation') {
      // atualização manual de valor (renda fixa sem cotação): qty=1, total = valor atual
    }
    out.set(t.assetId, h);
  }
  return out;
}

export async function latestBenchmark(tx: Tx, series: string, onOrBefore?: string) {
  let q = tx
    .selectFrom('benchmarks')
    .select(['date', 'value'])
    .where('series', '=', series)
    .orderBy('date', 'desc')
    .limit(1);
  if (onOrBefore) q = q.where('date', '<=', onOrBefore);
  return q.executeTakeFirst();
}

async function pricesAt(tx: Tx, assetIds: string[], onOrBefore: string) {
  if (!assetIds.length) return new Map<string, { closeCents: number; date: string }>();
  const rows = await sql<{ assetId: string; closeCents: number; date: string }>`
    select distinct on (asset_id) asset_id as "assetId", coalesce(close * 100, close_cents)::float8 as "closeCents", date::text as date
    from asset_prices where asset_id = any(${assetIds}::uuid[]) and date <= ${onOrBefore}::date
    order by asset_id, date desc`.execute(tx);
  return new Map(rows.rows.map((r) => [r.assetId, { closeCents: Number(r.closeCents), date: r.date }]));
}

/** Última valuation manual (renda fixa sem cotação pública). */
async function valuations(tx: Tx, ws: string, onOrBefore: string) {
  const rows = await sql<{ assetId: string; totalCents: number }>`
    select distinct on (asset_id) asset_id as "assetId", total_cents as "totalCents" from trades
    where workspace_id = ${ws}::uuid and kind = 'valuation' and date <= ${onOrBefore}::date order by asset_id, date desc`.execute(
    tx,
  );
  return new Map(rows.rows.map((r) => [r.assetId, Number(r.totalCents)]));
}

/** Valor de mercado da carteira de investimentos (sem contas e previdência) numa data. */
export async function portfolioValueAt(
  tx: Tx,
  ws: string,
  date: string,
): Promise<{ valueCents: number; netFlowCents: number }> {
  const trades = await tx
    .selectFrom('trades')
    .select(['assetId', 'date', 'kind', 'qty', 'priceCents', 'feesCents', 'totalCents', 'fxRate'])
    .where('workspaceId', '=', ws)
    .where('date', '<=', date)
    .execute();
  const holdings = computeHoldings(trades as TradeRow[]);
  const assets = await tx
    .selectFrom('assets')
    .select(['id', 'currency'])
    .where('id', 'in', [...holdings.keys(), '00000000-0000-0000-0000-000000000000'])
    .execute();
  const prices = await pricesAt(tx, [...holdings.keys()], date);
  const vals = await valuations(tx, ws, date);
  const ptax = (await latestBenchmark(tx, 'PTAX_USD', date))?.value ?? null;
  let value = 0;
  for (const h of holdings.values()) {
    if (h.qty <= 0) continue;
    const a = assets.find((x) => x.id === h.assetId);
    const p = prices.get(h.assetId);
    if (vals.has(h.assetId)) value += vals.get(h.assetId)!;
    else if (p)
      value += Math.round(h.qty * p.closeCents * (a?.currency === 'USD' ? Number(ptax ?? h.avgFx ?? 1) : 1));
    else value += h.investedBRLCents;
  }
  const flows = trades.reduce(
    (acc, t) =>
      acc +
      (t.kind === 'buy' || t.kind === 'contribution'
        ? t.totalCents
        : t.kind === 'sell' || t.kind === 'redemption'
          ? -t.totalCents
          : 0),
    0,
  );
  return { valueCents: value, netFlowCents: flows };
}

function compound(rows: Array<{ value: number }>, mode: 'daily_pct' | 'monthly_pct'): number {
  return rows.reduce((acc, r) => acc * (1 + Number(r.value) / 100), 1) - 1;
  void mode;
}

async function benchmarkReturn(
  tx: Tx,
  series: 'CDI' | 'IPCA' | 'IBOV',
  from: string,
  to: string,
): Promise<number | null> {
  if (series === 'IBOV') {
    const a = await latestBenchmark(tx, 'IBOV', from);
    const b = await latestBenchmark(tx, 'IBOV', to);
    return a && b && Number(a.value) > 0 ? Number(b.value) / Number(a.value) - 1 : null;
  }
  const rows = await tx
    .selectFrom('benchmarks')
    .select('value')
    .where('series', '=', series)
    .where('date', '>', from)
    .where('date', '<=', to)
    .execute();
  if (!rows.length) return null;
  return compound(rows, series === 'CDI' ? 'daily_pct' : 'monthly_pct');
}

export async function buildPortfolio(tx: Tx, ws: string, today: string): Promise<PortfolioDTO> {
  const trades = await tx
    .selectFrom('trades')
    .select(['assetId', 'date', 'kind', 'qty', 'priceCents', 'feesCents', 'totalCents', 'fxRate'])
    .where('workspaceId', '=', ws)
    .execute();
  const holdings = computeHoldings(trades as TradeRow[]);
  const ids = [...holdings.keys()];
  const assets = ids.length ? await tx.selectFrom('assets').selectAll().where('id', 'in', ids).execute() : [];
  const prices = await pricesAt(tx, ids, today);
  const vals = await valuations(tx, ws, today);
  const ptaxRow = await latestBenchmark(tx, 'PTAX_USD', today);
  const ptax = ptaxRow ? Number(ptaxRow.value) : null;

  const positions: PositionDTO[] = [];
  for (const h of holdings.values()) {
    if (h.qty <= 0 && !vals.has(h.assetId)) continue;
    const a = assets.find((x) => x.id === h.assetId)!;
    const p = prices.get(h.assetId);
    const fx = a.currency === 'USD' ? (ptax ?? h.avgFx ?? 1) : 1;
    const market = vals.has(h.assetId)
      ? vals.get(h.assetId)!
      : p
        ? Math.round(h.qty * p.closeCents * fx)
        : h.investedBRLCents;
    positions.push({
      assetId: a.id,
      ticker: a.ticker,
      name: a.name,
      kind: a.kind,
      assetClass: assetClassOf(a.kind, a.currency, a.isInternational),
      currency: a.currency as 'BRL' | 'USD',
      qty: h.qty,
      avgPriceCents: Math.round(h.avgPriceCents),
      investedCents: Math.round(h.investedBRLCents),
      marketValueCents: market,
      priceDate: p?.date ?? null,
      weightPct: 0,
      pnlCents: market - Math.round(h.investedBRLCents),
    });
  }

  // Contas e previdência entram no patrimônio por classe
  const accounts = await listAccounts(tx, ws, today);
  const cash = accounts
    .filter((a) => a.type !== 'investment')
    .reduce((s, a) => s + Math.max(0, a.balanceBrlCents), 0);
  const invAccounts = accounts
    .filter((a) => a.type === 'investment')
    .reduce((s, a) => s + a.balanceBrlCents, 0);
  const pension = await sql<{ cents: number }>`
    select coalesce(sum(balance_cents), 0)::bigint as cents from (
      select distinct on (plan_id) balance_cents from pension_entries where workspace_id = ${ws}::uuid order by plan_id, ref_month desc) x`.execute(
    tx,
  );
  const pensionCents = Number(pension.rows[0]?.cents ?? 0);

  const byClassMap = new Map<AssetClass, number>();
  for (const p of positions)
    byClassMap.set(p.assetClass, (byClassMap.get(p.assetClass) ?? 0) + p.marketValueCents);
  byClassMap.set('cash', (byClassMap.get('cash') ?? 0) + cash);
  if (invAccounts) byClassMap.set('fixed_income', (byClassMap.get('fixed_income') ?? 0) + invAccounts);
  if (pensionCents) byClassMap.set('pension', (byClassMap.get('pension') ?? 0) + pensionCents);
  const total = [...byClassMap.values()].reduce((a, b) => a + b, 0);
  const investTotal = positions.reduce((a, p) => a + p.marketValueCents, 0);
  for (const p of positions) p.weightPct = investTotal ? (p.marketValueCents / investTotal) * 100 : 0;

  const targets = await tx
    .selectFrom('allocationTargets')
    .selectAll()
    .where('workspaceId', '=', ws)
    .execute();
  const settings = await tx
    .selectFrom('workspaceSettings')
    .select(['usdMinPct', 'usdMaxPct'])
    .where('workspaceId', '=', ws)
    .executeTakeFirst();
  const byClass = [...byClassMap.entries()]
    .filter(([, v]) => v > 0)
    .map(([assetClass, valueCents]) => {
      const t = targets.find((x) => x.assetClass === assetClass);
      return {
        assetClass,
        valueCents,
        pct: total ? (valueCents / total) * 100 : 0,
        targetPct: t ? Number(t.targetPct) : null,
        minPct: t?.minPct != null ? Number(t.minPct) : null,
        maxPct: t?.maxPct != null ? Number(t.maxPct) : null,
      };
    })
    .sort((a, b) => b.valueCents - a.valueCents);

  // Exposição ao dólar e custo médio das compras de USD
  const usdValue = byClassMap.get('usd') ?? 0;
  const usdTrades = trades.filter((t) => t.fxRate && (t.kind === 'buy' || t.kind === 'contribution'));
  const usdQty = usdTrades.reduce((a, t) => a + Number(t.qty) * t.priceCents, 0);
  const avgRate = usdQty
    ? usdTrades.reduce((a, t) => a + Number(t.fxRate) * Number(t.qty) * t.priceCents, 0) / usdQty
    : null;

  const performance: PortfolioDTO['performance'] = [];
  const firstTrade = trades.map((t) => t.date).sort()[0];
  const periods: Array<{ period: 'month' | '12m' | 'inception'; from: string | undefined }> = [
    { period: 'month', from: addMonths(today, -1) },
    { period: '12m', from: addMonths(today, -12) },
    { period: 'inception', from: firstTrade },
  ];
  for (const per of periods) {
    if (!per.from) {
      performance.push({
        period: per.period,
        portfolioPct: null,
        cdiPct: null,
        ibovPct: null,
        ipcaPct: null,
      });
      continue;
    }
    const start = await portfolioValueAt(tx, ws, per.from);
    const end = await portfolioValueAt(tx, ws, today);
    const flow = end.netFlowCents - start.netFlowCents;
    // Modified Dietz simplificado (fluxos no meio do período)
    const base = start.valueCents + flow / 2;
    const ret = base > 0 ? (end.valueCents - start.valueCents - flow) / base : null;
    const [cdi, ibov, ipca] = await Promise.all([
      benchmarkReturn(tx, 'CDI', per.from, today),
      benchmarkReturn(tx, 'IBOV', per.from, today),
      benchmarkReturn(tx, 'IPCA', per.from, today),
    ]);
    const pct = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 100);
    performance.push({
      period: per.period,
      portfolioPct: pct(ret),
      cdiPct: pct(cdi),
      ibovPct: pct(ibov),
      ipcaPct: pct(ipca),
    });
  }

  return {
    totalCents: total,
    positions: positions.sort((a, b) => b.marketValueCents - a.marketValueCents),
    byClass,
    usd: {
      pct: total ? (usdValue / total) * 100 : 0,
      minPct: settings?.usdMinPct != null ? Number(settings.usdMinPct) : null,
      maxPct: settings?.usdMaxPct != null ? Number(settings.usdMaxPct) : null,
      avgRate: avgRate ? Math.round(avgRate * 10000) / 10000 : null,
      ptax,
      ptaxDate: ptaxRow?.date ?? null,
    },
    performance,
  };
}

/** Resolve (ou cria) o ativo de uma operação. Tickers viram ativos públicos; o resto fica no workspace. */
export async function resolveAsset(
  tx: Tx,
  ws: string,
  a: { ticker?: string | null; name?: string | null; kind?: string | null; currency?: 'BRL' | 'USD' | null },
): Promise<{ id: string; name: string; kind: string; currency: string }> {
  const ticker = a.ticker?.trim().toUpperCase() || null;
  const kind = a.kind ?? guessKind(ticker, a.name ?? '');
  const currency = a.currency ?? (kind === 'cash_usd' ? 'USD' : 'BRL');
  if (ticker) {
    const r = await sql<{
      id: string;
    }>`select ensure_public_asset(${kind}, ${ticker}, null, ${a.name ?? ticker}, ${currency}, ${kind === 'bdr' || currency === 'USD'}) as id`.execute(
      tx,
    );
    const row = await tx
      .selectFrom('assets')
      .select(['id', 'name', 'kind', 'currency'])
      .where('id', '=', r.rows[0]!.id)
      .executeTakeFirstOrThrow();
    return row;
  }
  const name = a.name?.trim() || (kind === 'cash_usd' ? 'Dólar em espécie/conta' : 'Ativo');
  const existing = await tx
    .selectFrom('assets')
    .select(['id', 'name', 'kind', 'currency'])
    .where('workspaceId', '=', ws)
    .where('name', '=', name)
    .where('kind', '=', kind)
    .executeTakeFirst();
  if (existing) return existing;
  return tx
    .insertInto('assets')
    .values({ workspaceId: ws, kind, name, currency, isInternational: currency === 'USD' })
    .returning(['id', 'name', 'kind', 'currency'])
    .executeTakeFirstOrThrow();
}

export function guessKind(ticker: string | null, name: string): string {
  const n = name.toLowerCase();
  if (/d[oó]lar|usd/.test(n) && !ticker) return 'cash_usd';
  if (!ticker)
    return /cdb|lci|lca|tesouro|debenture|cri|cra/.test(n)
      ? 'fixed_income'
      : /fundo|fic|fia|fim/.test(n)
        ? 'fund'
        : 'fixed_income';
  if (/^[A-Z]{4}3[45]$/.test(ticker)) return 'bdr';
  if (/^[A-Z]{4}11$/.test(ticker)) return /etf|index|ivvb|bova|smal|hash/i.test(n + ticker) ? 'etf' : 'fii';
  if (/^[A-Z]{4}\d{1,2}$/.test(ticker)) return 'stock';
  return 'stock';
}
