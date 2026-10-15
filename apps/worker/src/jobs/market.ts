import { sql } from '@sf/db';
import { addDays, addMonths, startOfMonth } from '@sf/shared';
import { computeHoldings } from '@sf/api/domain/portfolio';
import type { WorkerContext } from '../context.js';
import { zipLines } from './zip.js';

const UA = { 'user-agent': 'saude-financeira/0.1 (+dados publicos)' };

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/token=[^&]+/, 'token=***')}`);
  return (await res.json()) as T;
}

const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const us = (iso: string) => `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;
const fromBr = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

async function upsertBenchmark(
  ctx: WorkerContext,
  series: string,
  date: string,
  value: number,
  source: string,
) {
  await sql`insert into benchmarks (series, date, value, source) values (${series}, ${date}::date, ${value}, ${source})
    on conflict (series, date) do update set value = excluded.value, source = excluded.source`.execute(
    ctx.sys,
  );
}

/** Banco Central: CDI (12, % a.d.), Selic (11, % a.d.), IPCA (433, % a.m.) e PTAX de venda. */
export async function fetchBenchmarks(ctx: WorkerContext, today: string) {
  const series: Array<[string, number, number]> = [
    ['CDI', 12, 400],
    ['SELIC', 11, 400],
    ['IPCA', 433, 800],
  ];
  for (const [name, code, days] of series) {
    const last = await ctx.sys
      .selectFrom('benchmarks')
      .select('date')
      .where('series', '=', name)
      .orderBy('date', 'desc')
      .limit(1)
      .executeTakeFirst();
    const from = last ? addDays(last.date, 1) : addDays(today, -days);
    if (from > today) continue;
    try {
      const rows = await getJSON<Array<{ data: string; valor: string }>>(
        `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${br(from)}&dataFinal=${br(today)}`,
      );
      for (const r of rows) await upsertBenchmark(ctx, name, fromBr(r.data), Number(r.valor), 'bcb_sgs');
    } catch (err) {
      ctx.app.log.warn({ err, series: name }, 'falha ao buscar série do BCB');
    }
  }
  try {
    const from = addDays(today, -10);
    const r = await getJSON<{ value: Array<{ cotacaoVenda: number; dataHoraCotacao: string }> }>(
      `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${us(from)}'&@dataFinalCotacao='${us(today)}'&$format=json`,
    );
    for (const v of r.value)
      await upsertBenchmark(ctx, 'PTAX_USD', v.dataHoraCotacao.slice(0, 10), v.cotacaoVenda, 'bcb_ptax');
    // Lançamentos de contas em dólar feitos antes da PTAX do dia usaram a cotação anterior
    if (r.value.length) await sql`select refresh_usd_amounts(${from}::date)`.execute(ctx.sys);
  } catch (err) {
    ctx.app.log.warn({ err }, 'falha ao buscar PTAX');
  }
}

interface BrapiQuote {
  symbol: string;
  regularMarketPrice: number;
  regularMarketTime?: string;
  dividendsData?: {
    cashDividends?: Array<{ paymentDate?: string; rate?: number; label?: string; lastDatePrior?: string }>;
  };
}

/** brapi.dev: cotação diária por ativo distinto em toda a base (não por usuário) + proventos + IBOV. */
export async function fetchQuotes(ctx: WorkerContext, today: string) {
  const token = ctx.app.config.BRAPI_TOKEN;
  const assets = await sql<{ id: string; ticker: string; currency: string }>`
    select distinct a.id, a.ticker, a.currency from assets a join trades t on t.asset_id = a.id
    where a.ticker is not null and a.kind in ('stock', 'fii', 'etf', 'bdr')`.execute(ctx.sys);
  // IBOV exige token na brapi; sem token só buscamos os ativos liberados no plano gratuito
  const tickers = [...assets.rows, ...(token ? [{ id: null, ticker: '^BVSP', currency: 'BRL' }] : [])];
  if (!token) ctx.app.log.info('BRAPI_TOKEN ausente: IBOV e parte das cotações podem não estar disponíveis');
  for (const a of tickers) {
    try {
      const r = await getJSON<{ results: BrapiQuote[] }>(
        `https://brapi.dev/api/quote/${encodeURIComponent(a.ticker)}?dividends=${a.id ? 'true' : 'false'}${token ? `&token=${token}` : ''}`,
      );
      const q = r.results?.[0];
      if (!q?.regularMarketPrice) continue;
      const date = q.regularMarketTime ? q.regularMarketTime.slice(0, 10) : today;
      if (!a.id) {
        await upsertBenchmark(ctx, 'IBOV', date, q.regularMarketPrice, 'brapi');
        continue;
      }
      await sql`insert into asset_prices (asset_id, date, close_cents, close, source) values (${a.id}::uuid, ${date}::date, ${Math.round(q.regularMarketPrice * 100)}, ${q.regularMarketPrice}, 'brapi')
        on conflict (asset_id, date) do update set close_cents = excluded.close_cents, close = excluded.close`.execute(
        ctx.sys,
      );
      for (const d of q.dividendsData?.cashDividends ?? []) {
        if (!d.paymentDate || !d.rate) continue;
        const pay = d.paymentDate.slice(0, 10);
        if (pay < addMonths(today, -1)) continue;
        await sql`insert into asset_events (asset_id, kind, ex_date, pay_date, amount_per_unit_micros, source)
          values (${a.id}::uuid, ${/jcp|juros/i.test(d.label ?? '') ? 'jcp' : 'dividend'}, ${d.lastDatePrior ? d.lastDatePrior.slice(0, 10) : null}::date, ${pay}::date, ${Math.round(d.rate * 1_000_000)}, 'brapi')
          on conflict do nothing`.execute(ctx.sys);
      }
    } catch (err) {
      ctx.app.log.warn({ err, ticker: a.ticker }, 'falha ao buscar cotação');
    }
  }
}

