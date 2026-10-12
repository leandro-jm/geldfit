import { describe, expect, it } from 'vitest';
import { planInstallments, statementFor } from '../src/billing.js';
import { splitInstallments } from '../src/money.js';

describe('statementFor', () => {
  it('compra antes do fechamento cai na fatura do mês', () => {
    expect(statementFor(5, 12, '2026-10-03')).toEqual({
      refMonth: '2026-10-01',
      closingDate: '2026-10-05',
      dueDate: '2026-10-12',
    });
  });
  it('compra no dia do fechamento ou depois vai para a fatura seguinte', () => {
    expect(statementFor(5, 12, '2026-10-05').closingDate).toBe('2026-11-05');
    expect(statementFor(5, 12, '2026-10-11').closingDate).toBe('2026-11-05');
  });
  it('vencimento no mês seguinte quando due_day <= closing_day', () => {
    expect(statementFor(28, 5, '2026-10-10')).toEqual({
      refMonth: '2026-10-01',
      closingDate: '2026-10-28',
      dueDate: '2026-11-05',
    });
  });
  it('limita o fechamento ao último dia do mês', () => {
    expect(statementFor(31, 10, '2027-02-10').closingDate).toBe('2027-02-28');
  });
  it('virada de ano', () => {
    expect(statementFor(5, 12, '2026-12-20')).toEqual({
      refMonth: '2027-01-01',
      closingDate: '2027-01-05',
      dueDate: '2027-01-12',
    });
  });
});

describe('planInstallments (critério de aceite do PRD)', () => {
  it('TV de 3.600 em 10x lançada em 11/10 com fechamento dia 5: nov/2026 a ago/2027', () => {
    const plan = planInstallments('2026-10-11', 360_000, 10, 5, 12);
    expect(plan).toHaveLength(10);
    expect(plan.every((p) => p.amountCents === 36_000)).toBe(true);
    expect(plan[0]!.statement.closingDate).toBe('2026-11-05');
    expect(plan[0]!.statement.refMonth).toBe('2026-11-01');
    expect(plan[9]!.statement.refMonth).toBe('2027-08-01');
    const months = new Set(plan.map((p) => p.statement.refMonth));
    expect(months.size).toBe(10);
  });
  it('arredondamento vai na primeira parcela', () => {
    expect(splitInstallments(10_000, 3)).toEqual([3_334, 3_333, 3_333]);
  });
});
