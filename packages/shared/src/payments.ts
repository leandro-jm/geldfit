import { addDays, diffDays, type ISODate } from './dates.js';
import type { Cents } from './money.js';

/**
 * Leitura determinística de códigos de pagamento brasileiros (sem LLM):
 *   - boleto bancário: linha digitável (47 dígitos) ou código de barras (44);
 *   - boleto de convênio/arrecadação (contas de consumo, tributos): linha (48) ou barras (44, começa com 8);
 *   - Pix copia e cola (BR Code EMV, com CRC16).
 * Os dígitos verificadores são conferidos: um código copiado errado é recusado em vez de virar
 * um valor ou vencimento errado.
 */
export interface PaymentCode {
  kind: 'boleto' | 'convenio' | 'pix';
  amountCents: Cents | null;
  dueDate: ISODate | null;
  /** Banco emissor (boleto), segmento (convênio) ou recebedor (Pix). */
  payee: string | null;
  /** Código de barras com 44 dígitos (boletos). */
  barcode?: string;
  bankCode?: string;
  pixKey?: string | null;
  pixUrl?: string | null;
  txid?: string | null;
  city?: string | null;
  /** Pix dinâmico (cobrança com URL): o valor final é definido pelo recebedor. */
  dynamic?: boolean;
}

export type PaymentCodeResult = { ok: true; code: PaymentCode } | { ok: false; error: string };

const BANKS: Record<string, string> = {
  '001': 'Banco do Brasil',
  '004': 'Banco do Nordeste',
  '021': 'Banestes',
  '033': 'Santander',
  '041': 'Banrisul',
  '070': 'BRB',
  '077': 'Inter',
  '102': 'XP',
  '104': 'Caixa',
  '133': 'Cresol',
  '208': 'BTG Pactual',
  '212': 'Banco Original',
  '237': 'Bradesco',
  '260': 'Nubank',
  '290': 'PagBank',
  '323': 'Mercado Pago',
  '336': 'C6 Bank',
  '341': 'Itaú',
  '380': 'PicPay',
  '422': 'Safra',
  '748': 'Sicredi',
  '756': 'Sicoob',
};

const SEGMENTS: Record<string, string> = {
  '1': 'Prefeitura',
  '2': 'Saneamento',
  '3': 'Energia elétrica e gás',
  '4': 'Telecomunicações',
  '5': 'Órgão governamental',
  '6': 'Carnê',
  '7': 'Multa de trânsito',
  '9': 'Banco',
};

export function bankName(code: string): string | null {
  return BANKS[code] ?? null;
}

