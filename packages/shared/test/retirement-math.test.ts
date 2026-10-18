import { describe, expect, it } from 'vitest';
import {
  accumulationFactor,
  annuityFactor,
  historicalReturn,
  monthlyRate,
  pmt,
  retirementMonths,
  retirementPlan,
  type RetirementParams,
} from '../src/retirement-math.js';

const ONE_PCT_MONTH = 1.01 ** 12 - 1; // 12,68% a.a.

const base: RetirementParams = {
  startMonth: '2026-01-01',
  retireMonth: '2027-01-01',
  endMonth: '2029-01-01',
  birthDate: '1966-01-15',
  pensionBalanceCents: 0,
  otherAssetsCents: 0,
  monthlyContributionCents: 0,
  contributionGrowth: 0,
  accumulationRate: 0,
  withdrawalRate: 0,
  neededMonthlyCents: 0,
  inssMonthlyCents: 0,
};

describe('fatores', () => {
  it('taxa anual → mensal', () => {
    expect(monthlyRate(ONE_PCT_MONTH)).toBeCloseTo(0.01, 12);
    expect(monthlyRate(0)).toBe(0);
  });
  it('Tabela Price: R$ 10.000 a 1% a.m. em 12x = R$ 888,49', () => {
    expect(pmt(1_000_000, 0.01, 12)).toBe(88_849);
  });
  it('taxa zero usa o limite (sem divisão por zero)', () => {
    expect(annuityFactor(0, 24)).toBe(24);
    expect(accumulationFactor(0, 12)).toBe(12);
    expect(annuityFactor(0.01, 0)).toBe(0);
  });
});

describe('retirementMonths', () => {
  it('pela idade vale o mês do aniversário; pelo ano, janeiro', () => {
    expect(retirementMonths({ birthDate: '1985-03-15', retireAge: 60, endAge: 90 })).toEqual({
      retireMonth: '2045-03-01',
      endMonth: '2075-03-01',
    });
    expect(
      retirementMonths({ birthDate: '1985-03-15', retireAge: 60, retireYear: 2040, endAge: 90 }).retireMonth,
    ).toBe('2040-01-01');
  });
  it('idade final antes da aposentadoria é erro', () => {
    expect(() => retirementMonths({ birthDate: '1985-03-15', retireAge: 60, endAge: 55 })).toThrow(
      RangeError,
    );
    expect(() => retirementMonths({ birthDate: '1985-03-15', retireYear: 2080, endAge: 90 })).toThrow(
      RangeError,
    );
  });
});

