import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addMonths, isoFromParts, parseISO, planInstallments } from '../../packages/shared/src/index.js';
import { hasDb, insertAccount, insertTx, project, setupEnv, type TestEnv } from './helpers.js';

const TODAY = '2026-10-11';

/** "Planilha de referência": cálculo manual independente do SQL, mês a mês. */
function spreadsheet(opts: {
  s0: number;
  months: number;
  income: (m: string) => number;
  expense: (m: string) => number;
  bills: (m: string) => number;
  variable: (idx: number) => number;
  floor?: number;
}) {
  let s = opts.s0;
  const rows: Array<{ month: string; closing: number }> = [];
  for (let i = 0; i < opts.months; i++) {
    const m = addMonths('2026-10-01', i);
    s = s + opts.income(m) - opts.expense(m) - opts.bills(m) - opts.variable(i);
    rows.push({ month: m, closing: s });
  }
  return rows;
}

async function scheduleMonthly(
  env: TestEnv,
  user: string,
  ws: string,
  acc: string,
  day: number,
  cents: number,
  dir: 'in' | 'out',
  from: string,
  n: number,
) {
  const recId = await env.as(
    user,
    async (tx) =>
      (
        await tx
          .insertInto('recurrences')
          .values({
            workspaceId: ws,
            accountId: acc,
            description: dir === 'in' ? 'Salário' : 'Aluguel',
            amountCents: cents,
            direction: dir,
            rule: `FREQ=MONTHLY;BYMONTHDAY=${day}`,
            startDate: from,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );
  await env.as(user, async (tx) => {
    for (let i = 0; i < n; i++) {
      const { y, m } = parseISO(addMonths(from, i));
      await insertTx(tx, ws, {
        accountId: acc,
        date: isoFromParts(y, m, day),
        amountCents: cents,
        direction: dir,
        status: 'scheduled',
        recurrenceId: recId,
      });
    }
  });
}

describe.skipIf(!hasDb)('Motor de projeção', () => {
  let env: TestEnv;
  beforeAll(() => {
    env = setupEnv();
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  it('Cenário 1 — sem histórico: salário, aluguel, TV 10x no cartão, variável informado', async () => {
    const u = await env.createUser();
    const ws = await env.createWorkspace(u);
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ variableMonthlyCents: 200_000, balanceFloorCents: 0 })
      .where('workspaceId', '=', ws)
      .execute();

    const acc = await env.as(u, (tx) =>
      insertAccount(tx, ws, { openingBalanceCents: 1_000_000, openingDate: '2026-10-01' }),
    );
    await env.as(u, (tx) =>
      insertTx(tx, ws, {
        accountId: acc,
        date: '2026-10-03',
        amountCents: 100_000,
        direction: 'out',
        description: 'mercado',
      }),
    );
    // salário dia 5 a partir de nov; aluguel dia 10 a partir de out (o de out ainda não pago → vencido)
    await scheduleMonthly(env, u, ws, acc, 5, 850_000, 'in', '2026-11-05', 24);
    await scheduleMonthly(env, u, ws, acc, 10, 250_000, 'out', '2026-10-10', 25);

    const card = await env.as(
      u,
      async (tx) =>
        (
          await tx
            .insertInto('cards')
            .values({
              workspaceId: ws,
              name: 'Santander',
              accountId: acc,
              closingDay: 5,
              dueDay: 12,
              limitCents: 1_000_000,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    );
    const group = randomUUID();
    const plan = planInstallments('2026-10-11', 360_000, 10, 5, 12);
    const statements = await env.as(u, async (tx) => {
      const out: string[] = [];
      for (const p of plan) {
        const r = await insertTx(tx, ws, {
          cardId: card,
          date: p.date,
          amountCents: p.amountCents,
          direction: 'out',
          status: p.date <= TODAY ? 'posted' : 'scheduled',
          installmentGroupId: group,
          installmentN: p.n,
          installmentTotal: p.total,
          description: 'TV',
        });
        out.push(r.cardStatementId!);
      }
      return out;
    });
    // critério de aceite: 10 faturas distintas, de nov/2026 (fecha 05/11) a ago/2027
    const st = await env.as(u, (tx) =>
      tx
        .selectFrom('cardStatements')
        .select(['refMonth', 'closingDate', 'dueDate'])
        .where('id', 'in', statements)
        .orderBy('refMonth')
        .execute(),
    );
    expect(st).toHaveLength(10);
    expect(st[0]).toEqual({ refMonth: '2026-11-01', closingDate: '2026-11-05', dueDate: '2026-11-12' });
    expect(st[9]!.refMonth).toBe('2027-08-01');

    const rows = await env.as(u, (tx) => project(tx, ws, TODAY));
    expect(rows).toHaveLength(24);

    const expected = spreadsheet({
      s0: 900_000,
      months: 24,
      income: (m) => (m >= '2026-11-01' ? 850_000 : 0),
      expense: () => 250_000,
      bills: (m) => (m >= '2026-11-01' && m <= '2027-08-01' ? 36_000 : 0),
      variable: (i) => (i === 0 ? 100_000 : 200_000),
    });
    expect(rows.map((r) => ({ month: r.month, closing: r.closingCents }))).toEqual(expected);
    expect(rows[0]).toMatchObject({
      openingCents: 900_000,
      expenseCents: 250_000,
      variableCents: 100_000,
      closingCents: 550_000,
    });
    // otimista: V×0,85; pessimista: V×1,15 + maior gasto variável único (1.000)
    expect(rows[0]!.closingOptimisticCents).toBe(900_000 - 250_000 - 85_000);
    expect(rows[0]!.closingPessimisticCents).toBe(900_000 - 250_000 - 115_000 - 100_000);
    expect(rows[1]!.cardBillsCents).toBe(36_000);
    expect(rows[10]!.cardBillsCents).toBe(36_000); // ago/2027
    expect(rows[11]!.cardBillsCents).toBe(0); // set/2027

    // Pagar a fatura de novembro zera F em novembro
    await env.as(u, (tx) =>
      insertTx(tx, ws, {
        accountId: acc,
        date: '2026-11-12',
        amountCents: 36_000,
        direction: 'out',
        status: 'scheduled',
        kind: 'card_payment',
        paysStatementId: statements[0]!,
      }),
    );
    const after = await env.as(u, (tx) => project(tx, ws, TODAY));
    // pagamento agendado não entra como despesa (kind card_payment); a fatura continua em F até ser postada
    expect(after[1]!.cardBillsCents).toBe(36_000);
    expect(after[1]!.expenseCents).toBe(250_000);
  });

  it('Cenário 2 — com histórico: média móvel de 3 meses, ignora recorrência e parcela; piso', async () => {
    const u = await env.createUser();
    const ws = await env.createWorkspace(u);
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ variableMonthlyCents: 999_999, balanceFloorCents: 400_000 })
      .where('workspaceId', '=', ws)
      .execute();
    const acc = await env.as(u, (tx) =>
      insertAccount(tx, ws, { openingBalanceCents: 500_000, openingDate: '2026-07-01' }),
    );
    await env.as(u, async (tx) => {
      await insertTx(tx, ws, { accountId: acc, date: '2026-07-15', amountCents: 60_000, direction: 'out' });
      await insertTx(tx, ws, { accountId: acc, date: '2026-08-15', amountCents: 90_000, direction: 'out' });
      await insertTx(tx, ws, { accountId: acc, date: '2026-09-15', amountCents: 120_000, direction: 'out' });
      // parcela: não é variável
      await insertTx(tx, ws, {
        accountId: acc,
        date: '2026-09-20',
        amountCents: 50_000,
        direction: 'out',
        installmentGroupId: randomUUID(),
        installmentN: 1,
        installmentTotal: 2,
      });
      // receita de julho
      await insertTx(tx, ws, { accountId: acc, date: '2026-07-05', amountCents: 300_000, direction: 'in' });
    });
    const rows = await env.as(u, (tx) => project(tx, ws, TODAY));
    // S0 = 5000 - 600 - 900 - 1200 - 500 + 3000 = 4800 ; V = (600+900+1200)/3 = 900
    expect(rows[0]!.openingCents).toBe(480_000);
    expect(rows[0]!.variableCents).toBe(90_000);
    expect(rows[1]!.variableCents).toBe(90_000);
    const expected = spreadsheet({
      s0: 480_000,
      months: 24,
      income: () => 0,
      expense: () => 0,
      bills: () => 0,
      variable: () => 90_000,
    });
    expect(rows.map((r) => r.closingCents)).toEqual(expected.map((e) => e.closing));
    // piso de 4.000: out fecha em 3.900 → já abaixo
    expect(rows[0]!.belowFloor).toBe(true);
    // pessimista: V×1,15 + maior gasto único dos últimos 6 meses (1.200)
    expect(rows[0]!.closingPessimisticCents).toBe(480_000 - 103_500 - 120_000);
  });

  it('Cenário 3 — transferência interna neutra, conta privada fora da visão do outro membro, metas e proventos', async () => {
    const a = await env.createUser();
    const b = await env.createUser();
    const ws = await env.createWorkspace(a);
    await env.addMember(ws, b, 'member');
    const acc1 = await env.as(a, (tx) =>
      insertAccount(tx, ws, { name: 'BB', openingBalanceCents: 300_000, openingDate: '2026-10-01' }),
    );
    const acc2 = await env.as(a, (tx) =>
      insertAccount(tx, ws, { name: 'Cresol', openingBalanceCents: 200_000, openingDate: '2026-10-01' }),
    );
    const priv = await env.as(b, (tx) =>
      insertAccount(tx, ws, {
        name: 'Privada B',
        openingBalanceCents: 1_000_000,
        openingDate: '2026-10-01',
        isPrivate: true,
        ownerUserId: b,
      }),
    );
    const transferId = randomUUID();
    await env.as(a, async (tx) => {
      // transferência agendada entre contas visíveis: não muda o consolidado
      await insertTx(tx, ws, {
        accountId: acc1,
        date: '2026-11-01',
        amountCents: 50_000,
        direction: 'out',
        status: 'scheduled',
        kind: 'transfer',
        transferId,
      });
      await insertTx(tx, ws, {
        accountId: acc2,
        date: '2026-11-01',
        amountCents: 50_000,
        direction: 'in',
        status: 'scheduled',
        kind: 'transfer',
        transferId,
      });
      await tx
        .insertInto('goals')
        .values({
          workspaceId: ws,
          name: 'Viagem',
          targetCents: 100_000,
          savedCents: 0,
          monthlyContributionCents: 30_000,
          startMonth: '2026-11-01',
        })
        .execute();
      await tx
        .insertInto('plannedCashflows')
        .values({
          workspaceId: ws,
          date: '2026-12-15',
          amountCents: 12_345,
          direction: 'in',
          source: 'dividend',
        })
        .execute();
    });
    const rowsA = await env.as(a, (tx) => project(tx, ws, TODAY));
    expect(rowsA[0]!.openingCents).toBe(500_000); // privada de B não entra para A
    expect(rowsA[1]!.incomeCents).toBe(0);
    expect(rowsA[1]!.expenseCents).toBe(0);
    // metas: 300/mês de nov até atingir 1.000 (nov, dez, jan, fev → 4 aportes; o 4º completa)
    expect(rowsA.slice(1, 6).map((r) => r.goalsCents)).toEqual([30_000, 30_000, 30_000, 30_000, 0]);
    expect(rowsA[2]!.incomeCents).toBe(12_345);

    const rowsB = await env.as(b, (tx) => project(tx, ws, TODAY));
    expect(rowsB[0]!.openingCents).toBe(1_500_000); // B vê a própria conta privada

    // Projeção por conta: só a conta e sem variável
    const perAcc = await env.as(a, (tx) => project(tx, ws, TODAY, acc1));
    expect(perAcc[0]!.openingCents).toBe(300_000);
    expect(perAcc[1]!.expenseCents).toBe(50_000); // a transferência sai desta conta
    void priv;
  });

  it('Recálculo após excluir uma transação leva menos de 2 s com 2 anos de dados', async () => {
    const u = await env.createUser();
    const ws = await env.createWorkspace(u);
    const acc = await env.as(u, (tx) =>
      insertAccount(tx, ws, { openingBalanceCents: 1_000_000, openingDate: '2024-10-01' }),
    );
    await env.owner.db
      .insertInto('transactions')
      .values(
        Array.from({ length: 3000 }, (_, i) => ({
          workspaceId: ws,
          accountId: acc,
          date: addMonths('2024-10-02', Math.floor(i / 125)),
          amountCents: 1000 + i,
          direction: i % 10 === 0 ? ('in' as const) : ('out' as const),
          description: `tx ${i}`,
        })),
      )
      .execute();
    const victim = await env.owner.db
      .selectFrom('transactions')
      .select('id')
      .where('workspaceId', '=', ws)
      .executeTakeFirstOrThrow();
    const t0 = performance.now();
    await env.as(u, async (tx) => {
      await tx.deleteFrom('transactions').where('id', '=', victim.id).execute();
      await project(tx, ws, TODAY);
    });
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
