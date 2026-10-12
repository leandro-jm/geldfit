import { addDays, addMonths, formatBRL, monthLabel, startOfMonth } from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { buildPortfolio, CLASS_LABEL, latestBenchmark } from './portfolio.js';
import { computeProjection } from './projection.js';
import { listAccounts } from './queries.js';

export interface InsightDraft {
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  payload: { rule_text: string; numbers: Record<string, string | number | null>; quote_date?: string | null };
  fingerprint: string;
}

/** Limite de isenção de IR para vendas de ações no mês (parametrizável). */
export const STOCK_SALES_EXEMPTION_CENTS = Number(process.env.STOCK_SALES_EXEMPTION_CENTS ?? 2_000_000);

const pct = (v: number) => `${v.toFixed(1).replace('.', ',')}%`;

/**
 * Regras determinísticas e transparentes sobre a carteira informada. Não recomendam comprar ou
 * vender ativos específicos (CVM 19): comparam com metas do próprio usuário e mostram fatos.
 */
export async function computeInsights(tx: Tx, ws: string, today: string): Promise<InsightDraft[]> {
  const out: InsightDraft[] = [];
  const pf = await buildPortfolio(tx, ws, today);
  const settings = await tx
    .selectFrom('workspaceSettings')
    .selectAll()
    .where('workspaceId', '=', ws)
    .executeTakeFirst();
  const month = today.slice(0, 7);

  // 1) Exposição ao dólar
  if (pf.totalCents > 0 && (pf.usd.minPct !== null || pf.usd.maxPct !== null)) {
    const lo = pf.usd.minPct ?? 0;
    const hi = pf.usd.maxPct ?? 100;
    if (pf.usd.pct < lo || pf.usd.pct > hi) {
      out.push({
        rule: 'usd_exposure',
        severity: 'warning',
        title: 'Exposição ao dólar fora da sua faixa',
        message: `Sua exposição ao dólar está em ${pct(pf.usd.pct)}; sua meta é ${lo}–${hi}%.`,
        payload: {
          rule_text:
            '% do patrimônio em USD (dólar, BDR, ETF internacional) fora da faixa-alvo definida por você',
          numbers: { exposicao_pct: Number(pf.usd.pct.toFixed(2)), meta_min: lo, meta_max: hi },
          quote_date: pf.usd.ptaxDate,
        },
        fingerprint: `usd_exposure:${month}`,
      });
    }
  }

  // 2) Custo médio do dólar vs PTAX
  if (pf.usd.avgRate && pf.usd.ptax) {
    out.push({
      rule: 'usd_cost',
      severity: 'info',
      title: 'Seu preço médio do dólar',
      message: `Preço médio ${pf.usd.avgRate.toFixed(2).replace('.', ',')}; PTAX ${pf.usd.ptaxDate ? `de ${pf.usd.ptaxDate.split('-').reverse().join('/')}` : 'atual'} ${pf.usd.ptax.toFixed(2).replace('.', ',')}.`,
      payload: {
        rule_text: 'Preço médio das compras de USD comparado à PTAX do último dia útil',
        numbers: { preco_medio: pf.usd.avgRate, ptax: pf.usd.ptax },
        quote_date: pf.usd.ptaxDate,
      },
      fingerprint: `usd_cost:${month}`,
    });
  }

  // 3) Concentração em renda variável
  const equities = pf.positions.filter((p) => p.assetClass === 'equities');
  const eqTotal = equities.reduce((a, p) => a + p.marketValueCents, 0);
  if (eqTotal > 0) {
    for (const p of equities) {
      const w = (p.marketValueCents / eqTotal) * 100;
      if (w > 20 && equities.length > 1) {
        out.push({
          rule: 'concentration',
          severity: 'warning',
          title: `Concentração em ${p.ticker ?? p.name}`,
          message: `${p.ticker ?? p.name} é ${pct(w)} das suas ações.`,
          payload: {
            rule_text: 'Um ativo acima de 20% da renda variável',
            numbers: { peso_pct: Number(w.toFixed(2)), valor: formatBRL(p.marketValueCents) },
            quote_date: p.priceDate,
          },
          fingerprint: `concentration:${p.assetId}:${month}`,
        });
      }
    }
    const sectors = await tx
      .selectFrom('assets')
      .select(['id', 'sector'])
      .where(
        'id',
        'in',
        equities.map((e) => e.assetId),
      )
      .execute();
    const bySector = new Map<string, number>();
    for (const p of equities) {
      const s = sectors.find((x) => x.id === p.assetId)?.sector;
      if (s) bySector.set(s, (bySector.get(s) ?? 0) + p.marketValueCents);
    }
    for (const [sector, v] of bySector) {
      const w = (v / eqTotal) * 100;
      if (w > 35) {
        out.push({
          rule: 'concentration',
          severity: 'warning',
          title: `Concentração no setor ${sector}`,
          message: `O setor ${sector} é ${pct(w)} das suas ações.`,
          payload: {
            rule_text: 'Um setor acima de 35% da renda variável',
            numbers: { peso_pct: Number(w.toFixed(2)) },
          },
          fingerprint: `concentration_sector:${sector}:${month}`,
        });
      }
    }
  }

  // 4) Fundo caro: DI/RF com rendimento 12m < 95% do CDI, ou taxa de administração > 1% a.a.
  const funds = pf.positions.filter((p) => p.kind === 'fund');
  if (funds.length) {
    const from = addMonths(today, -12);
    const cdiRows = await tx
      .selectFrom('benchmarks')
      .select('value')
      .where('series', '=', 'CDI')
      .where('date', '>', from)
      .where('date', '<=', today)
      .execute();
    const cdi12 = cdiRows.length ? cdiRows.reduce((a, r) => a * (1 + Number(r.value) / 100), 1) - 1 : null;
    const meta = await tx
      .selectFrom('assets')
      .select(['id', 'fundClass', 'adminFeePct', 'name'])
      .where(
        'id',
        'in',
        funds.map((f) => f.assetId),
      )
      .execute();
    for (const f of funds) {
      const m = meta.find((x) => x.id === f.assetId)!;
      const quotes = await sql<{ first: number; last: number; firstDate: string }>`
        select (array_agg(coalesce(close, close_cents / 100.0) order by date))[1]::float8 as first, (array_agg(coalesce(close, close_cents / 100.0) order by date desc))[1]::float8 as last, min(date)::text as "firstDate"
        from asset_prices where asset_id = ${f.assetId}::uuid and date >= ${from}::date`.execute(tx);
      const q = quotes.rows[0];
      const ret = q && Number(q.first) > 0 ? Number(q.last) / Number(q.first) - 1 : null;
      const isDI = /di|rf|renda fixa|referenciado/i.test(m.fundClass ?? m.name);
      const ofCdi = ret !== null && cdi12 ? (ret / cdi12) * 100 : null;
      const fee = m.adminFeePct !== null ? Number(m.adminFeePct) : null;
      if ((isDI && ofCdi !== null && ofCdi < 95) || (fee !== null && fee > 1)) {
        out.push({
          rule: 'expensive_fund',
          severity: 'warning',
          title: `Fundo com custo alto: ${f.name}`,
          message: `${f.name}${ofCdi !== null ? ` rendeu ${pct(ofCdi)} do CDI em 12 meses` : ''}${fee !== null ? `${ofCdi !== null ? ',' : ''} com taxa de ${pct(fee)} a.a.` : '.'}`,
          payload: {
            rule_text:
              'Fundo DI/RF com rendimento 12m abaixo de 95% do CDI, ou taxa de administração acima de 1% a.a.',
            numbers: {
              rendimento_12m_pct_cdi: ofCdi !== null ? Number(ofCdi.toFixed(1)) : null,
              taxa_adm_pct: fee,
            },
            quote_date: q?.firstDate ?? null,
          },
          fingerprint: `expensive_fund:${f.assetId}:${month}`,
        });
      }
    }
  }

  // 5) Desempenho
  const p12 = pf.performance.find((x) => x.period === '12m');
  if (p12?.portfolioPct !== null && p12?.portfolioPct !== undefined && pf.positions.length) {
    out.push({
      rule: 'performance',
      severity: 'info',
      title: 'Desempenho da carteira em 12 meses',
      message: `Carteira: ${p12.portfolioPct >= 0 ? '+' : ''}${pct(p12.portfolioPct)} em 12m${p12.cdiPct !== null ? `; CDI: +${pct(p12.cdiPct)}` : ''}${p12.ibovPct !== null ? `; IBOV: ${p12.ibovPct >= 0 ? '+' : ''}${pct(p12.ibovPct)}` : ''}.`,
      payload: {
        rule_text: 'Retorno da carteira (Dietz modificado) vs CDI, IBOV e IPCA no período',
        numbers: {
          carteira_pct: p12.portfolioPct,
          cdi_pct: p12.cdiPct,
          ibov_pct: p12.ibovPct,
          ipca_pct: p12.ipcaPct,
        },
      },
      fingerprint: `performance:${month}`,
    });
  }

  // Despesa mensal projetada (base para dinheiro parado e reserva)
  const proj = await computeProjection(tx, ws);
  const monthlyExpense = proj.months.length
    ? Math.round(
        proj.months.slice(1, 4).reduce((a, m) => a + m.expenseCents + m.cardBillsCents + m.variableCents, 0) /
          Math.max(1, Math.min(3, proj.months.length - 1)),
      )
    : 0;

  // 6) Dinheiro parado em conta corrente
  if (monthlyExpense > 0) {
    const accounts = await listAccounts(tx, ws, today);
    const ago = addDays(today, -30);
    for (const a of accounts.filter((x) => x.type === 'checking')) {
      const past = await sql<{ b: number }>`select account_balance(${a.id}::uuid, ${ago}::date) as b`.execute(
        tx,
      );
      const pastBal = Number(past.rows[0]?.b ?? 0);
      if (a.balanceCents > monthlyExpense && pastBal > monthlyExpense) {
        out.push({
          rule: 'idle_cash',
          severity: 'info',
          title: `Dinheiro parado na ${a.name}`,
          message: `${formatBRL(a.balanceCents)} parados na ${a.name} há mais de 30 dias, acima de 1 mês de despesas (${formatBRL(monthlyExpense)}).`,
          payload: {
            rule_text: 'Saldo em conta corrente acima de 1 mês de despesas projetadas por mais de 30 dias',
            numbers: {
              saldo: formatBRL(a.balanceCents),
              saldo_30d_atras: formatBRL(pastBal),
              despesa_mensal: formatBRL(monthlyExpense),
            },
          },
          fingerprint: `idle_cash:${a.id}:${month}`,
        });
      }
    }
  }

  // 7) Reserva de emergência
  if (monthlyExpense > 0 && settings) {
    const liquidAssets = await tx
      .selectFrom('assets')
      .select('id')
      .where('id', 'in', [...pf.positions.map((p) => p.assetId), '00000000-0000-0000-0000-000000000000'])
      .where('liquidityDays', '=', 0)
      .execute();
    const liquidIds = new Set(liquidAssets.map((a) => a.id));
    const liquid =
      (pf.byClass.find((c) => c.assetClass === 'cash')?.valueCents ?? 0) +
      pf.positions.filter((p) => liquidIds.has(p.assetId)).reduce((a, p) => a + p.marketValueCents, 0);
    const months = liquid / monthlyExpense;
    const target = Number(settings.emergencyMonthsTarget);
    if (months < target) {
      out.push({
        rule: 'emergency_reserve',
        severity: months < target / 2 ? 'warning' : 'info',
        title: 'Reserva de emergência abaixo da meta',
        message: `Reserva cobre ${months.toFixed(1).replace('.', ',')} meses; sua meta é ${target}.`,
        payload: {
          rule_text:
            'Meses de despesa cobertos por saldo em conta e ativos com liquidez diária vs meta definida por você',
          numbers: {
            liquido: formatBRL(liquid),
            despesa_mensal: formatBRL(monthlyExpense),
            meses: Number(months.toFixed(2)),
            meta_meses: target,
          },
        },
        fingerprint: `emergency_reserve:${month}`,
      });
    }
  }

  // 8) Rebalanceamento
  for (const c of pf.byClass) {
    if (c.targetPct === null) continue;
    const dev = c.pct - c.targetPct;
    if (Math.abs(dev) > 5) {
      out.push({
        rule: 'rebalance',
        severity: 'info',
        title: `${CLASS_LABEL[c.assetClass]} fora da alocação-alvo`,
        message: `${CLASS_LABEL[c.assetClass]} está ${Math.abs(dev).toFixed(1).replace('.', ',')} p.p. ${dev > 0 ? 'acima' : 'abaixo'} do seu alvo (${c.targetPct}%).`,
        payload: {
          rule_text: 'Classe com desvio maior que 5 p.p. da alocação-alvo definida por você',
          numbers: {
            atual_pct: Number(c.pct.toFixed(2)),
            alvo_pct: c.targetPct,
            desvio_pp: Number(dev.toFixed(2)),
          },
        },
        fingerprint: `rebalance:${c.assetClass}:${month}`,
      });
    }
  }

  // 9) Proventos previstos (próximos 30 dias)
  const divs = await tx
    .selectFrom('plannedCashflows')
    .select([
      sql<number>`coalesce(sum(amount_cents), 0)::bigint`.as('cents'),
      sql<number>`count(*)::int`.as('n'),
    ])
    .where('workspaceId', '=', ws)
    .where('source', '=', 'dividend')
    .where('date', '>=', today)
    .where('date', '<=', addDays(today, 30))
    .executeTakeFirst();
  if (divs && Number(divs.cents) > 0) {
    out.push({
      rule: 'dividends',
      severity: 'info',
      title: 'Proventos previstos',
      message: `${formatBRL(Number(divs.cents))} em ${divs.n} provento(s) previstos nos próximos 30 dias; já estão na sua projeção.`,
      payload: {
        rule_text: 'Dividendos e JCP anunciados para os ativos que você tem',
        numbers: { total: formatBRL(Number(divs.cents)), quantidade: divs.n },
      },
      fingerprint: `dividends:${month}`,
    });
  }

  // 10) Calendário fiscal
  const m = Number(today.slice(5, 7));
  if ((m === 5 || m === 11) && funds.length) {
    out.push({
      rule: 'tax_calendar',
      severity: 'info',
      title: 'Come-cotas neste mês',
      message: `Em ${monthLabel(startOfMonth(today), true)} há come-cotas nos fundos de renda fixa e multimercado: a quantidade de cotas diminui pelo IR antecipado.`,
      payload: { rule_text: 'Come-cotas semestral (maio e novembro)', numbers: { fundos: funds.length } },
      fingerprint: `come_cotas:${month}`,
    });
  }
  const sales = await sql<{ cents: number }>`
    select coalesce(sum(t.total_cents), 0)::bigint as cents from trades t join assets a on a.id = t.asset_id
    where t.workspace_id = ${ws}::uuid and t.kind = 'sell' and a.kind = 'stock' and t.date >= ${startOfMonth(today)}::date and t.date <= ${today}::date`.execute(
    tx,
  );
  const salesCents = Number(sales.rows[0]?.cents ?? 0);
  if (salesCents > 0) {
    out.push({
      rule: 'tax_calendar',
      severity: salesCents > STOCK_SALES_EXEMPTION_CENTS ? 'warning' : 'info',
      title: 'Vendas de ações no mês',
      message: `Vendas de ações no mês: ${formatBRL(salesCents)}; limite de isenção configurado: ${formatBRL(STOCK_SALES_EXEMPTION_CENTS)}.`,
      payload: {
        rule_text: 'Soma das vendas de ações no mês vs limite de isenção parametrizado',
        numbers: { vendas: formatBRL(salesCents), limite: formatBRL(STOCK_SALES_EXEMPTION_CENTS) },
      },
      fingerprint: `stock_sales:${month}`,
    });
  }

  return out;
}