/** CVM dados abertos: cota diária dos fundos que alguém tem (por CNPJ). */
export async function fetchFundQuotes(ctx: WorkerContext, today: string) {
  const funds = await sql<{
    id: string;
    cnpj: string;
  }>`select distinct a.id, a.cnpj from assets a join trades t on t.asset_id = a.id where a.kind = 'fund' and a.cnpj is not null`.execute(
    ctx.sys,
  );
  if (!funds.rows.length) return;
  const digits = (c: string) => c.replace(/\D/g, '');
  const byCnpj = new Map(funds.rows.map((f) => [digits(f.cnpj), f.id]));
  for (const month of [startOfMonth(addMonths(today, -1)), startOfMonth(today)]) {
    const ym = month.slice(0, 7).replace('-', '');
    try {
      const res = await fetch(
        `https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS/inf_diario_fi_${ym}.zip`,
        { headers: UA, signal: AbortSignal.timeout(120_000) },
      );
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      let header: string[] | null = null;
      for await (const line of zipLines(buf)) {
        const cols = line.split(';');
        if (!header) {
          header = cols;
          continue;
        }
        const cnpj = digits(cols[header.findIndex((h) => h.startsWith('CNPJ_FUNDO'))] ?? '');
        const id = byCnpj.get(cnpj);
        if (!id) continue;
        const date = cols[header.indexOf('DT_COMPTC')]!;
        const quota = Number(cols[header.indexOf('VL_QUOTA')]);
        if (!date || !Number.isFinite(quota)) continue;
        await sql`insert into asset_prices (asset_id, date, close_cents, close, source) values (${id}::uuid, ${date}::date, ${Math.round(quota * 100)}, ${quota}, 'cvm')
          on conflict (asset_id, date) do update set close = excluded.close, close_cents = excluded.close_cents`.execute(
          ctx.sys,
        );
      }
    } catch (err) {
      ctx.app.log.warn({ err, ym }, 'falha ao buscar informe diário da CVM');
    }
  }
}

/** Proventos anunciados e vencimentos de renda fixa viram entradas previstas na projeção. */
export async function plannedFromPortfolio(ctx: WorkerContext, today: string) {
  const workspaces = await sql<{ id: string }>`select distinct workspace_id as id from trades`.execute(
    ctx.sys,
  );
  for (const { id: ws } of workspaces.rows) {
    const trades = await ctx.sys
      .selectFrom('trades')
      .select(['assetId', 'date', 'kind', 'qty', 'priceCents', 'feesCents', 'totalCents', 'fxRate'])
      .where('workspaceId', '=', ws)
      .execute();
    const holdings = computeHoldings(trades);
    await ctx.sys.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('plannedCashflows')
        .where('workspaceId', '=', ws)
        .where('source', 'in', ['dividend', 'fixed_income'])
        .where('date', '>=', today)
        .execute();
      const ids = [...holdings.keys()];
      if (!ids.length) return;
      const events = await tx
        .selectFrom('assetEvents as e')
        .innerJoin('assets as a', 'a.id', 'e.assetId')
        .select(['e.id', 'e.assetId', 'e.payDate', 'e.amountPerUnitMicros', 'e.kind', 'a.ticker', 'a.name'])
        .where('e.assetId', 'in', ids)
        .where('e.payDate', '>=', today)
        .execute();
      for (const ev of events) {
        const h = holdings.get(ev.assetId);
        if (!h || h.qty <= 0) continue;
        const gross = Math.round((h.qty * ev.amountPerUnitMicros) / 10_000);
        const net = ev.kind === 'jcp' ? Math.round(gross * 0.85) : gross; // JCP tem 15% de IR na fonte
        if (net > 0)
          await tx
            .insertInto('plannedCashflows')
            .values({
              workspaceId: ws,
              date: ev.payDate,
              amountCents: net,
              direction: 'in',
              source: 'dividend',
              refId: ev.id,
              description: `${ev.kind === 'jcp' ? 'JCP' : 'Dividendos'} ${ev.ticker ?? ev.name}`,
            })
            .execute();
      }
      const fixed = await tx
        .selectFrom('assets')
        .select(['id', 'name', 'maturityDate'])
        .where('id', 'in', ids)
        .where('kind', '=', 'fixed_income')
        .where('maturityDate', '>=', today)
        .execute();
      for (const a of fixed) {
        const h = holdings.get(a.id);
        if (!h || h.qty <= 0 || !a.maturityDate) continue;
        await tx
          .insertInto('plannedCashflows')
          .values({
            workspaceId: ws,
            date: a.maturityDate,
            amountCents: Math.round(h.investedBRLCents),
            direction: 'in',
            source: 'fixed_income',
            refId: a.id,
            description: `Vencimento ${a.name}`,
          })
          .execute();
      }
    });
  }
}

export async function marketDaily(ctx: WorkerContext, today: string) {
  await fetchBenchmarks(ctx, today);
  await fetchQuotes(ctx, today);
  await fetchFundQuotes(ctx, today);
  await plannedFromPortfolio(ctx, today);
  ctx.app.log.info('dados de mercado atualizados');
}
