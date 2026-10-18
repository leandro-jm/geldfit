import { addMonths, startOfMonth, type ISODate } from './dates.js';
import type { Cents } from './money.js';

// Aposentadoria em termos reais (reais de hoje): as taxas já descontam a inflação, então não há
// correção explícita. Aporte e saque acontecem no fim de cada mês.

const idx = (iso: ISODate) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const fromIdx = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
const EPS = 1e-12;

/** Taxa anual → mensal equivalente. */
export function monthlyRate(annual: number): number {
  return (1 + annual) ** (1 / 12) - 1;
}

/** Valor presente de 1 por mês durante `months` meses (fator da Tabela Price). */
export function annuityFactor(rMonthly: number, months: number): number {
  if (months <= 0) return 0;
  return Math.abs(rMonthly) < EPS ? months : (1 - (1 + rMonthly) ** -months) / rMonthly;
}

/** Valor futuro de 1 aportado no fim de cada mês durante `months` meses. */
export function accumulationFactor(rMonthly: number, months: number): number {
  if (months <= 0) return 0;
  return Math.abs(rMonthly) < EPS ? months : ((1 + rMonthly) ** months - 1) / rMonthly;
}

/** Parcela constante que zera `pvCents` em `months` meses rendendo `rMonthly`. */
export function pmt(pvCents: Cents, rMonthly: number, months: number): Cents {
  const f = annuityFactor(rMonthly, months);
  return f > 0 ? Math.round(pvCents / f) : 0;
}

/** Idade (anos, com fração de mês) no mês `month`. */
export function ageAt(birthDate: ISODate, month: ISODate): number {
  return (idx(startOfMonth(month)) - idx(startOfMonth(birthDate))) / 12;
}

/**
 * Mês do primeiro benefício e mês em que o saldo zera. "Em 2040" vale janeiro de 2040; pela idade,
 * o mês do aniversário. Com ano e idade, vale o ano.
 */
export function retirementMonths(p: {
  birthDate: ISODate;
  endAge: number;
  retireAge?: number | null;
  retireYear?: number | null;
}): { retireMonth: ISODate; endMonth: ISODate } {
  let retireMonth: ISODate;
  if (p.retireYear != null) retireMonth = `${p.retireYear}-01-01`;
  else if (p.retireAge != null) retireMonth = startOfMonth(addMonths(p.birthDate, 12 * p.retireAge));
  else throw new RangeError('Informe a idade ou o ano de aposentadoria.');
  const endMonth = startOfMonth(addMonths(p.birthDate, 12 * p.endAge));
  if (idx(endMonth) <= idx(retireMonth))
    throw new RangeError('A idade final precisa ser maior que a de aposentadoria.');
  return { retireMonth, endMonth };
}

export interface RetirementParams {
  /** Primeiro mês simulado (o seguinte ao último extrato). */
  startMonth: ISODate;
  /** Primeiro mês de benefício. */
  retireMonth: ISODate;
  /** Mês em que o saldo zera (idade final). */
  endMonth: ISODate;
  birthDate: ISODate;
  pensionBalanceCents: Cents;
  /** Carteira e contas de investimento; rendem sem aporte. 0 quando não entram. */
  otherAssetsCents: Cents;
  /** Participante + patrocinadora. */
  monthlyContributionCents: Cents;
  /** Crescimento real das contribuições ao ano, aplicado a cada 12 meses. */
  contributionGrowth: number;
  /** Rendimento real ao ano até a aposentadoria. */
  accumulationRate: number;
  /** Rendimento real ao ano durante a retirada. */
  withdrawalRate: number;
  /** Renda mensal necessária (gasto atual ou renda alvo). */
  neededMonthlyCents: Cents;
  inssMonthlyCents: Cents;
}

export interface RetirementYearPoint {
  year: number;
  /** Idade completada no ano. */
  age: number;
  phase: 'accumulation' | 'withdrawal';
  /** Saldo no fim do ano (ou no último mês simulado). */
  balanceCents: Cents;
  /** Aportes e saques acumulados até o fim do ano. */
  contributedCents: Cents;
  withdrawnCents: Cents;
}

export interface RetirementPlan {
  /** A data pedida já passou: o benefício começa no primeiro mês simulado. */
  alreadyRetired: boolean;
  retireMonth: ISODate;
  retireAge: number;
  accumulationMonths: number;
  payoutMonths: number;
  pensionCapitalCents: Cents;
  otherCapitalCents: Cents;
  capitalAtRetirementCents: Cents;
  totalContributedCents: Cents;
  /** Renda do capital (sem INSS). */
  projectedMonthlyCents: Cents;
  /** Renda do capital + INSS. */
  projectedIncomeCents: Cents;
  neededMonthlyCents: Cents;
  gapCents: Cents;
  surplusCents: Cents;
  /** Capital que pagaria a necessidade (menos o INSS) até a idade final. */
  requiredCapitalCents: Cents;
  capitalGapCents: Cents;
  /** Aporte extra mensal até a aposentadoria para fechar a diferença; null sem meses de acumulação. */
  extraMonthlyCents: Cents | null;
  /** Até que idade o capital dura sacando a necessidade; null se chega à idade final. */
  lastsUntilAge: number | null;
  yearly: RetirementYearPoint[];
}