/** Módulo 10 (pesos 2,1,2,1… da direita para a esquerda, somando os dígitos dos produtos). */
export function mod10(digits: string): number {
  let sum = 0;
  let w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    let p = Number(digits[i]) * w;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    w = w === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** Soma ponderada do módulo 11 (pesos 2..9 da direita para a esquerda). */
function mod11Rest(digits: string): number {
  let sum = 0;
  let w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  return sum % 11;
}

/** DV geral do boleto bancário: 0, 10 e 11 viram 1. */
export function mod11Boleto(digits: string): number {
  const dv = 11 - mod11Rest(digits);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** DV de convênio pelo módulo 11: restos 0 e 1 viram 0. */
export function mod11Convenio(digits: string): number {
  const r = mod11Rest(digits);
  return r <= 1 ? 0 : 11 - r;
}

/**
 * Fator de vencimento → data. O fator chegou a 9999 em 21/02/2025 e recomeçou em 1000 no dia
 * seguinte; entre as duas leituras possíveis, fica a mais próxima de hoje.
 */
export function dueDateFromFactor(factor: number, today: ISODate): ISODate | null {
  if (!factor) return null;
  const candidates = [addDays('1997-10-07', factor)];
  if (factor >= 1000) candidates.push(addDays('2025-02-22', factor - 1000));
  return candidates.sort((a, b) => Math.abs(diffDays(a, today)) - Math.abs(diffDays(b, today)))[0]!;
}

function boletoFromBarcode(barcode: string, today: ISODate): PaymentCodeResult {
  const dv = Number(barcode[4]);
  if (mod11Boleto(barcode.slice(0, 4) + barcode.slice(5)) !== dv)
    return { ok: false, error: 'O dígito verificador do boleto não confere. Confira o código.' };
  const bankCode = barcode.slice(0, 3);
  const amount = Number(barcode.slice(9, 19));
  return {
    ok: true,
    code: {
      kind: 'boleto',
      barcode,
      bankCode,
      payee: bankName(bankCode),
      amountCents: amount > 0 ? amount : null,
      dueDate: dueDateFromFactor(Number(barcode.slice(5, 9)), today),
    },
  };
}

function convenioFromBarcode(barcode: string): PaymentCodeResult {
  const valueId = barcode[2]!;
  if (!'6789'.includes(valueId)) return { ok: false, error: 'Código de convênio inválido.' };
  const calc = valueId === '6' || valueId === '7' ? mod10 : mod11Convenio;
  if (calc(barcode.slice(0, 3) + barcode.slice(4)) !== Number(barcode[3]))
    return { ok: false, error: 'O dígito verificador da conta não confere. Confira o código.' };
  const amount = Number(barcode.slice(4, 15));
  return {
    ok: true,
    code: {
      kind: 'convenio',
      barcode,
      payee: SEGMENTS[barcode[1]!] ?? null,
      // 7 e 9 indicam valor de referência (não é valor em reais)
      amountCents: (valueId === '6' || valueId === '8') && amount > 0 ? amount : null,
      dueDate: null,
    },
  };
}

function parseDigits(d: string, today: ISODate): PaymentCodeResult {
  if (d.length === 44) return d[0] === '8' ? convenioFromBarcode(d) : boletoFromBarcode(d, today);
  if (d.length === 47) {
    const fields: Array<[string, number]> = [
      [d.slice(0, 9), Number(d[9])],
      [d.slice(10, 20), Number(d[20])],
      [d.slice(21, 31), Number(d[31])],
    ];
    if (fields.some(([f, dv]) => mod10(f) !== dv))
      return { ok: false, error: 'A linha digitável do boleto tem um dígito errado. Confira o código.' };
    const barcode =
      d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
    return boletoFromBarcode(barcode, today);
  }
  if (d.length === 48 && d[0] === '8') {
    const valueId = d[2]!;
    const calc = valueId === '6' || valueId === '7' ? mod10 : mod11Convenio;
    const blocks = [0, 1, 2, 3].map((i) => d.slice(i * 12, i * 12 + 12));
    if (blocks.some((b) => calc(b.slice(0, 11)) !== Number(b[11])))
      return { ok: false, error: 'A linha digitável da conta tem um dígito errado. Confira o código.' };
    return convenioFromBarcode(blocks.map((b) => b.slice(0, 11)).join(''));
  }
  return {
    ok: false,
    error: 'Não reconheci o código: boletos têm 47 ou 48 dígitos (ou 44 no código de barras).',
  };
}

// --- Pix (BR Code / EMV MPM) -------------------------------------------------------------------

/** CRC16/CCITT-FALSE (poli 0x1021, inicial 0xFFFF), como exige o BR Code. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(s: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) return null;
    out.set(id, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

function parsePix(payload: string): PaymentCodeResult {
  const crcAt = payload.lastIndexOf('6304');
  if (crcAt < 0 || payload.length !== crcAt + 8)
    return { ok: false, error: 'O Pix copia e cola está incompleto. Copie o código inteiro.' };
  if (crc16(payload.slice(0, crcAt + 4)) !== payload.slice(crcAt + 4).toUpperCase())
    return { ok: false, error: 'O Pix copia e cola está corrompido (CRC não confere). Copie de novo.' };
  const top = tlv(payload.slice(0, crcAt));
  if (!top || top.get('00') !== '01') return { ok: false, error: 'Código Pix inválido.' };
  let account: Map<string, string> | null = null;
  for (let id = 26; id <= 51; id++) {
    const sub = tlv(top.get(String(id)) ?? '');
    if (sub && sub.get('00')?.toLowerCase() === 'br.gov.bcb.pix') {
      account = sub;
      break;
    }
  }
  if (!account) return { ok: false, error: 'O código não é um Pix.' };
  const amount = top.get('54');
  const txid = tlv(top.get('62') ?? '')?.get('05') ?? null;
  return {
    ok: true,
    code: {
      kind: 'pix',
      pixKey: account.get('01') ?? null,
      pixUrl: account.get('25') ?? null,
      dynamic: account.has('25') || top.get('01') === '12',
      amountCents: amount && Number(amount) > 0 ? Math.round(Number(amount) * 100) : null,
      dueDate: null,
      payee: top.get('59')?.trim() || null,
      city: top.get('60')?.trim() || null,
      txid: txid && txid !== '***' ? txid : null,
    },
  };
}

const PIX_RE = /000201[\s\S]*?6304[0-9A-Fa-f]{4}/;
const DIGITS_RE = /\d[\d .\-]{42,70}\d/g;

/** Procura e lê o primeiro código de pagamento (Pix ou boleto) em um texto livre. */
export function parsePaymentCode(input: string, today: ISODate): PaymentCodeResult {
  const pix = PIX_RE.exec(input);
  if (pix) return parsePix(pix[0].replace(/[\r\n]/g, ''));
  let firstError: PaymentCodeResult | null = null;
  for (const m of input.matchAll(DIGITS_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (![44, 47, 48].includes(digits.length)) continue;
    const r = parseDigits(digits, today);
    if (r.ok) return r;
    firstError ??= r;
  }
  return firstError ?? { ok: false, error: 'Não encontrei linha digitável de boleto nem Pix copia e cola.' };
}

/** Indica se o texto parece conter um código de pagamento (para roteamento barato). */
export function hasPaymentCode(input: string): boolean {
  if (PIX_RE.test(input)) return true;
  return [...input.matchAll(DIGITS_RE)].some((m) => [44, 47, 48].includes(m[0].replace(/\D/g, '').length));
}
