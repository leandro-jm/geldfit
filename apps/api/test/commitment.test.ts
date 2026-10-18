import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Tx } from '@sf/db';
import { addMonths, startOfMonth } from '@sf/shared';
import { handleMessage } from '../src/agent/orchestrator.js';
import type { Actor, AppContext } from '../src/context.js';
import { commitmentAnswer, computeCommitment } from '../src/domain/commitment.js';
import { insertTransactions, workspaceToday } from '../src/domain/ledger.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import { insertAccount, insertTx, type TestEnv } from '../../../db/tests/helpers.js';

const TODAY = '2026-10-11';

/** Recorrência mensal materializada como lançamentos (como faz materializeRecurrence). */
async function monthly(
  tx: Tx,
  ws: string,
  acc: string,
  v: { description: string; cents: number; dir: 'in' | 'out'; first: string; n: number; withEnd: boolean },
) {
  const end = addMonths(v.first, v.n - 1);
  const rec = await tx
    .insertInto('recurrences')
    .values({
      workspaceId: ws,
      accountId: acc,
      description: v.description,
      amountCents: v.cents,
      direction: v.dir,
      rule: 'FREQ=MONTHLY',
      startDate: v.first,
      endDate: v.withEnd ? end : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (let k = 0; k < v.n; k++) {
    const date = addMonths(v.first, k);
    await insertTx(tx, ws, {
      accountId: acc,
      date,
      amountCents: v.cents,
      direction: v.dir,
      status: date <= TODAY ? 'posted' : 'scheduled',
      description: v.description,
      recurrenceId: rec.id,
    });
  }
}

async function newCard(tx: Tx, ws: string, acc: string) {
  const c = await tx
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
    .executeTakeFirstOrThrow();
  return c.id;
}

describe.skipIf(!hasDb)('Renda futura comprometida com parcelas', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;
  let member: string;

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    actor = await newActor(env);
    const ws = actor.workspaceId;
    await env.as(actor.userId, async (tx) => {
      const acc = await insertAccount(tx, ws, { openingBalanceCents: 1_000_000, openingDate: '2026-10-01' });
      await monthly(tx, ws, acc, {
        description: 'Salário',
        cents: 600_000,
        dir: 'in',
        first: '2026-10-05',
        n: 24,
        withEnd: false,
      });
      // aluguel não tem fim: é conta fixa, não parcela
      await monthly(tx, ws, acc, {
        description: 'Aluguel',
        cents: 200_000,
        dir: 'out',
        first: '2026-10-10',
        n: 24,
        withEnd: false,
      });
      // financiamento com data final: conta como parcela (out/2026 a mar/2027)
      await monthly(tx, ws, acc, {
        description: 'Financiamento do carro',
        cents: 100_000,
        dir: 'out',
        first: '2026-10-15',
        n: 6,
        withEnd: true,
      });
      // receita avulsa não entra no denominador
      await insertTx(tx, ws, {
        accountId: acc,
        date: '2026-11-20',
        amountCents: 300_000,
        direction: 'in',
        status: 'scheduled',
        description: 'Freela',
      });
      const card = await newCard(tx, ws, acc);
      // TV 10x no cartão (fecha dia 5): faturas de nov/2026 a ago/2027; carnê 4x de dez a mar
      await insertTransactions(tx, actor, [
        {
          cardId: card,
          date: TODAY,
          amountCents: 360_000,
          installments: 10,
          direction: 'out',
          description: 'TV',
          status: 'scheduled',
        },
        {
          accountId: acc,
          date: '2026-12-01',
          amountCents: 120_000,
          installments: 4,
          direction: 'out',
          description: 'Sofá',
          status: 'scheduled',
        },
      ]);
    });
    // membro com conta privada: as parcelas dele não aparecem para o dono
    member = await env.createUser('Membro');
    await env.addMember(ws, member, 'member');
    await env.as(member, async (tx) => {
      const priv = await insertAccount(tx, ws, {
        name: 'Privada',
        openingBalanceCents: 0,
        openingDate: '2026-10-01',
        isPrivate: true,
        ownerUserId: member,
      });
      const group = randomUUID();
      for (let n = 1; n <= 3; n++)
        await insertTx(tx, ws, {
          accountId: priv,
          date: addMonths('2026-11-01', n - 1),
          amountCents: 50_000,
          direction: 'out',
          status: 'scheduled',
          description: `Celular (${n}/3)`,
          installmentGroupId: group,
          installmentN: n,
          installmentTotal: 3,
        });
    });
  });
  afterAll(() => env?.cleanup());

  const commitment = (user = actor.userId) =>
    env.as(user, (tx) => computeCommitment(tx, actor.workspaceId, { months: 12, today: TODAY }));

  it('mês a mês: parcelas do cartão pelo vencimento, carnê e financiamento sobre a renda recorrente', async () => {
    const c = await commitment();
    expect(c.months).toHaveLength(12);
    const row = (m: string) => c.months.find((x) => x.month === m)!;
    expect(row('2026-10-01')).toMatchObject({ incomeCents: 600_000, committedCents: 100_000, level: 'ok' });
    expect(row('2026-11-01')).toMatchObject({
      incomeCents: 600_000,
      committedCents: 136_000,
      level: 'atencao',
    });
    expect(row('2026-12-01').committedCents).toBe(166_000);
    expect(row('2027-03-01').committedCents).toBe(166_000);
    expect(row('2027-04-01').committedCents).toBe(36_000);
    expect(row('2027-08-01').committedCents).toBe(36_000);
    expect(row('2027-09-01').committedCents).toBe(0);
    expect(row('2026-12-01').pct).toBeCloseTo(166_000 / 600_000);

    const march = row('2027-03-01').items;
    expect(march.map((i) => [i.label, i.kind, i.endsThisMonth])).toEqual([
      ['Financiamento do carro', 'financing', true],
      ['TV', 'card', false],
      ['Sofá', 'carne', true],
    ]);
    expect(march.find((i) => i.label === 'TV')).toMatchObject({ n: 5, total: 10 });

    expect(c.peak).toEqual({ month: '2026-12-01', pct: 166_000 / 600_000 });
    expect(c.releases).toEqual([
      { month: '2027-03-01', label: 'Financiamento do carro', cents: 100_000 },
      { month: '2027-03-01', label: 'Sofá', cents: 30_000 },
      { month: '2027-08-01', label: 'TV', cents: 36_000 },
    ]);
    expect(commitmentAnswer(c)).toBe(
      '17% da renda de outubro de 2026 já está comprometida com parcelas (R$ 1.000,00 de R$ 6.000,00). ' +
        'O pico é 28% em dez/2026. ' +
        'Em mar/2027 termina Financiamento do carro (R$ 1.000,00); a partir de abr/2027 o comprometimento fica em 6%.',
    );
  });

  it('conta privada de outro membro só entra na visão dele', async () => {
    const owner = await commitment();
    const mine = await commitment(member);
    expect(mine.months[1]!.committedCents - owner.months[1]!.committedCents).toBe(50_000);
  });

  it('sem renda recorrente: percentual nulo e resposta pede o salário', async () => {
    const solo = await newActor(env);
    const c = await env.as(solo.userId, async (tx) => {
      const acc = await insertAccount(tx, solo.workspaceId, {
        openingBalanceCents: 0,
        openingDate: '2026-10-01',
      });
      const card = await newCard(tx, solo.workspaceId, acc);
      await insertTransactions(tx, solo, [
        {
          cardId: card,
          date: TODAY,
          amountCents: 60_000,
          installments: 3,
          direction: 'out',
          description: 'Fone',
          status: 'scheduled',
        },
      ]);
      return computeCommitment(tx, solo.workspaceId, { months: 6, today: TODAY });
    });
    expect(c.months.every((m) => m.pct === null)).toBe(true);
    expect(c.peak).toBeNull();
    expect(commitmentAnswer(c)).toMatch(
      /^Não encontrei renda recorrente.*novembro de 2026 já tem R\$ 200,00/,
    );
  });
});

