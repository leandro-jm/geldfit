import {
  addMonths,
  commitmentHeadline,
  commitmentLevel,
  COMMITMENT_THRESHOLDS,
  formatBRL,
  formatPct,
  monthLabel,
  startOfMonth,
  type ChatVisual,
  type CommitmentDTO,
  type CommitmentItem,
  type CommitmentMonth,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import { baseDescription } from './ledger.js';

interface ItemRow {
  m: string;
  key: string;
  kind: CommitmentItem['kind'];
  description: string;
  n: number | null;
  total: number | null;
  cents: number;
  lastM: string;
}

/**
 * Renda futura comprometida: por mês, parcelas (cartão pelo vencimento da fatura, carnê pela data)
 * e recorrências de saída com data final (financiamento, consórcio) sobre a renda recorrente do mês.
 * Vale o mês inteiro, lançado ou previsto, pago ou não, para numerador e denominador baterem.
 */
export async function computeCommitment(
  tx: Tx,
  ws: string,
  opts: { months?: number; today: string },
): Promise<CommitmentDTO> {
  const m0 = startOfMonth(opts.today);
  const n = Math.min(Math.max(opts.months ?? 12, 1), 24);
  const end = addMonths(m0, n);

  const items = await sql<ItemRow>`
    with rows as (
      select date_trunc('month', coalesce(st.due_date, t.date))::date as m,
        coalesce(t.installment_group_id, t.recurrence_id) as key,
        case when t.installment_group_id is null then 'financing'
             when t.card_id is not null then 'card' else 'carne' end as kind,
        t.description, t.installment_n, t.installment_total,
        case when t.direction = 'out' then t.amount_brl_cents else -t.amount_brl_cents end as cents
      from transactions t
      left join card_statements st on st.id = t.card_statement_id
      left join recurrences r on r.id = t.recurrence_id
      left join accounts a on a.id = t.account_id
      left join cards c on c.id = t.card_id
      where t.workspace_id = ${ws}::uuid and t.kind = 'regular'
        and (t.account_id is null or (a.archived_at is null and a.type <> 'investment'))
        and (t.card_id is null or c.archived_at is null)
        and (t.installment_group_id is not null or (r.end_date is not null and t.direction = 'out'))
    ),
    keyed as (select *, max(m) over (partition by key) as last_m from rows)
    select m::text, key::text, kind, max(description) as description,
      max(installment_n) as n, max(installment_total) as total,
      sum(cents)::bigint as cents, last_m::text
    from keyed
    where m >= ${m0}::date and m < ${end}::date
    group by m, key, kind, last_m
    having sum(cents) <> 0`.execute(tx);

  const income = await sql<{ m: string; cents: number }>`
    select date_trunc('month', t.date)::date::text as m, sum(t.amount_brl_cents)::bigint as cents
    from transactions t join accounts a on a.id = t.account_id
    where t.workspace_id = ${ws}::uuid and t.direction = 'in' and t.kind = 'regular'
      and t.recurrence_id is not null and a.archived_at is null and a.type <> 'investment'
      and t.date >= ${m0}::date and t.date < ${end}::date
    group by 1`.execute(tx);
  const incomeBy = new Map(income.rows.map((r) => [r.m, Number(r.cents)]));

  const byMonth = new Map<string, CommitmentItem[]>();
  const releases = new Map<string, CommitmentDTO['releases'][number]>();
  for (const r of items.rows) {
    const label = baseDescription(r.description);
    const it: CommitmentItem = {
      label,
      cents: Number(r.cents),
      kind: r.kind,
      n: r.n,
      total: r.total,
      endsThisMonth: r.lastM === r.m,
    };
    (byMonth.get(r.m) ?? byMonth.set(r.m, []).get(r.m)!).push(it);
    if (it.endsThisMonth && it.cents > 0) releases.set(r.key, { month: r.m, label, cents: it.cents });
  }

  const months: CommitmentMonth[] = Array.from({ length: n }, (_, i) => {
    const month = addMonths(m0, i);
    const list = (byMonth.get(month) ?? []).sort((a, b) => b.cents - a.cents);
    const committedCents = list.reduce((s, it) => s + it.cents, 0);
    const incomeCents = incomeBy.get(month) ?? 0;
    const pct = incomeCents > 0 ? committedCents / incomeCents : null;
    return { month, incomeCents, committedCents, pct, level: commitmentLevel(pct), items: list.slice(0, 5) };
  });

  const peak = months.reduce<CommitmentMonth | null>(
    (acc, m) => (m.pct !== null && (!acc || m.pct > acc.pct!) ? m : acc),
    null,
  );
  return {
    months,
    threshold: COMMITMENT_THRESHOLDS.high,
    peak: peak ? { month: peak.month, pct: peak.pct! } : null,
    releases: [...releases.values()].sort((a, b) => a.month.localeCompare(b.month) || b.cents - a.cents),
  };
}

const short = (m: string) => monthLabel(m);

/** Resposta em uma ou duas frases, no estilo de safeToSpendAnswer. */
export function commitmentAnswer(c: CommitmentDTO): string {
  const committed = c.months.filter((m) => m.committedCents > 0);
  const withIncome = c.months.filter((m) => m.pct !== null);
  if (!withIncome.length) {
    const next = committed[0];
    return [
      'Não encontrei renda recorrente cadastrada (salário, pró-labore), então não dá para calcular o percentual comprometido.',
      next ? `Só de parcelas, ${monthLabel(next.month, true)} já tem ${formatBRL(next.committedCents)}.` : '',
      'Cadastre o salário como recorrência para eu acompanhar.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (!committed.length)
    return `Nenhuma parcela comprometendo sua renda nos próximos ${c.months.length} meses.`;

  const head = commitmentHeadline(c.months)!;
  const parts = [
    `${formatPct(head.pct!)} da renda de ${monthLabel(head.month, true)} já está comprometida com parcelas (${formatBRL(head.committedCents)} de ${formatBRL(head.incomeCents)}).`,
  ];
  if (c.peak && c.peak.month !== head.month && Math.round(c.peak.pct * 100) > Math.round(head.pct! * 100))
    parts.push(`O pico é ${formatPct(c.peak.pct)} em ${short(c.peak.month)}.`);
  const release = c.releases.find((r) => r.month >= head.month);
  if (release) {
    const after = c.months.find((m) => m.month === addMonths(release.month, 1));
    parts.push(
      `Em ${short(release.month)} termina ${release.label} (${formatBRL(release.cents)})${
        after?.pct == null
          ? ''
          : after.committedCents > 0
            ? `; a partir de ${short(after.month)} o comprometimento fica em ${formatPct(after.pct)}`
            : `; a partir de ${short(after.month)} a renda fica livre de parcelas`
      }.`,
    );
  }
  if (c.peak && c.peak.pct > c.threshold)
    parts.push(
      `Acima de ${formatPct(c.threshold)} da renda, a referência que os bancos usam como limite, qualquer imprevisto aperta.`,
    );
  return parts.join(' ');
}

/** Gráfico para o chat; com `before`, marca o que a compra avaliada acrescenta em cada mês. */
export function commitmentVisual(c: CommitmentDTO, before?: CommitmentDTO, title?: string): ChatVisual {
  const prev = new Map(before?.months.map((m) => [m.month, m.committedCents]));
  return {
    type: 'commitment',
    title: title ?? 'Renda comprometida com parcelas',
    threshold: c.threshold,
    months: c.months.map((m) => ({
      month: m.month,
      pct: m.pct,
      committedCents: m.committedCents,
      incomeCents: m.incomeCents,
      ...(before ? { addedCents: Math.max(0, m.committedCents - (prev.get(m.month) ?? 0)) } : {}),
    })),
  };
}
