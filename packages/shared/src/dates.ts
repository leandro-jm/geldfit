import { TZDate } from '@date-fns/tz';

export const DEFAULT_TZ = 'America/Sao_Paulo';

/** Data ISO (YYYY-MM-DD) usada em todo o domínio. */
export type ISODate = string;

export function todayISO(tz = DEFAULT_TZ, now = new Date()): ISODate {
  const d = new TZDate(now.getTime(), tz);
  return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function isoFromParts(y: number, m: number, d: number): ISODate {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseISO(iso: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`data inválida: ${iso}`);
  return { y, m, d };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Dia p_day do mês, limitado ao último dia (31 em fevereiro vira 28/29). */
export function monthDay(y: number, m: number, day: number): ISODate {
  return isoFromParts(y, m, Math.min(day, daysInMonth(y, m)));
}

export function addMonths(iso: ISODate, n: number): ISODate {
  const { y, m, d } = parseISO(iso);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return monthDay(ny, nm, d);
}

export function addDays(iso: ISODate, n: number): ISODate {
  const { y, m, d } = parseISO(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return isoFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function startOfMonth(iso: ISODate): ISODate {
  const { y, m } = parseISO(iso);
  return isoFromParts(y, m, 1);
}

export function diffDays(a: ISODate, b: ISODate): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86_400_000);
}

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = [
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

export function monthLabel(iso: ISODate, long = false): string {
  const { y, m } = parseISO(iso);
  return long ? `${MONTHS_LONG[m - 1]} de ${y}` : `${MONTHS_SHORT[m - 1]}/${y}`;
}

export function formatDateBR(iso: ISODate): string {
  const { y, m, d } = parseISO(iso);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

export { MONTHS_LONG, MONTHS_SHORT };
