import Papa from 'papaparse';
import { fold, parseAmount } from '@sf/shared';

export interface CsvMapping {
  dateCol: number;
  descriptionCol: number;
  amountCol: number | null; // valor com sinal
  debitCol: number | null;
  creditCol: number | null;
  dateFormat: 'dmy' | 'ymd' | 'mdy';
  headerRow: number;
}

export interface CsvTransaction {
  date: string;
  amountCents: number;
  direction: 'in' | 'out';
  description: string;
}

export function readCsv(text: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true, delimiter: '' });
  return res.data.filter((r) => r.some((c) => c && c.trim()));
}

const DATE = /^(data|date|dt|data lancamento|data do lancamento|data movimento|data transacao)$/;
const DESC =
  /^(descricao|historico|lancamento|memo|detalhe|detalhes|estabelecimento|title|description|identificacao)$/;
const AMOUNT = /^(valor|amount|quantia|valor r\$|valor \(r\$\)|valor rs)$/;
const DEBIT = /^(debito|saida|saidas|debitos|valor debito)$/;
const CREDIT = /^(credito|entrada|entradas|creditos|valor credito)$/;

/** Tenta reconhecer o cabeçalho nas 10 primeiras linhas. */
export function guessMapping(rows: string[][]): CsvMapping | null {
  for (let h = 0; h < Math.min(10, rows.length); h++) {
    const header = rows[h]!.map((c) => fold(c).replace(/\s+/g, ' ').trim());
    const find = (re: RegExp) => header.findIndex((c) => re.test(c));
    const dateCol = find(DATE);
    const descriptionCol = find(DESC);
    const amountCol = find(AMOUNT);
    const debitCol = find(DEBIT);
    const creditCol = find(CREDIT);
    if (dateCol >= 0 && descriptionCol >= 0 && (amountCol >= 0 || debitCol >= 0 || creditCol >= 0)) {
      const sample = rows.slice(h + 1, h + 6).map((r) => r[dateCol] ?? '');
      return {
        dateCol,
        descriptionCol,
        amountCol: amountCol >= 0 ? amountCol : null,
        debitCol: debitCol >= 0 ? debitCol : null,
        creditCol: creditCol >= 0 ? creditCol : null,
        dateFormat: sample.some((s) => /^\d{4}-/.test(s)) ? 'ymd' : 'dmy',
        headerRow: h,
      };
    }
  }
  return null;
}

function parseDate(v: string, fmt: CsvMapping['dateFormat']): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (!m) return null;
  let [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 100) y += 2000;
  const [d, mo] = fmt === 'mdy' ? [b, a] : [a, b];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function signedCents(v: string | undefined): number | null {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  const negative = /^-|\(.*\)|^\s*d\s*$|\sd$/i.test(s) || s.startsWith('−');
  const c = parseAmount(s.replace(/[()−-]/g, '').replace(/\s*[dc]$/i, ''));
  if (c === null) return null;
  return negative ? -c : c;
}

export function applyMapping(
  rows: string[][],
  map: CsvMapping,
): { items: CsvTransaction[]; skipped: number } {
  const items: CsvTransaction[] = [];
  let skipped = 0;
  for (const r of rows.slice(map.headerRow + 1)) {
    const date = parseDate(r[map.dateCol] ?? '', map.dateFormat);
    const description = (r[map.descriptionCol] ?? '').trim();
    let cents: number | null = null;
    if (map.amountCol !== null) cents = signedCents(r[map.amountCol]);
    else {
      const debit = map.debitCol !== null ? signedCents(r[map.debitCol]) : null;
      const credit = map.creditCol !== null ? signedCents(r[map.creditCol]) : null;
      if (debit) cents = -Math.abs(debit);
      else if (credit) cents = Math.abs(credit);
    }
    // linhas de saldo/totais não são lançamentos
    if (!date || cents === null || cents === 0 || /^saldo|^total/i.test(fold(description))) {
      skipped++;
      continue;
    }
    items.push({
      date,
      amountCents: Math.abs(cents),
      direction: cents > 0 ? 'in' : 'out',
      description: description || 'Sem descrição',
    });
  }
  return { items, skipped };
}
