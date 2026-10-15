import {
  addDays,
  addMonths,
  daysInMonth,
  formatBRL,
  formatDateBR,
  monthLabel,
  parseISO,
  type AccountShortfall,
  type EmergencyReserveDTO,
  type PortfolioDTO,
  type ProjectionDTO,
  type SafeToSpendDTO,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { buildPortfolio } from './portfolio.js';
import { computeProjection } from './projection.js';
import { listAccounts } from './queries.js';

/**
 * Folga a partir da projeção mensal: um gasto extra hoje reduz o saldo de todos os meses seguintes
 * pelo mesmo valor, então o máximo que cabe sem furar o piso é (menor saldo dos 24 meses − piso).
 * Compra no cartão só pesa a partir do vencimento da fatura, então o número é conservador.
 */
export function safeToSpendFrom(
  proj: ProjectionDTO,
  today: string,
): Omit<SafeToSpendDTO, 'shortfalls' | 'computedAt'> {
  const months = proj.months;
  const minBase = months.length ? Math.min(...months.map((m) => m.closingCents)) : 0;
  const minPes = months.length ? Math.min(...months.map((m) => m.closingPessimisticCents)) : 0;
  const headroom = minBase - proj.floorCents;
  const { y, m, d } = parseISO(today);
  const daysLeft = daysInMonth(y, m) - d + 1;
  const variableLeft = months[0]?.variableCents ?? 0;
  // "apertado": a folga não cobre um mês típico de gastos do dia a dia
  const typicalMonth = months[1]?.variableCents ?? variableLeft;
  return {
    extraCents: Math.max(0, headroom),
    conservativeExtraCents: Math.max(0, minPes - proj.floorCents),
    deficitCents: Math.max(0, -headroom),
    limitingMonth: months.length ? (proj.minClosing?.month ?? null) : null,
    floorCents: proj.floorCents,
    firstBelowFloor: proj.firstBelowFloor,
    monthVariableLeftCents: variableLeft,
    dailyCents: Math.floor(variableLeft / daysLeft),
    daysLeft,
    status: headroom <= 0 ? 'over' : headroom < typicalMonth ? 'tight' : 'ok',
  };
}

export async function safeToSpend(tx: Tx, ws: string, today: string): Promise<SafeToSpendDTO> {
  const proj = await computeProjection(tx, ws);
  return {
    ...safeToSpendFrom(proj, today),
    shortfalls: await accountShortfalls(tx, ws, today),
    computedAt: proj.computedAt,
  };
}

export function safeToSpendAnswer(s: SafeToSpendDTO): string {
  const parts: string[] = [];
  if (s.status === 'over') {
    parts.push(
      `Não há folga: a projeção já fica abaixo do piso de ${formatBRL(s.floorCents)}${s.firstBelowFloor ? ` em ${monthLabel(s.firstBelowFloor, true)}` : ''}. Faltam ${formatBRL(s.deficitCents)} para voltar ao piso.`,
    );
  } else {
    parts.push(
      `Folga para gastos extras: ${formatBRL(s.extraCents)} sem nenhum mês fechar abaixo do piso de ${formatBRL(s.floorCents)}${s.limitingMonth ? ` (o mês mais apertado é ${monthLabel(s.limitingMonth, true)})` : ''}.`,
    );
    if (s.conservativeExtraCents < s.extraCents)
      parts.push(`No cenário pessimista, a folga cai para ${formatBRL(s.conservativeExtraCents)}.`);
  }
  parts.push(
    s.monthVariableLeftCents > 0
      ? `Para o dia a dia, o seu ritmo normal ainda prevê ${formatBRL(s.monthVariableLeftCents)} até o fim do mês (≈ ${formatBRL(s.dailyCents)} por dia).`
      : 'O gasto do dia a dia previsto para este mês já foi usado.',
  );
  for (const f of s.shortfalls) parts.push(shortfallSentence(f));
  return parts.join(' ');
}

export function shortfallSentence(f: AccountShortfall): string {
  const cause = f.cause ? ` (${f.cause.description} ${formatBRL(f.cause.amountCents)})` : '';
  const fix = f.suggestion
    ? ` Dá para cobrir com ${formatBRL(f.suggestion.amountCents)} da ${f.suggestion.fromAccountName} até ${formatDateBR(f.suggestion.date)}.`
    : '';
  return `Atenção: em ${formatDateBR(f.date)} a conta ${f.accountName} fica em ${formatBRL(f.balanceCents)}${cause}.${fix}`;
}

interface Event {
  accountId: string;
  date: string;
  delta: number;
  description: string;
  amountCents: number;
}

/**
 * Caminha dia a dia o saldo de cada conta em reais (agendados, lançamentos futuros e faturas
 * debitadas na conta do cartão) e aponta a primeira data em que ela fica negativa. Sugere uma
 * transferência de outra conta que aguente o valor durante todo o horizonte.
 * Gastos do dia a dia sem conta definida não entram: a projeção mensal já cuida deles.
 */
export async function accountShortfalls(
  tx: Tx,
  ws: string,
  today: string,
  days = 35,
): Promise<AccountShortfall[]> {
  const until = addDays(today, days);
  const accounts = await sql<{ id: string; name: string; balance: number }>`
    select a.id, a.name, account_balance(a.id, ${today}::date)::bigint as balance
    from accounts a
    where a.workspace_id = ${ws}::uuid and a.archived_at is null and a.type <> 'investment' and a.currency = 'BRL'
    order by a.created_at`.execute(tx);
  if (!accounts.rows.length) return [];
  const ids = accounts.rows.map((a) => a.id);
  const events = await sql<Event>`
    select t.account_id as "accountId", greatest(t.date, ${today}::date)::text as date,
      (case when t.direction = 'in' then t.amount_cents else -t.amount_cents end)::bigint as delta,
      t.description, t.amount_cents::bigint as "amountCents"
    from transactions t
    where t.account_id = any(${ids}::uuid[]) and t.kind <> 'card_payment'
      and (t.status = 'scheduled' or t.date > ${today}::date) and t.date <= ${until}::date
    union all
    select c.account_id, greatest(st.due_date, ${today}::date)::text,
      -(st.total_cents - st.paid_cents)::bigint, 'Fatura ' || c.name, (st.total_cents - st.paid_cents)::bigint
    from card_statement_totals st join cards c on c.id = st.card_id
    where c.account_id = any(${ids}::uuid[]) and st.status <> 'paid' and st.total_cents > st.paid_cents
      and st.due_date <= ${until}::date and st.due_date >= ${addDays(today, -40)}::date`.execute(tx);

  // saldo ao fim de cada dia com movimento, por conta
  const walks = accounts.rows.map((a) => {
    const evs = events.rows
      .filter((e) => e.accountId === a.id)
      .map((e) => ({ ...e, delta: Number(e.delta), amountCents: Number(e.amountCents) }));
    const dates = [...new Set(evs.map((e) => e.date))].sort();
    let bal = Number(a.balance);
    const points = [{ date: today, balance: bal, events: [] as typeof evs }];
    for (const d of dates) {
      const dayEvents = evs.filter((e) => e.date === d);
      bal += dayEvents.reduce((s, e) => s + e.delta, 0);
      if (d === today) {
        points[0] = { date: d, balance: bal, events: dayEvents };
      } else points.push({ date: d, balance: bal, events: dayEvents });
    }
    return { account: a, points, min: Math.min(...points.map((p) => p.balance)) };
  });

  const out: AccountShortfall[] = [];
  for (const w of walks) {
    const first = w.points.find((p) => p.balance < 0);
    if (!first) continue;
    const biggestOut = first.events
      .filter((e) => e.delta < 0)
      .sort((a, b) => b.amountCents - a.amountCents)[0];
    const need = Math.ceil(-w.min / 1000) * 1000; // arredonda para cima, em múltiplos de R$ 10
    const transferDate = first.date > today ? addDays(first.date, -1) : today;
    // outra conta que fique com saldo ≥ necessidade em todo o horizonte
    const source = walks
      .filter((o) => o.account.id !== w.account.id && o.min >= need)
      .sort((a, b) => b.min - a.min)[0];
    out.push({
      accountId: w.account.id,
      accountName: w.account.name,
      date: first.date,
      balanceCents: first.balance,
      minCents: w.min,
      cause: biggestOut ? { description: biggestOut.description, amountCents: biggestOut.amountCents } : null,
      suggestion: source
        ? {
            fromAccountId: source.account.id,
            fromAccountName: source.account.name,
            amountCents: need,
            date: transferDate,
          }
        : null,
    });
  }
  return out;
}

// Salário e afins: o que para num desligamento (categoria ou descrição, sem acento)
const SALARY_RE = String.raw`\m(salario|pro labore|prolabore|holerite|folha de pagamento|decimo terceiro|ferias)\M`;

/** Reserva disponível num desligamento: contas, contas de investimento e ativos com liquidez diária. */
async function liquidReserve(tx: Tx, ws: string, today: string, pf?: PortfolioDTO) {
  const accounts = await listAccounts(tx, ws, today);
  const accountsCents = accounts
    .filter((a) => a.type !== 'investment')
    .reduce((s, a) => s + Math.max(0, a.balanceBrlCents), 0);
  const investmentAccounts = accounts
    .filter((a) => a.type === 'investment')
    .reduce((s, a) => s + Math.max(0, a.balanceBrlCents), 0);
  const portfolio = pf ?? (await buildPortfolio(tx, ws, today));
  const ids = portfolio.positions.map((p) => p.assetId);
  const liquid = ids.length
    ? new Set(
        (
          await tx
            .selectFrom('assets')
            .select('id')
            .where('id', 'in', ids)
            .where('liquidityDays', '=', 0)
            .execute()
        ).map((a) => a.id),
      )
    : new Set<string>();
  const positions = portfolio.positions
    .filter((p) => liquid.has(p.assetId) || p.assetClass === 'cash')
    .reduce((s, p) => s + p.marketValueCents, 0);
  return { accountsCents, investmentsCents: investmentAccounts + positions };
}

/**
 * Quantos meses a reserva paga as contas se a renda do trabalho parar hoje. Usa a projeção mês a
 * mês (parcelas que acabam, contas anuais, faturas já feitas), tira os salários e os aportes, e
 * mantém as demais receitas. O mês corrente conta só pelos dias que faltam.
 */
export async function emergencyReserve(
  tx: Tx,
  ws: string,
  today: string,
  pf?: PortfolioDTO,
): Promise<EmergencyReserveDTO> {
  const proj = await computeProjection(tx, ws);
  const { accountsCents, investmentsCents } = await liquidReserve(tx, ws, today, pf);
  const reserveCents = accountsCents + investmentsCents;
  const end = proj.months.length ? addMonths(proj.months.at(-1)!.month, 1) : today;

  // Ajustes por mês sobre a projeção: salário que deixa de entrar e transferências de/para
  // contas de investimento (aportes param; resgates já estão contados na reserva)
  const adj = await sql<{ m: string; salary: number; trOut: number; trIn: number }>`
    select date_trunc('month', greatest(t.date, ${today}::date))::date::text as m,
      coalesce(sum(t.amount_brl_cents) filter (where t.direction = 'in' and t.kind = 'regular'
        and normalize_text(coalesce(c.name, '') || ' ' || t.description) ~ ${SALARY_RE}), 0)::bigint as salary,
      coalesce(sum(t.amount_brl_cents) filter (where t.kind = 'transfer' and t.direction = 'out'), 0)::bigint as "trOut",
      coalesce(sum(t.amount_brl_cents) filter (where t.kind = 'transfer' and t.direction = 'in'), 0)::bigint as "trIn"
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where t.workspace_id = ${ws}::uuid and a.archived_at is null and a.type <> 'investment'
      and (t.status = 'scheduled' or t.date > ${today}::date) and t.date < ${end}::date
      and t.kind <> 'card_payment'
      -- transferência entre contas do dia a dia não entra na projeção consolidada
      and not (t.kind = 'transfer' and exists (
        select 1 from transactions t2 join accounts a2 on a2.id = t2.account_id
        where t2.transfer_id = t.transfer_id and t2.id <> t.id and a2.type <> 'investment' and a2.archived_at is null))
    group by 1`.execute(tx);
  const byMonth = new Map(adj.rows.map((r) => [r.m, r]));

  const salaries = await sql<{ description: string; amountCents: number }>`
    select r.description, r.amount_cents::bigint as "amountCents"
    from recurrences r join accounts a on a.id = r.account_id left join categories c on c.id = r.category_id
    where r.workspace_id = ${ws}::uuid and r.direction = 'in' and r.paused_at is null
      and (r.end_date is null or r.end_date >= ${today}::date) and a.archived_at is null
      and normalize_text(coalesce(c.name, '') || ' ' || r.description) ~ ${SALARY_RE}
    order by r.amount_cents desc`.execute(tx);

  const { y, m, d } = parseISO(today);
  const firstMonthShare = (daysInMonth(y, m) - d + 1) / daysInMonth(y, m);
  const flows = proj.months.map((pm) => {
    const a = byMonth.get(pm.month);
    const income = pm.incomeCents - Number(a?.salary ?? 0) - Number(a?.trIn ?? 0);
    const cost = pm.expenseCents - Number(a?.trOut ?? 0) + pm.cardBillsCents + pm.variableCents;
    return { month: pm.month, income, cost };
  });

  let balance = reserveCents;
  let covered = 0;
  let runsOutMonth: string | null = null;
  const timeline: EmergencyReserveDTO['timeline'] = [];
  flows.forEach((f, i) => {
    const share = i === 0 ? firstMonthShare : 1;
    const net = f.income - f.cost;
    if (runsOutMonth === null) {
      if (balance + net >= 0) covered += share;
      else {
        covered += share * (balance / -net);
        runsOutMonth = f.month;
      }
    }
    balance += net;
    timeline.push({ month: f.month, balanceCents: balance });
  });

  const next12 = flows.slice(1, 13);
  const avg = (k: 'income' | 'cost') =>
    next12.length ? Math.round(next12.reduce((s, f) => s + f[k], 0) / next12.length) : 0;
  const settings = await tx
    .selectFrom('workspaceSettings')
    .select('emergencyMonthsTarget')
    .where('workspaceId', '=', ws)
    .executeTakeFirst();
  const targetMonths = Number(settings?.emergencyMonthsTarget ?? 6);
  const months = runsOutMonth ? Math.round(covered * 10) / 10 : null;
  return {
    reserveCents,
    breakdown: { accountsCents, investmentsCents },
    months,
    runsOutMonth,
    monthlyCostCents: avg('cost'),
    otherIncomeCents: avg('income'),
    salaries: salaries.rows.map((s) => ({ description: s.description, amountCents: Number(s.amountCents) })),
    targetMonths,
    status:
      months === null || months >= targetMonths ? 'ok' : months >= targetMonths / 2 ? 'low' : 'critical',
    timeline,
  };
}

export function emergencyReserveAnswer(r: EmergencyReserveDTO): string {
  const fmtMonths = (n: number) =>
    `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${n === 1 ? 'mês' : 'meses'}`;
  const parts = [
    r.months === null
      ? `Sem salário, sua reserva de ${formatBRL(r.reserveCents)} cobre as contas por mais de 24 meses.`
      : `Sem salário, sua reserva de ${formatBRL(r.reserveCents)} paga as contas por ${fmtMonths(r.months)} (acaba em ${monthLabel(r.runsOutMonth!, true)}). Sua meta é ${fmtMonths(r.targetMonths)}.`,
    `Custo médio de ${formatBRL(r.monthlyCostCents)} por mês${r.otherIncomeCents > 0 ? `, com ${formatBRL(r.otherIncomeCents)} de outras receitas que continuam` : ''}.`,
    r.salaries.length
      ? `Considerei que param: ${r.salaries.map((s) => `${s.description} (${formatBRL(s.amountCents)})`).join(', ')}.`
      : 'Não encontrei salário recorrente cadastrado; considerei só as receitas já previstas.',
    'Não inclui FGTS, multa de 40%, verbas rescisórias nem seguro-desemprego, que aumentam esse prazo.',
  ];
  return parts.join(' ');
}
