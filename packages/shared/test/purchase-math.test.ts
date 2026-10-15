import { describe, expect, it } from 'vitest';
import {
  annualFromDailyPct,
  fixedIncomeTax,
  impliedMonthlyRate,
  netCdiYield,
  presentValueAtCdi,
} from '../src/purchase-math.js';

const tenMonthly = (amount: number) =>
  Array.from({ length: 10 }, (_, k) => ({ days: Math.round((k + 1) * 30.4375), amountCents: amount }));

describe('matemática da compra', () => {
  it('IR regressivo por prazo', () => {
    expect([90, 180, 181, 360, 361, 720, 721].map(fixedIncomeTax)).toEqual([
      0.225, 0.225, 0.2, 0.2, 0.175, 0.175, 0.15,
    ]);
  });
  it('CDI diário → anual em 252 dias úteis', () => {
    expect(annualFromDailyPct(0.055131)).toBeCloseTo(0.149, 3);
  });
  it('rendimento líquido: zero no dia; alíquota pela faixa do prazo', () => {
    expect(netCdiYield(0.15, 0)).toBe(0);
    expect(netCdiYield(0.15, 180)).toBeCloseTo((1.15 ** (180 / 365) - 1) * 0.775, 9);
    expect(netCdiYield(0.15, 365)).toBeCloseTo(0.15 * 0.825, 9); // 361–720 dias: 17,5%
  });
  it('valor presente: sem CDI é a soma; com CDI é menor', () => {
    expect(presentValueAtCdi(tenMonthly(40_000), 0)).toBe(400_000);
    const pv = presentValueAtCdi(tenMonthly(40_000), 0.15);
    expect(pv).toBeLessThan(400_000);
    expect(pv).toBeGreaterThan(380_000);
  });
  it('juros embutidos: null sem juros; ~1%/mês num parcelado com juros', () => {
    expect(impliedMonthlyRate(400_000, tenMonthly(40_000))).toBeNull();
    // 10 × 422,73 sobre 4.000 à vista ≈ 1% ao mês (tabela Price)
    expect(impliedMonthlyRate(400_000, tenMonthly(42_273))).toBeCloseTo(0.01, 3);
  });
});