describe('retirementPlan', () => {
  it('acumulação: R$ 100/mês a 1% a.m. por 12 meses = R$ 1.268,25', () => {
    const p = retirementPlan({ ...base, monthlyContributionCents: 10_000, accumulationRate: ONE_PCT_MONTH });
    expect(p.accumulationMonths).toBe(12);
    expect(p.capitalAtRetirementCents).toBe(126_825);
    expect(p.totalContributedCents).toBe(120_000);
  });

  it('taxas zero: capital, renda, quanto falta e aporte extra fechados à mão', () => {
    const p = retirementPlan({
      ...base,
      pensionBalanceCents: 1_200_000,
      monthlyContributionCents: 100_000,
      neededMonthlyCents: 150_000,
      inssMonthlyCents: 20_000,
    });
    expect(p).toMatchObject({
      alreadyRetired: false,
      retireMonth: '2027-01-01',
      retireAge: 61,
      accumulationMonths: 12,
      payoutMonths: 24,
      capitalAtRetirementCents: 2_400_000, // 12.000 + 12 × 1.000
      projectedMonthlyCents: 100_000, // 24.000 / 24
      projectedIncomeCents: 120_000, // + INSS
      gapCents: 30_000,
      surplusCents: 0,
      requiredCapitalCents: 3_120_000, // (1.500 − 200) × 24
      capitalGapCents: 720_000,
      extraMonthlyCents: 60_000, // 7.200 / 12
      lastsUntilAge: 62.5, // 24.000 / 1.300 = 18,5 meses depois dos 61
    });
    expect(p.yearly).toEqual([
      {
        year: 2026,
        age: 60,
        phase: 'accumulation',
        balanceCents: 2_400_000,
        contributedCents: 1_200_000,
        withdrawnCents: 0,
      },
      {
        year: 2027,
        age: 61,
        phase: 'withdrawal',
        balanceCents: 1_200_000,
        contributedCents: 1_200_000,
        withdrawnCents: 1_200_000,
      },
      {
        year: 2028,
        age: 62,
        phase: 'withdrawal',
        balanceCents: 0,
        contributedCents: 1_200_000,
        withdrawnCents: 2_400_000,
      },
    ]);
  });

  it('retirada a 1% a.m. segue a Tabela Price e zera no fim', () => {
    const p = retirementPlan({
      ...base,
      startMonth: '2027-01-01',
      endMonth: '2028-01-01',
      pensionBalanceCents: 1_000_000,
      withdrawalRate: ONE_PCT_MONTH,
    });
    expect(p.projectedMonthlyCents).toBe(88_849);
    expect(p.yearly.at(-1)!.balanceCents).toBe(0);
    expect(p.yearly.at(-1)!.withdrawnCents).toBe(1_066_185); // 12 × 888,4879 (parcela sem arredondar)
  });

  it('aporte extra rendendo 1% a.m.: R$ 10.000 em 12 meses pede R$ 789/mês (arredondado para cima)', () => {
    const p = retirementPlan({
      ...base,
      endMonth: '2027-11-01', // 10 meses de benefício
      accumulationRate: ONE_PCT_MONTH,
      neededMonthlyCents: 100_000,
    });
    expect(p.capitalGapCents).toBe(1_000_000);
    expect(p.extraMonthlyCents).toBe(78_900); // 10.000 / 12,6825 = 788,49
  });

  it('contribuição cresce a cada 12 meses', () => {
    const p = retirementPlan({
      ...base,
      retireMonth: '2028-01-01',
      endMonth: '2030-01-01',
      monthlyContributionCents: 100,
      contributionGrowth: 0.1,
    });
    expect(p.totalContributedCents).toBe(2_520); // 12 × 100 + 12 × 110
  });

  it('data no passado: benefício começa agora, sem aporte extra possível', () => {
    const p = retirementPlan({
      ...base,
      startMonth: '2026-11-01',
      retireMonth: '2020-01-01',
      endMonth: '2036-11-01',
      pensionBalanceCents: 1_200_000,
      neededMonthlyCents: 100_000,
    });
    expect(p.alreadyRetired).toBe(true);
    expect(p.retireMonth).toBe('2026-11-01');
    expect(p.accumulationMonths).toBe(0);
    expect(p.projectedMonthlyCents).toBe(10_000); // 12.000 / 120
    expect(p.extraMonthlyCents).toBeNull();
    expect(p.lastsUntilAge).toBe(61.8); // 60a10m + 12 meses
  });

  it('com sobra: nada falta e o capital chega à idade final', () => {
    const p = retirementPlan({ ...base, pensionBalanceCents: 4_800_000, neededMonthlyCents: 150_000 });
    expect(p.projectedMonthlyCents).toBe(200_000);
    expect(p.gapCents).toBe(0);
    expect(p.surplusCents).toBe(50_000);
    expect(p.extraMonthlyCents).toBe(0);
    expect(p.lastsUntilAge).toBeNull();
  });

  it('outros ativos rendem sem aporte e somam no capital', () => {
    const p = retirementPlan({
      ...base,
      pensionBalanceCents: 100_000,
      otherAssetsCents: 50_000,
      monthlyContributionCents: 10_000,
    });
    expect(p.pensionCapitalCents).toBe(220_000);
    expect(p.otherCapitalCents).toBe(50_000);
    expect(p.capitalAtRetirementCents).toBe(270_000);
  });
});

describe('historicalReturn', () => {
  const series = (n: number, skip?: number) => {
    const out = [];
    let b = 1_000_000;
    for (let i = 0; i < n; i++) {
      if (i > 0) b = b * 1.01 + 10_000;
      if (i !== skip)
        out.push({
          refMonth: `2025-${String(i + 1).padStart(2, '0')}-01`,
          balanceCents: b,
          contributionCents: 10_000,
        });
    }
    return out;
  };
  const ipca = new Map(
    Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}-01`, 0.5]),
  );

  it('1% a.m. com IPCA de 0,5% a.m. = 12,68% nominal e 6,14% real ao ano', () => {
    const r = historicalReturn(series(12), ipca)!;
    expect(r.months).toBe(11);
    expect(r.nominalAnnual).toBeCloseTo(ONE_PCT_MONTH, 10);
    expect(r.realAnnual).toBeCloseTo((1.01 / 1.005) ** 12 - 1, 10); // 6,136%
  });
  it('buraco entre meses interrompe o par; menos de 3 pares não estima', () => {
    expect(historicalReturn(series(12, 5), ipca)!.months).toBe(9);
    expect(historicalReturn(series(3), ipca)).toBeNull();
  });
  it('sem IPCA, só o nominal', () => {
    const r = historicalReturn(series(6), new Map())!;
    expect(r.realAnnual).toBeNull();
    expect(r.nominalAnnual).toBeCloseTo(ONE_PCT_MONTH, 10);
  });
});