describe.skipIf(!hasDb)('Renda comprometida no chat', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;
  let today: string;
  const say = (text: string) => handleMessage(app, actor, { text });

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    actor = await newActor(env);
    const ws = actor.workspaceId;
    today = await env.as(actor.userId, (tx) => workspaceToday(tx, ws));
    const m0 = startOfMonth(today);
    await env.as(actor.userId, async (tx) => {
      const acc = await insertAccount(tx, ws, { openingBalanceCents: 5_000_000, openingDate: m0 });
      const rec = await tx
        .insertInto('recurrences')
        .values({
          workspaceId: ws,
          accountId: acc,
          description: 'Salário',
          amountCents: 500_000,
          direction: 'in',
          rule: 'FREQ=MONTHLY',
          startDate: m0,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let k = 0; k < 24; k++)
        await insertTx(tx, ws, {
          accountId: acc,
          date: addMonths(m0, k),
          amountCents: 500_000,
          direction: 'in',
          status: k ? 'scheduled' : 'posted',
          description: 'Salário',
          recurrenceId: rec.id,
        });
      const card = await newCard(tx, ws, acc);
      await insertTransactions(tx, actor, [
        {
          cardId: card,
          date: today,
          amountCents: 300_000,
          installments: 6,
          direction: 'out',
          description: 'Notebook',
          status: 'scheduled',
        },
      ]);
    });
  });
  afterAll(() => env?.cleanup());

  it('"quanto da minha renda está comprometida?": resposta com gráfico, que volta no histórico', async () => {
    const r = await say('quanto da minha renda está comprometida?');
    expect(r.text).toMatch(/da renda de .+ já está comprometida com parcelas|Em .+ termina Notebook/);
    expect(r.visuals).toHaveLength(1);
    expect(r.visuals[0]).toMatchObject({ type: 'commitment', threshold: 0.3 });
    expect(r.visuals[0]!.months.some((m) => m.committedCents === 50_000 && m.incomeCents === 500_000)).toBe(
      true,
    );
    const saved = await env.as(actor.userId, (tx) =>
      tx.selectFrom('messages').select('parts').where('id', '=', r.messageId).executeTakeFirstOrThrow(),
    );
    expect(saved.parts).toEqual([{ type: 'visual', visual: r.visuals[0] }]);
  });

  it('"posso comprar?" mostra quanto a compra sobe a renda comprometida, sem gravar nada', async () => {
    const count = () =>
      env.as(actor.userId, async (tx) =>
        Number(
          (await sql<{ n: number }>`select count(*)::int as n from transactions`.execute(tx)).rows[0]!.n,
        ),
      );
    const before = await count();
    const r = await say('posso comprar uma geladeira de 2.400 em 12x');
    expect(r.text).toMatch(
      /no cartão Santander: a renda comprometida com parcelas sobe de \d+% para \d+% em/,
    );
    expect(r.visuals).toHaveLength(1);
    const added = r.visuals[0]!.months.filter((m) => (m.addedCents ?? 0) > 0);
    expect(added).toHaveLength(12);
    expect(added.every((m) => m.addedCents === 20_000)).toBe(true);
    expect(await count()).toBe(before);
  });
});
