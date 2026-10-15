import type { Cents } from './money.js';

/** Fluxo de pagamento: valor e prazo em dias a partir de hoje. */
export interface PaymentFlow {
  days: number;
  amountCents: Cents;
}

/** Alíquota regressiva de IR sobre renda fixa pelo prazo da aplicação. */
export function fixedIncomeTax(days: number): number {
  if (days <= 180) return 0.225;
  if (days <= 360) return 0.2;
  if (days <= 720) return 0.175;
  return 0.15;
}

/** CDI diário (% a.d., série SGS 12) → taxa anual em 252 dias úteis. */
export function annualFromDailyPct(dailyPct: number): number {
  return (1 + dailyPct / 100) ** 252 - 1;
}

/** Rendimento líquido de IR de uma aplicação a 100% do CDI por `days` dias corridos. */
export function netCdiYield(cdiAnnual: number, days: number): number {
  if (days <= 0) return 0;
  const gross = (1 + cdiAnnual) ** (days / 365) - 1;
  return gross * (1 - fixedIncomeTax(days));
}

/**
 * Quanto precisaria estar aplicado hoje a 100% do CDI (líquido de IR) para pagar cada parcela no
 * vencimento. Se for menor que o preço à vista, parcelar sai mais barato que pagar à vista.
 */
export function presentValueAtCdi(flows: PaymentFlow[], cdiAnnual: number): Cents {
  return Math.round(flows.reduce((s, f) => s + f.amountCents / (1 + netCdiYield(cdiAnnual, f.days)), 0));
}

/**
 * Juros mensais embutidos no parcelamento em relação ao preço à vista (TIR por bisseção).
 * null quando o parcelado não custa mais que o à vista.
 */
export function impliedMonthlyRate(cashCents: Cents, flows: PaymentFlow[]): number | null {
  const total = flows.reduce((s, f) => s + f.amountCents, 0);
  if (total <= cashCents) return null;
  const pv = (r: number) => flows.reduce((s, f) => s + f.amountCents / (1 + r) ** (f.days / 30.4375), 0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > cashCents) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