/** Grava insights novos, resolve os que deixaram de valer e respeita os silenciados. */
export async function refreshInsights(
  tx: Tx,
  ws: string,
  today: string,
): Promise<{ created: number; resolved: number }> {
  const muted = new Set(
    (await tx.selectFrom('insightMutes').select('rule').where('workspaceId', '=', ws).execute()).map(
      (r) => r.rule,
    ),
  );
  const fresh = (await computeInsights(tx, ws, today)).filter((i) => !muted.has(i.rule));
  const active = await tx
    .selectFrom('insights')
    .select(['id', 'fingerprint'])
    .where('workspaceId', '=', ws)
    .where('resolvedAt', 'is', null)
    .execute();
  const freshFp = new Set(fresh.map((f) => f.fingerprint));
  const stale = active.filter((a) => !freshFp.has(a.fingerprint));
  if (stale.length)
    await tx
      .updateTable('insights')
      .set({ resolvedAt: new Date() })
      .where(
        'id',
        'in',
        stale.map((s) => s.id),
      )
      .execute();
  const activeFp = new Set(active.map((a) => a.fingerprint));
  const toInsert = fresh.filter((f) => !activeFp.has(f.fingerprint));
  if (toInsert.length) {
    await tx
      .insertInto('insights')
      .values(
        toInsert.map((i) => ({
          workspaceId: ws,
          rule: i.rule,
          severity: i.severity,
          title: i.title,
          message: i.message,
          payload: JSON.stringify(i.payload),
          fingerprint: i.fingerprint,
        })),
      )
      .execute();
  }
  return { created: toInsert.length, resolved: stale.length };
}

export { latestBenchmark };
