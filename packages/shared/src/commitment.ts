import type { ChatVisual, CommitmentLevel, CommitmentMonth } from './api-types.js';
import { MONTHS_SHORT, parseISO } from './dates.js';

/** Até 20% tranquilo; até 30% (margem que os bancos usam como referência) atenção; acima, alto. */
export const COMMITMENT_THRESHOLDS = { attention: 0.2, high: 0.3 } as const;

export function commitmentLevel(pct: number | null): CommitmentLevel {
  if (pct === null) return 'ok';
  if (pct > COMMITMENT_THRESHOLDS.high) return 'alto';
  if (pct > COMMITMENT_THRESHOLDS.attention) return 'atencao';
  return 'ok';
}

/** Mês da manchete: o atual se já tem parcelas; senão, o primeiro com parcelas (sempre com renda). */
export function commitmentHeadline(months: CommitmentMonth[]): CommitmentMonth | null {
  const withIncome = months.filter((m) => m.pct !== null);
  return withIncome.find((m) => m.committedCents > 0) ?? withIncome[0] ?? null;
}

/** 0,384 → "38%". */
export function formatPct(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

const BAR = '▇';
const BAR_MAX = 12;

/** Gráfico em texto para o WhatsApp: uma linha por mês, barra proporcional e alerta acima da referência. */
export function visualToText(v: ChatVisual, maxMonths = 12): string {
  const rows = v.months.slice(0, maxMonths);
  const top = Math.max(v.threshold, ...rows.map((r) => r.pct ?? 0));
  const lines = rows.map((r) => {
    const { m } = parseISO(r.month);
    const name = MONTHS_SHORT[m - 1]!.padEnd(3);
    if (r.pct === null) return `${name} sem renda prevista`;
    const bars = BAR.repeat(Math.max(r.pct > 0 ? 1 : 0, Math.round((r.pct / top) * BAR_MAX)));
    const added = r.addedCents ?? 0;
    const before = added && r.incomeCents ? (r.committedCents - added) / r.incomeCents : null;
    const value = before !== null ? `${formatPct(before)} → ${formatPct(r.pct)}` : formatPct(r.pct);
    return `${name} ${bars ? `${bars} ` : ''}${value}${r.pct > v.threshold ? ' ⚠️' : ''}`;
  });
  return [`📊 *${v.title}*`, '```', ...lines, '```'].join('\n');
}