/** Acumulação mês a mês, renda constante até a idade final e quanto falta frente à necessidade. */
export function retirementPlan(p: RetirementParams): RetirementPlan {
  const start = idx(p.startMonth);
  const alreadyRetired = idx(p.retireMonth) < start;
  const ret = Math.max(idx(p.retireMonth), start);
  const end = idx(p.endMonth);
  const payoutMonths = end - ret;
  if (payoutMonths <= 0) throw new RangeError('A idade final precisa ser maior que a de aposentadoria.');
  const accumulationMonths = ret - start;
  const r = monthlyRate(p.accumulationRate);
  const w = monthlyRate(p.withdrawalRate);
  const birthYear = Number(p.birthDate.slice(0, 4));

  const years = new Map<number, RetirementYearPoint>();
  const mark = (
    i: number,
    phase: RetirementYearPoint['phase'],
    balance: number,
    contributed: number,
    withdrawn: number,
  ) => {
    const year = Math.floor(i / 12);
    years.set(year, {
      year,
      age: year - birthYear,
      phase,
      balanceCents: Math.max(0, Math.round(balance)),
      contributedCents: Math.round(contributed),
      withdrawnCents: Math.round(withdrawn),
    });
  };

  let pension = p.pensionBalanceCents;
  let other = p.otherAssetsCents;
  let contributed = 0;
  for (let k = 0; k < accumulationMonths; k++) {
    const c = p.monthlyContributionCents * (1 + p.contributionGrowth) ** Math.floor(k / 12);
    pension = pension * (1 + r) + c;
    other *= 1 + r;
    contributed += c;
    mark(start + k, 'accumulation', pension + other, contributed, 0);
  }

  const capital = pension + other;
  const payout = capital / annuityFactor(w, payoutMonths);
  let balance = capital;
  let withdrawn = 0;
  for (let j = 0; j < payoutMonths; j++) {
    balance = j === payoutMonths - 1 ? 0 : balance * (1 + w) - payout;
    withdrawn += payout;
    mark(ret + j, 'withdrawal', balance, contributed, withdrawn);
  }

  const needNet = Math.max(0, p.neededMonthlyCents - p.inssMonthlyCents);
  const projectedMonthlyCents = Math.round(payout);
  const projectedIncomeCents = projectedMonthlyCents + p.inssMonthlyCents;
  const gapExact = Math.max(0, needNet - payout);
  const capitalGapCents = Math.round(gapExact * annuityFactor(w, payoutMonths));
  const extraMonthlyCents =
    capitalGapCents === 0
      ? 0
      : accumulationMonths > 0
        ? Math.ceil(capitalGapCents / accumulationFactor(r, accumulationMonths) / 100) * 100
        : null;

  const retireAge = ageAt(p.birthDate, fromIdx(ret));
  let lastsUntilAge: number | null = null;
  if (gapExact > 0) {
    let b = capital;
    let months = 0;
    while (months < payoutMonths) {
      const next = b * (1 + w) - needNet;
      if (next < 0) {
        months += (b * (1 + w)) / needNet;
        break;
      }
      b = next;
      months++;
    }
    lastsUntilAge = Math.round((retireAge + months / 12) * 10) / 10;
  }

  return {
    alreadyRetired,
    retireMonth: fromIdx(ret),
    retireAge: Math.round(retireAge * 10) / 10,
    accumulationMonths,
    payoutMonths,
    pensionCapitalCents: Math.round(pension),
    otherCapitalCents: Math.round(other),
    capitalAtRetirementCents: Math.round(capital),
    totalContributedCents: Math.round(contributed),
    projectedMonthlyCents,
    projectedIncomeCents,
    neededMonthlyCents: p.neededMonthlyCents,
    gapCents: Math.max(0, p.neededMonthlyCents - projectedIncomeCents),
    surplusCents: Math.max(0, projectedIncomeCents - p.neededMonthlyCents),
    requiredCapitalCents: Math.round(needNet * annuityFactor(w, payoutMonths)),
    capitalGapCents,
    extraMonthlyCents,
    lastsUntilAge,
    yearly: [...years.values()].sort((a, b) => a.year - b.year),
  };
}

export interface HistoricalReturn {
  nominalAnnual: number;
  /** Descontado o IPCA; null se faltar o índice de algum mês. */
  realAnnual: number | null;
  months: number;
}

/**
 * Rentabilidade do plano pelos extratos: em cada par de meses consecutivos, o saldo menos a
 * contribuição do mês sobre o saldo anterior. Precisa de pelo menos 3 pares. `ipcaMonthlyPct`
 * traz o IPCA do mês em % (0,5 = 0,5% a.m.), chaveado por AAAA-MM-01.
 */
export function historicalReturn(
  entries: Array<{ refMonth: ISODate; balanceCents: Cents; contributionCents: Cents }>,
  ipcaMonthlyPct: Map<ISODate, number>,
): HistoricalReturn | null {
  const es = [...entries].sort((a, b) => idx(a.refMonth) - idx(b.refMonth));
  let nominal = 1;
  let real = 1;
  let realOk = true;
  let months = 0;
  for (let i = 1; i < es.length; i++) {
    const prev = es[i - 1]!;
    const cur = es[i]!;
    if (idx(cur.refMonth) - idx(prev.refMonth) !== 1 || prev.balanceCents <= 0) continue;
    const rt = (cur.balanceCents - cur.contributionCents) / prev.balanceCents - 1;
    nominal *= 1 + rt;
    const ipca = ipcaMonthlyPct.get(startOfMonth(cur.refMonth));
    if (ipca == null) realOk = false;
    else real *= (1 + rt) / (1 + ipca / 100);
    months++;
  }
  if (months < 3) return null;
  return {
    nominalAnnual: nominal ** (12 / months) - 1,
    realAnnual: realOk ? real ** (12 / months) - 1 : null,
    months,
  };
}
