import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '../../packages/db/src/index.js';
import {
  clearTestPtax,
  hasDb,
  insertAccount,
  insertPtax,
  insertTx,
  project,
  setupEnv,
  type TestEnv,
} from './helpers.js';

const TODAY = '2026-10-11';

describe.skipIf(!hasDb)('Contas em dólar', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = setupEnv();
    await insertPtax(env.owner.db, '2026-10-01', 5);
    await insertPtax(env.owner.db, '2026-10-09', 5.5);
  });
  afterAll(async () => {
    if (env) await clearTestPtax(env.owner.db);
    await env?.cleanup();
  });

  it('converte lançamentos, saldo e projeção pela PTAX', async () => {
    const u = await env.createUser();
    const ws = await env.createWorkspace(u);
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ variableMonthlyCents: 0, balanceFloorCents: 0 })
      .where('workspaceId', '=', ws)
      .execute();

    const brl = await env.as(u, (tx) =>
      insertAccount(tx, ws, { name: 'BB', openingBalanceCents: 1_000_000, openingDate: '2026-10-01' }),
    );
    const usd = await env.as(u, (tx) =>
      insertAccount(tx, ws, {
        name: 'Nomad',
        currency: 'USD',
        openingBalanceCents: 100_000, // US$ 1.000
        openingDate: '2026-10-01',
      }),
    );

    const brlCents = (id: string) =>
      env.owner.db
        .selectFrom('transactions')
        .select('amountBrlCents')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.amountBrlCents));

    // Compra em dólar: PTAX de 01/10 (última até 05/10)
    const purchase = await env.as(u, (tx) =>
      insertTx(tx, ws, { accountId: usd, date: '2026-10-05', amountCents: 10_000, direction: 'out' }),
    );
    expect(await brlCents(purchase.id)).toBe(50_000);

    // Lançamento em reais não muda
    const bread = await env.as(u, (tx) =>
      insertTx(tx, ws, { accountId: brl, date: '2026-10-05', amountCents: 2_345, direction: 'out' }),
    );
    expect(await brlCents(bread.id)).toBe(2_345);

    // Transferência BRL → USD com câmbio real: sai R$ 5.600, chegam US$ 1.000
    const transferId = randomUUID();
    await env.as(u, async (tx) => {
      await insertTx(tx, ws, {
        accountId: brl,
        date: '2026-10-10',
        amountCents: 560_000,
        direction: 'out',
        kind: 'transfer',
        transferId,
      });
      await insertTx(tx, ws, {
        accountId: usd,
        date: '2026-10-10',
        amountCents: 100_000,
        direction: 'in',
        kind: 'transfer',
        transferId,
      });
    });

    // Compra futura em dólar: usa a PTAX mais recente
    const future = await env.as(u, (tx) =>
      insertTx(tx, ws, {
        accountId: usd,
        date: '2026-11-15',
        amountCents: 5_000,
        direction: 'out',
        status: 'scheduled',
      }),
    );
    expect(await brlCents(future.id)).toBe(27_500);

    const balances = await env.as(u, async (tx) => {
      const r = await sql<{ native: number; brl: number; brlOld: number; bb: number }>`
        select account_balance(${usd}::uuid, ${TODAY}::date) as native,
               account_balance_brl(${usd}::uuid, ${TODAY}::date) as brl,
               account_balance_brl(${usd}::uuid, '2026-10-05'::date) as "brlOld",
               account_balance_brl(${brl}::uuid, ${TODAY}::date) as bb`.execute(tx);
      return r.rows[0]!;
    });
    expect(Number(balances.native)).toBe(190_000); // US$ 1.900
    expect(Number(balances.brl)).toBe(1_045_000); // × 5,5
    expect(Number(balances.brlOld)).toBe(450_000); // US$ 900 × 5,0
    expect(Number(balances.bb)).toBe(1_000_000 - 2_345 - 560_000);

    // Projeção consolidada em reais; a transferência entre contas do escopo não altera o total
    const rows = await env.as(u, (tx) => project(tx, ws, TODAY));
    expect(rows[0]!.openingCents).toBe(1_000_000 - 2_345 - 560_000 + 1_045_000);
    expect(rows.find((r) => r.month === '2026-11-01')!.expenseCents).toBe(27_500);

    // Nova PTAX: o worker reconverte lançamentos recentes
    await insertPtax(env.owner.db, '2026-10-10', 6);
    const n = await env.as(u, async (tx) => {
      const r = await sql<{ n: number }>`select refresh_usd_amounts('2026-10-01'::date) as n`.execute(tx);
      return Number(r.rows[0]!.n);
    });
    expect(n).toBe(2); // perna da transferência em 10/10 e a compra futura
    expect(await brlCents(purchase.id)).toBe(50_000);
    expect(await brlCents(future.id)).toBe(30_000);

    // Alterar o valor reconverte
    await env.as(u, (tx) =>
      tx.updateTable('transactions').set({ amountCents: 20_000 }).where('id', '=', purchase.id).execute(),
    );
    expect(await brlCents(purchase.id)).toBe(100_000);
  });
});
