import { addMonths, monthDay, parseISO, type ISODate } from './dates.js';
import { splitInstallments, type Cents } from './money.js';

export interface StatementDates {
  refMonth: ISODate; // primeiro dia do mês do fechamento
  closingDate: ISODate;
  dueDate: ISODate;
}

/**
 * Espelha a função SQL statement_dates(): compras no dia do fechamento ou depois vão para a
 * fatura seguinte; o vencimento cai no mês do fechamento se due_day > closing_day, senão no seguinte.
 */
export function statementFor(closingDay: number, dueDay: number, date: ISODate): StatementDates {
  const { y, m } = parseISO(date);
  const closeThis = monthDay(y, m, closingDay);
  let closingDate: ISODate;
  if (date < closeThis) {
    closingDate = closeThis;
  } else {
    const next = addMonths(monthDay(y, m, 1), 1);
    const p = parseISO(next);
    closingDate = monthDay(p.y, p.m, closingDay);
  }
  const c = parseISO(closingDate);
  const refMonth = monthDay(c.y, c.m, 1);
  let dueDate: ISODate;
  if (dueDay > closingDay) {
    dueDate = monthDay(c.y, c.m, dueDay);
  } else {
    const n = parseISO(addMonths(refMonth, 1));
    dueDate = monthDay(n.y, n.m, dueDay);
  }
  return { refMonth, closingDate, dueDate };
}

export interface InstallmentPlan {
  n: number;
  total: number;
  date: ISODate;
  amountCents: Cents;
  statement: StatementDates;
}

/** Gera as parcelas de uma compra: parcela i na data da compra + (i−1) meses. */
export function planInstallments(
  purchaseDate: ISODate,
  totalCents: Cents,
  installments: number,
  closingDay: number,
  dueDay: number,
): InstallmentPlan[] {
  const amounts = splitInstallments(totalCents, installments);
  return amounts.map((amountCents, i) => {
    const date = addMonths(purchaseDate, i);
    return {
      n: i + 1,
      total: installments,
      date,
      amountCents,
      statement: statementFor(closingDay, dueDay, date),
    };
  });
}
