import { startOfMonth, type ISODate } from './dates.js';
import type { Cents } from './money.js';

export interface GoalPlanInput {
  targetCents: Cents;
  savedCents: Cents;
  monthlyContributionCents: Cents;
  /** Primeiro mês de aporte (AAAA-MM-01). */
  startMonth: ISODate;
  targetDate: ISODate | null;
}

export interface GoalPlan {
  remainingCents: Cents;
  /** Aportes que ainda cabem até o mês do prazo (inclui o mês atual, como a projeção). */
  contributionsLeft: number | null;
  /** Aporte mensal para chegar no prazo, arredondado para cima em reais. */
  recommendedMonthlyCents: Cents | null;
  /** Mês do último aporte no ritmo atual. */
  finishMonth: ISODate | null;
  status: 'done' | 'on_track' | 'behind' | 'overdue' | 'no_date';
}

const idx = (iso: ISODate) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const fromIdx = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;

/** Quanto falta, quanto aportar por mês para cumprir o prazo e quando conclui no ritmo atual. */
export function goalPlan(g: GoalPlanInput, today: ISODate): GoalPlan {
  const remainingCents = Math.max(0, g.targetCents - g.savedCents);
  const first = Math.max(idx(startOfMonth(today)), idx(g.startMonth));
  const finishMonth =
    remainingCents > 0 && g.monthlyContributionCents > 0
      ? fromIdx(first + Math.ceil(remainingCents / g.monthlyContributionCents) - 1)
      : null;
  if (remainingCents === 0)
    return {
      remainingCents,
      contributionsLeft: 0,
      recommendedMonthlyCents: null,
      finishMonth,
      status: 'done',
    };
  if (!g.targetDate)
    return {
      remainingCents,
      contributionsLeft: null,
      recommendedMonthlyCents: null,
      finishMonth,
      status: 'no_date',
    };
  const contributionsLeft = idx(g.targetDate) - first + 1;
  if (contributionsLeft < 1)
    return {
      remainingCents,
      contributionsLeft: 0,
      recommendedMonthlyCents: null,
      finishMonth,
      status: 'overdue',
    };
  const recommendedMonthlyCents = Math.ceil(remainingCents / contributionsLeft / 100) * 100;
  return {
    remainingCents,
    contributionsLeft,
    recommendedMonthlyCents,
    finishMonth,
    status: g.monthlyContributionCents * contributionsLeft >= remainingCents ? 'on_track' : 'behind',
  };
}
