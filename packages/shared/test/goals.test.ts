import { describe, expect, it } from 'vitest';
import { goalPlan } from '../src/goals.js';

const orlando = {
  targetCents: 3_000_000,
  savedCents: 0,
  monthlyContributionCents: 100_000,
  startMonth: '2026-10-01',
  targetDate: '2027-08-31',
};

describe('goalPlan', () => {
  it('Orlando: 11 aportes até ago/2027 pedem R$ 2.728/mês; no ritmo atual conclui em mar/2029', () => {
    expect(goalPlan(orlando, '2026-10-13')).toEqual({
      remainingCents: 3_000_000,
      contributionsLeft: 11, // out/2026 a ago/2027
      recommendedMonthlyCents: 272_800, // 30.000 / 11 = 2.727,27, arredondado para cima em reais
      finishMonth: '2029-03-01', // 30 aportes a partir de out/2026
      status: 'behind',
    });
  });
  it('aporte suficiente fica em dia', () => {
    expect(goalPlan({ ...orlando, monthlyContributionCents: 272_800 }, '2026-10-13').status).toBe('on_track');
  });
  it('início no futuro conta a partir do início; o que já foi guardado reduz o aporte', () => {
    const p = goalPlan({ ...orlando, startMonth: '2027-01-01', savedCents: 600_000 }, '2026-10-13');
    expect(p.contributionsLeft).toBe(8); // jan a ago/2027
    expect(p.recommendedMonthlyCents).toBe(300_000);
  });
  it('sem prazo, prazo vencido e meta concluída', () => {
    expect(goalPlan({ ...orlando, targetDate: null }, '2026-10-13')).toMatchObject({
      status: 'no_date',
      recommendedMonthlyCents: null,
      finishMonth: '2029-03-01',
    });
    expect(goalPlan(orlando, '2027-09-02')).toMatchObject({
      status: 'overdue',
      recommendedMonthlyCents: null,
    });
    expect(goalPlan({ ...orlando, savedCents: 3_000_000 }, '2026-10-13').status).toBe('done');
  });
  it('no mês do prazo, o que falta vai num aporte só', () => {
    expect(goalPlan({ ...orlando, savedCents: 2_900_000 }, '2027-08-10')).toMatchObject({
      contributionsLeft: 1,
      recommendedMonthlyCents: 100_000,
      status: 'on_track',
    });
  });
});
