import { addDays, addMonths, daysInMonth, isoFromParts, parseISO, type ISODate } from './dates.js';
import type { Cents } from './money.js';

/** Remove acentos e baixa a caixa. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Mesmo algoritmo de normalize_text() no SQL: só [a-z0-9] separados por espaço. */
export function normalizeDescription(s: string): string {
  return fold(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const UNITS: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  duzentas: 200,
  trezentos: 300,
  trezentas: 300,
  quatrocentos: 400,
  quatrocentas: 400,
  quinhentos: 500,
  quinhentas: 500,
  seiscentos: 600,
  seiscentas: 600,
  setecentos: 700,
  setecentas: 700,
  oitocentos: 800,
  oitocentas: 800,
  novecentos: 900,
  novecentas: 900,
};

/** "duzentos e trinta" → 230; "dois mil e quinhentos" → 2500; "um milhão" → 1000000. */
export function wordsToNumber(text: string): number | null {
  if (/\d/.test(text)) return null;
  const tokens = fold(text)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t !== 'e' && t !== 'reais' && t !== 'real' && t !== 'de');
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  let matched = false;
  for (const t of tokens) {
    if (t in UNITS) {
      current += UNITS[t]!;
      matched = true;
    } else if (t === 'mil') {
      total += (current || 1) * 1000;
      current = 0;
      matched = true;
    } else if (t === 'milhao' || t === 'milhoes') {
      total += (current || 1) * 1_000_000;
      current = 0;
      matched = true;
    } else if (t === 'centavos' || t === 'centavo') {
      // tratado em parseAmount
    } else {
      return null;
    }
  }
  return matched ? total + current : null;
}

/**
 * Interpreta valores em pt-BR e devolve centavos:
 * "230", "230,50", "1.234,56", "R$ 3.600", "2,3k", "3 mil", "1,5 mi", "duzentos e trinta".
 * Símbolo ou nome da moeda é ignorado ("US$ 200", "200 dólares"); a moeda vem da conta.
 */
export function parseAmount(input: string | number): Cents | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = fold(input)
    .replace(/(r|us|u)?\$\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\b(reais|real|dolares|dolar|usd|brl)$/, '');
  if (!s) return null;

  const words = wordsToNumber(s);
  if (words !== null) return words * 100;

  const m = s.match(/^(-?[\d.,]+)\s*(k|mil|mi|milhao|milhoes)?$/);
  if (!m) return null;
  let num = m[1]!;
  const suffix = m[2];

  const hasComma = num.includes(',');
  const hasDot = num.includes('.');
  if (hasComma && hasDot) {
    // o separador que aparece por último é o decimal
    if (num.lastIndexOf(',') > num.lastIndexOf('.')) num = num.replace(/\./g, '').replace(',', '.');
    else num = num.replace(/,/g, '');
  } else if (hasComma) {
    num = num.replace(',', '.');
  } else if (hasDot) {
    // "3.600" é milhar; "2.5" é decimal
    const parts = num.split('.');
    if (parts.length > 2 || parts[parts.length - 1]!.length === 3) num = num.replace(/\./g, '');
  }
  let value = Number(num);
  if (!Number.isFinite(value)) return null;
  if (suffix === 'k' || suffix === 'mil') value *= 1000;
  else if (suffix) value *= 1_000_000;
  return Math.round(value * 100);
}

const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'marco',
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

/**
 * Interpreta datas relativas em pt-BR. Datas sem ano assumem o ano corrente (ou o próximo quando
 * `future` e a data já passou). "dia 5" = dia 5 do mês corrente (ou próximo mês se `future`).
 */
export function parseRelativeDate(
  input: string,
  today: ISODate,
  opts: { future?: boolean } = {},
): ISODate | null {
  const s = fold(input).replace(/\s+/g, ' ').trim();
  const t = parseISO(today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'hoje' || s === 'agora') return today;
  if (s === 'ontem') return addDays(today, -1);
  if (s === 'anteontem') return addDays(today, -2);
  if (s === 'amanha') return addDays(today, 1);
  if (s === 'depois de amanha') return addDays(today, 2);
  if (/^(mes que vem|proximo mes)$/.test(s)) return addMonths(today, 1);
  if (/^(semana que vem|proxima semana)$/.test(s)) return addDays(today, 7);
  if (/^(mes passado)$/.test(s)) return addMonths(today, -1);

  let m = s.match(/^(?:ha|faz) (\d+) dias?$/);
  if (m) return addDays(today, -Number(m[1]));
  m = s.match(/^(?:daqui a|em) (\d+) dias?$/);
  if (m) return addDays(today, Number(m[1]));

  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : t.y;
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    let iso = isoFromParts(y, mo, d);
    if (!m[3] && opts.future && iso < today) iso = isoFromParts(y + 1, mo, d);
    return iso;
  }

  m = s.match(/^(?:(?:no |o )?(?:proximo )?dia )?(\d{1,2})(?: do mes que vem| do proximo mes)?$/);
  if (m && /dia|mes/.test(s)) {
    const d = Number(m[1]);
    let base = isoFromParts(t.y, t.m, 1);
    if (/mes que vem|proximo mes/.test(s) || ((opts.future || /proximo/.test(s)) && d < t.d))
      base = addMonths(base, 1);
    const b = parseISO(base);
    if (d < 1 || d > 31) return null;
    return isoFromParts(b.y, b.m, Math.min(d, daysInMonth(b.y, b.m)));
  }

  m = s.match(/^(?:dia )?(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?$/);
  if (m) {
    const mo = MONTH_NAMES.indexOf(m[2]!) + 1;
    if (mo < 1) return null;
    let y = m[3] ? Number(m[3]) : t.y;
    const d = Math.min(Number(m[1]), daysInMonth(y, mo));
    let iso = isoFromParts(y, mo, d);
    if (!m[3] && opts.future && iso < today) iso = isoFromParts(++y, mo, d);
    return iso;
  }

  const wd = WEEKDAYS.findIndex((w) =>
    s.replace(/^(na |no |ultima |ultimo |proxima |proximo )/, '').startsWith(w),
  );
  if (wd >= 0) {
    const todayWd = new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();
    const forward = /proxim/.test(s) || opts.future;
    if (forward) {
      const delta = (wd - todayWd + 7) % 7 || 7;
      return addDays(today, delta);
    }
    const delta = (todayWd - wd + 7) % 7 || 7;
    return addDays(today, -delta);
  }
  return null;
}

/** Retorna o primeiro dia do mês para expressões como "março", "dezembro de 2027", "mês que vem". */
export function parseMonth(input: string, today: ISODate): ISODate | null {
  const s = fold(input).trim();
  const t = parseISO(today);
  if (s === 'este mes' || s === 'esse mes' || s === 'mes atual') return isoFromParts(t.y, t.m, 1);
  if (s === 'mes que vem' || s === 'proximo mes') return addMonths(isoFromParts(t.y, t.m, 1), 1);
  if (s === 'mes passado') return addMonths(isoFromParts(t.y, t.m, 1), -1);
  const m = s.match(/^([a-z]+)(?:\/| de )?(\d{2,4})?$/);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n === m[1] || n.slice(0, 3) === m[1]);
  if (idx < 0) return null;
  let y = m[2] ? Number(m[2]) : t.y;
  if (y < 100) y += 2000;
  // sem ano: o próximo mês com esse nome a partir de hoje (inclui o corrente)
  if (!m[2] && idx + 1 < t.m) y += 1;
  return isoFromParts(y, idx + 1, 1);
}
