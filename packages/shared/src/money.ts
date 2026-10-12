/** Valores monetários são sempre inteiros em centavos (bigint no banco, number seguro no JS). */
export type Cents = number;

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const BRL_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});

// Intl usa espaço não separável; trocamos por espaço comum (WhatsApp, testes, cópia).
const nbsp = /\u00a0|\u202f/g;

export function formatBRL(cents: Cents | bigint | string): string {
  return BRL.format(Number(cents) / 100)
    .replace(nbsp, ' ')
    .replace('-R$', '−R$');
}

export function formatBRLCompact(cents: Cents | bigint | string): string {
  return BRL_COMPACT.format(Number(cents) / 100)
    .replace(nbsp, ' ')
    .replace('-R$', '−R$');
}

export function toCents(value: number): Cents {
  return Math.round(value * 100);
}

/** Divide um total em N parcelas inteiras; a diferença de arredondamento vai na primeira. */
export function splitInstallments(totalCents: Cents, n: number): Cents[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('número de parcelas inválido');
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rest : base));
}

export function sumCents(values: Array<Cents | bigint | string | null | undefined>): Cents {
  return values.reduce<number>((acc, v) => acc + Number(v ?? 0), 0);
}
