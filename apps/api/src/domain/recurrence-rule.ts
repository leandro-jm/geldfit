import { addDays, daysInMonth, isoFromParts, parseISO, type ISODate } from '@sf/shared';

/**
 * Subconjunto de RRULE suportado:
 *   FREQ=MONTHLY;BYMONTHDAY=5 (ou -1 = último dia);INTERVAL=n
 *   FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=n
 *   FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=10
 */
export interface Rule {
  freq: 'MONTHLY' | 'WEEKLY' | 'YEARLY';
  interval: number;
  byMonthDay?: number;
  byDay?: number[]; // 0 = domingo
  byMonth?: number;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAYS_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MONTHS_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

export function parseRule(rule: string): Rule {
  const parts = Object.fromEntries(
    rule
      .replace(/^RRULE:/, '')
      .split(';')
      .filter(Boolean)
      .map((p) => p.split('=') as [string, string]),
  );
  const freq = parts.FREQ as Rule['freq'];
  if (!['MONTHLY', 'WEEKLY', 'YEARLY'].includes(freq))
    throw new Error(`Frequência não suportada: ${parts.FREQ}`);
  const r: Rule = { freq, interval: Number(parts.INTERVAL ?? 1) };
  if (parts.BYMONTHDAY) r.byMonthDay = Number(parts.BYMONTHDAY);
  if (parts.BYMONTH) r.byMonth = Number(parts.BYMONTH);
  if (parts.BYDAY) r.byDay = parts.BYDAY.split(',').map((d: string) => DAYS.indexOf(d));
  if (r.interval < 1 || !Number.isInteger(r.interval)) throw new Error('INTERVAL inválido');
  if (r.byDay?.some((d) => d < 0)) throw new Error('BYDAY inválido');
  return r;
}

export function buildRule(r: Rule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byMonth) parts.push(`BYMONTH=${r.byMonth}`);
  if (r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay}`);
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => DAYS[d]).join(',')}`);
  return parts.join(';');
}

export function ruleText(rule: string): string {
  try {
    const r = parseRule(rule);
    const every = r.interval > 1 ? `a cada ${r.interval} ` : '';
    if (r.freq === 'MONTHLY') {
      const day = r.byMonthDay === -1 ? 'último dia' : `dia ${r.byMonthDay ?? 1}`;
      return r.interval > 1 ? `${every}meses, no ${day}` : `todo ${day}`;
    }
    if (r.freq === 'WEEKLY') {
      const days = (r.byDay ?? []).map((d) => DAYS_PT[d]).join(', ');
      return r.interval > 1 ? `${every}semanas (${days})` : `toda ${days || 'semana'}`;
    }
    return `todo ano em ${r.byMonthDay ?? 1} de ${MONTHS_PT[(r.byMonth ?? 1) - 1]}`;
  } catch {
    return rule;
  }
}

/** Ocorrências da regra no intervalo [from, to], respeitando start/end. */
export function occurrences(
  rule: string,
  start: ISODate,
  end: ISODate | null,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  const r = parseRule(rule);
  const lo = from > start ? from : start;
  const hi = end && end < to ? end : to;
  if (lo > hi) return [];
  const out: ISODate[] = [];
  const s = parseISO(start);

  if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    const step = r.freq === 'MONTHLY' ? r.interval : 12 * r.interval;
    let idx = s.y * 12 + (s.m - 1);
    if (r.freq === 'YEARLY' && r.byMonth) idx = s.y * 12 + (r.byMonth - 1);
    for (let guard = 0; guard < 2000; guard++, idx += step) {
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const dim = daysInMonth(y, m);
      const want = r.byMonthDay ?? s.d;
      const d = want === -1 ? dim : Math.min(want, dim);
      const iso = isoFromParts(y, m, d);
      if (iso > hi) break;
      if (iso >= lo && iso >= start) out.push(iso);
    }
    return out;
  }

  // WEEKLY: percorre dia a dia a partir do início da semana do start
  const days = r.byDay?.length ? r.byDay : [new Date(Date.UTC(s.y, s.m - 1, s.d)).getUTCDay()];
  const startWd = new Date(Date.UTC(s.y, s.m - 1, s.d)).getUTCDay();
  let weekStart = addDays(start, -startWd);
  for (let guard = 0; guard < 2000; guard++) {
    for (const wd of days) {
      const iso = addDays(weekStart, wd);
      if (iso >= lo && iso <= hi && iso >= start) out.push(iso);
    }
    weekStart = addDays(weekStart, 7 * r.interval);
    if (weekStart > hi) break;
  }
  return out.sort();
}

export function nextOccurrence(
  rule: string,
  start: ISODate,
  end: ISODate | null,
  from: ISODate,
): ISODate | null {
  const to = isoFromParts(parseISO(from).y + 2, parseISO(from).m, 1);
  return occurrences(rule, start, end, from, to)[0] ?? null;
}
