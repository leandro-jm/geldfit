import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '@sf/db';
import { addMonths } from '@sf/shared';
import { handleMessage } from '../src/agent/orchestrator.js';
import type { Actor } from '../src/context.js';
import { confirmDraft, createDraft, type DraftKind, type DraftPayload } from '../src/domain/drafts.js';
import { computeProjection } from '../src/domain/projection.js';
import { detectSeasonal, findSeasonalItem, seasonalCalendar, seasonShape } from '../src/domain/seasonal.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import { insertAccount, insertTx, project, type TestEnv } from '../../../db/tests/helpers.js';

const TODAY = '2026-10-16';
const PREVIEW = { title: 't', summary: 's', lines: [], warnings: [] };

async function monthlyRecurrence(
  tx: Tx,
  ws: string,
  acc: string,
  v: { description: string; cents: number; dir: 'in' | 'out'; start: string },
) {
  const r = await tx
    .insertInto('recurrences')
    .values({
      workspaceId: ws,
      accountId: acc,
      description: v.description,
      amountCents: v.cents,
      direction: v.dir,
      rule: 'FREQ=MONTHLY;BYMONTHDAY=5',
      startDate: v.start,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

async function draft<K extends DraftKind>(env: TestEnv, actor: Actor, kind: K, payload: DraftPayload<K>) {
  return env.as(actor.userId, async (tx) => {
    const d = await createDraft(tx, actor, kind, payload, { ...PREVIEW });
    return confirmDraft(tx, actor, d.id);
  });
}

describe.skipIf(!hasDb)('Calendário financeiro: detecção do histórico', () => {
  let env: TestEnv;
  let actor: Actor;
  let ws: string;
  let acc: string;

  beforeAll(async () => {
    env = setupEnv();
    actor = await newActor(env);
    ws = actor.workspaceId;
    await env.as(actor.userId, async (tx) => {
      acc = await insertAccount(tx, ws, { openingBalanceCents: 5_000_000, openingDate: '2024-01-01' });
      const out = (date: string, cents: number, description: string) =>
        insertTx(tx, ws, { accountId: acc, date, amountCents: cents, direction: 'out', description });
      // IPVA em 3 parcelas, dois anos
      for (const [y, c] of [
        [2025, 70_000],
        [2026, 78_000],
      ] as const)
        for (const m of [1, 2, 3]) await out(`${y}-0${m}-10`, c, `IPVA ${y} parcela ${m}/3 SEFAZ`);
      // IPTU em cota única, um ano só
      await out('2026-02-08', 150_000, 'Prefeitura IPTU 2026 cota unica');
      // Seguro do carro todo ano em agosto/setembro
      await out('2024-09-12', 240_000, 'Seguro Auto Porto');
      await out('2025-09-10', 250_000, 'Seguro Auto Porto');
      await out('2026-08-28', 260_000, 'Seguro Auto Porto');
      // Gasto mensal (não é anual)
      for (let i = 0; i < 12; i++) await out(addMonths('2025-11-03', i), 15_000, 'Academia Smart Fit');
      // Plano de saúde com reajuste em julho (dois anos)
      const plano = await monthlyRecurrence(tx, ws, acc, {
        description: 'Plano de saúde Unimed',
        cents: 118_800,
        dir: 'out',
        start: '2025-01-05',
      });
      for (let d = '2025-01-05'; d <= TODAY; d = addMonths(d, 1)) {
        const cents = d < '2025-07-01' ? 100_000 : d < '2026-07-01' ? 110_000 : 118_800;
        await insertTx(tx, ws, {
          accountId: acc,
          date: d,
          amountCents: cents,
          direction: 'out',
          description: 'Plano de saúde Unimed',
          recurrenceId: plano,
        });
      }
      // Salário sem 13º no histórico: 13º estimado
      await monthlyRecurrence(tx, ws, acc, {
        description: 'Salário',
        cents: 800_000,
        dir: 'in',
        start: '2026-01-05',
      });
      await detectSeasonal(tx, ws, TODAY);
    });
  });

  afterAll(() => env?.cleanup());

  const calendar = () => env.as(actor.userId, (tx) => seasonalCalendar(tx, ws, TODAY, 12));
  const item = async (key: string) => (await calendar()).items.find((i) => i.key === key);

  it('IPVA em 3 parcelas por dois anos vira agenda de 3 parcelas com o valor mais recente', async () => {
    const ipva = await item('ipva');
    expect(ipva).toMatchObject({ status: 'suggested', confidence: 'alta', kind: 'expense', leadDays: 60 });
    expect(ipva!.schedule).toEqual([
      { month: 1, day: 10, amountCents: 78_000 },
      { month: 2, day: 10, amountCents: 78_000 },
      { month: 3, day: 10, amountCents: 78_000 },
    ]);
    expect(ipva!.evidence.map((e) => [e.year, e.totalCents])).toEqual([
      [2025, 210_000],
      [2026, 234_000],
    ]);
    const occ = (await calendar()).occurrences.filter((o) => o.key === 'ipva');
    expect(occ.map((o) => [o.date, o.inProjection])).toEqual([
      ['2027-01-10', false],
      ['2027-02-10', false],
      ['2027-03-10', false],
    ]);
  });

  it('IPTU com um ano de histórico tem confiança média', async () => {
    expect(await item('iptu')).toMatchObject({
      confidence: 'media',
      schedule: [{ month: 2, day: 8, amountCents: 150_000 }],
    });
  });

  it('anual genérico: seguro do carro; gasto mensal não entra', async () => {
    const seguro = await item('annual:seguro auto porto');
    expect(seguro).toMatchObject({
      label: 'Seguro Auto Porto',
      schedule: [{ month: 8, day: 28, amountCents: 260_000 }],
    });
    expect((await calendar()).items.some((i) => i.key.includes('academia'))).toBe(false);
  });

  it('reajuste do plano de saúde em julho', async () => {
    const r = (await calendar()).items.find((i) => i.kind === 'adjustment');
    expect(r).toMatchObject({
      confidence: 'alta',
      adjustmentPct: 8,
      schedule: [{ month: 7, day: 1, amountCents: 9_504 }],
    });
  });

  it('13º estimado pelo salário', async () => {
    expect(await item('decimo_terceiro')).toMatchObject({
      confidence: 'estimado',
      direction: 'in',
      schedule: [
        { month: 11, day: 30, amountCents: 400_000 },
        { month: 12, day: 20, amountCents: 400_000 },
      ],
    });
  });

  it('sugerido não entra na projeção; confirmado entra e sai da média do variável', async () => {
    // em abril, a média do variável (janela de 3 meses) cobre o IPVA pago em jan–mar
    const april = '2026-04-15';
    const before = await env.as(actor.userId, (tx) => project(tx, ws, TODAY));
    const beforeApril = await env.as(actor.userId, (tx) => project(tx, ws, april));
    const ipva = (await item('ipva'))!;
    await draft(env, actor, 'seasonal', { mode: 'confirm', id: ipva.id, fields: {} });
    const after = await env.as(actor.userId, (tx) => project(tx, ws, TODAY));
    const afterApril = await env.as(actor.userId, (tx) => project(tx, ws, april));
    const jan = (rows: typeof after) => rows.find((m) => m.month === '2027-01-01')!;
    expect(jan(after).expenseCents - jan(before).expenseCents).toBe(78_000);
    expect(beforeApril[1]!.variableCents - afterApril[1]!.variableCents).toBe(234_000 / 3);
    const proj = await env.as(actor.userId, (tx) =>
      computeProjection(tx, ws, { today: TODAY, withSeasonal: true }),
    );
    const janProj = proj.months.find((m) => m.month === '2027-01-01')!;
    expect(janProj.seasonal!.find((o) => o.key === 'ipva')).toMatchObject({
      inProjection: true,
      amountCents: 78_000,
    });
    expect(
      proj.months.find((m) => m.month === '2027-02-01')!.seasonal!.find((o) => o.key === 'iptu'),
    ).toMatchObject({
      inProjection: false,
    });
  });

  it('reajuste confirmado soma o acréscimo mensal a partir de julho, composto no ano seguinte', async () => {
    const r = (await calendar()).items.find((i) => i.kind === 'adjustment')!;
    await draft(env, actor, 'seasonal', { mode: 'confirm', id: r.id, fields: {} });
    const rows = await env.as(actor.userId, (tx) =>
      tx
        .selectFrom('plannedCashflows')
        .select(['date', 'amountCents'])
        .where('workspaceId', '=', ws)
        .where('refId', '=', r.id)
        .orderBy('date')
        .execute(),
    );
    expect(rows.find((x) => x.date === '2027-06-01')).toBeUndefined();
    expect(rows.find((x) => x.date === '2027-07-01')?.amountCents).toBe(9_504);
    expect(rows.find((x) => x.date === '2028-07-01')?.amountCents).toBe(
      Math.round(118_800 * (1.08 ** 2 - 1)),
    );
  });

  it('item ignorado não volta e edição do usuário é preservada na nova detecção', async () => {
    const iptu = (await item('iptu'))!;
    await draft(env, actor, 'seasonal', { mode: 'dismiss', id: iptu.id, fields: {} });
    const ipva = (await item('ipva'))!;
    await draft(env, actor, 'seasonal', {
      mode: 'edit',
      id: ipva.id,
      fields: { schedule: [{ month: 1, day: 15, amountCents: 230_000 }] },
    });
    await env.as(actor.userId, (tx) => detectSeasonal(tx, ws, TODAY));
    expect((await item('iptu'))!.status).toBe('dismissed');
    expect((await item('ipva'))!.schedule).toEqual([{ month: 1, day: 15, amountCents: 230_000 }]);
    const occ = (await calendar()).occurrences;
    expect(occ.some((o) => o.key === 'iptu')).toBe(false);
  });

  it('item criado à mão entra direto na projeção', async () => {
    await draft(env, actor, 'seasonal', {
      mode: 'create',
      fields: {
        label: 'Anuidade OAB',
        direction: 'out',
        schedule: [{ month: 3, day: 31, amountCents: 98_000 }],
      },
    });
    const occ = (await calendar()).occurrences.find((o) => o.label === 'Anuidade OAB');
    expect(occ).toMatchObject({ date: '2027-03-31', inProjection: true, status: 'confirmed' });
  });

  it('agente: "quando vem o seguro?" responde com o calendário; "confirma o seguro de 2.700" gera rascunho', async () => {
    const app = makeApp(env);
    const r = await handleMessage(app, actor, { text: 'quais os gastos anuais do calendario?' });
    expect(r.text).toMatch(/Seguro Auto Porto R\$ 2\.600,00 \(sugerido, a confirmar\)/);
    expect(r.text).toMatch(/A confirmar para entrar na projeção: .*Seguro Auto Porto/);
    const d = await handleMessage(app, actor, { text: 'confirma o seguro de 2.700' });
    expect(d.drafts).toHaveLength(1);
    expect(d.drafts[0]!.preview).toMatchObject({
      title: 'Ajustar no calendário: Seguro Auto Porto',
      summary: 'R$ 2.700,00 em cota única (28/ago) · entra na projeção',
    });
  });

  it('acha o item pelo que o usuário fala', async () => {
    const { items } = await calendar();
    expect(findSeasonalItem(items, 'imposto de renda')).toBeNull();
    expect(findSeasonalItem(items, 'ipva')?.key).toBe('ipva');
    expect(findSeasonalItem(items, '13º')?.key).toBe('decimo_terceiro');
    expect(findSeasonalItem(items, 'seguro auto')?.key).toBe('annual:seguro auto porto');
  });
});

describe.skipIf(!hasDb)('Calendário financeiro: temporada em andamento', () => {
  let env: TestEnv;
  let actor: Actor;
  let ws: string;
  const today = '2027-02-12';

  beforeAll(async () => {
    env = setupEnv();
    actor = await newActor(env);
    ws = actor.workspaceId;
    await env.as(actor.userId, async (tx) => {
      const acc = await insertAccount(tx, ws, { openingBalanceCents: 1_000_000, openingDate: '2025-12-01' });
      for (const m of [1, 2, 3])
        await insertTx(tx, ws, {
          accountId: acc,
          date: `2026-0${m}-10`,
          amountCents: 80_000,
          direction: 'out',
          description: 'IPVA 2026',
        });
      // 2027: pagou jan e fev; mar ainda vem
      await insertTx(tx, ws, {
        accountId: acc,
        date: '2027-01-10',
        amountCents: 85_000,
        direction: 'out',
        description: 'IPVA 2027',
      });
      await insertTx(tx, ws, {
        accountId: acc,
        date: '2027-02-10',
        amountCents: 85_000,
        direction: 'out',
        description: 'IPVA 2027',
      });
      await detectSeasonal(tx, ws, today);
    });
  });

  afterAll(() => env?.cleanup());

  it('usa a temporada anterior como base e marca as parcelas já pagas', async () => {
    const cal = await env.as(actor.userId, (tx) => seasonalCalendar(tx, ws, today, 3));
    expect(cal.items[0]).toMatchObject({ key: 'ipva', schedule: [{ month: 1 }, { month: 2 }, { month: 3 }] });
    expect(cal.occurrences.map((o) => [o.date, o.paid])).toEqual([
      ['2027-02-10', true],
      ['2027-03-10', false],
    ]);
  });

  it('pagou tudo em cota única: as parcelas restantes contam como pagas', async () => {
    await env.as(actor.userId, async (tx) => {
      const acc = (
        await tx.selectFrom('accounts').select('id').where('workspaceId', '=', ws).executeTakeFirstOrThrow()
      ).id;
      await insertTx(tx, ws, {
        accountId: acc,
        date: '2027-02-11',
        amountCents: 85_000,
        direction: 'out',
        description: 'IPVA 2027 restante',
      });
    });
    const cal = await env.as(actor.userId, (tx) => seasonalCalendar(tx, ws, today, 3));
    expect(cal.occurrences.every((o) => o.paid)).toBe(true);
  });
});

describe('seasonShape: a temporada começa depois do maior intervalo sem pagamento', () => {
  it('casos típicos', () => {
    expect(seasonShape([1, 2, 3])).toEqual({ start: 1, last: 3 });
    expect(seasonShape([12, 1, 2])).toEqual({ start: 12, last: 2 });
    expect(seasonShape([11, 1])).toEqual({ start: 11, last: 1 });
    expect(seasonShape([8])).toEqual({ start: 8, last: 8 });
    expect(seasonShape([5, 11])).toEqual({ start: 5, last: 11 });
  });
});

describe.skipIf(!hasDb)('Calendário financeiro: temporada que cruza o ano', () => {
  let env: TestEnv;
  let actor: Actor;
  let ws: string;

  beforeAll(async () => {
    env = setupEnv();
    actor = await newActor(env);
    ws = actor.workspaceId;
    await env.as(actor.userId, async (tx) => {
      const acc = await insertAccount(tx, ws, { openingBalanceCents: 1_000_000, openingDate: '2024-11-01' });
      const out = (date: string, cents: number, description: string) =>
        insertTx(tx, ws, { accountId: acc, date, amountCents: cents, direction: 'out', description });
      for (const [d, c] of [
        ['2024-12-10', 70_000],
        ['2025-01-10', 70_000],
        ['2025-02-10', 70_000],
        ['2025-12-10', 78_000],
        ['2026-01-10', 78_000],
        ['2026-02-10', 78_000],
      ] as const)
        await out(d, c, 'IPVA parcela');
      // seguro que renova na virada do ano (dez num ano, jan no outro)
      await out('2024-12-20', 300_000, 'Seguro Residencial Azul');
      await out('2026-01-05', 320_000, 'Seguro Residencial Azul');
      await detectSeasonal(tx, ws, TODAY);
    });
  });

  afterAll(() => env?.cleanup());

  it('IPVA de dez–fev fica numa temporada só, com o ano em que termina', async () => {
    const cal = await env.as(actor.userId, (tx) => seasonalCalendar(tx, ws, TODAY, 12));
    const ipva = cal.items.find((i) => i.key === 'ipva')!;
    expect(ipva).toMatchObject({ confidence: 'alta' });
    expect(ipva.schedule.map((e) => e.month)).toEqual([12, 1, 2]);
    expect(ipva.evidence.map((e) => [e.year, e.totalCents])).toEqual([
      [2025, 210_000],
      [2026, 234_000],
    ]);
    expect(
      cal.occurrences.filter((o) => o.key === 'ipva').map((o) => [o.date, o.season, o.installment?.n]),
    ).toEqual([
      ['2026-12-10', 2027, 1],
      ['2027-01-10', 2027, 2],
      ['2027-02-10', 2027, 3],
    ]);
  });

  it('seguro que alterna dezembro e janeiro é anual', async () => {
    const cal = await env.as(actor.userId, (tx) => seasonalCalendar(tx, ws, TODAY, 12));
    expect(cal.items.find((i) => i.key === 'annual:seguro residencial azul')).toMatchObject({
      schedule: [{ month: 1, day: 5, amountCents: 320_000 }],
    });
  });
});
