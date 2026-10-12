import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@sf/db';
import { handleMessage } from '../src/agent/orchestrator.js';
import { looksLikeRecommendation } from '../src/agent/compliance.js';
import type { Actor, AppContext } from '../src/context.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

describe.skipIf(!hasDb)('Agente (provedor fake): draft → confirmação → auditoria', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    actor = await newActor(env);
  });
  afterAll(async () => env?.cleanup());

  const say = (text: string) => handleMessage(app, actor, { text });
  const count = async (table: string) =>
    env.as(
      actor.userId,
      async (tx) =>
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from ${sql.table(table)} where workspace_id = ${actor.workspaceId}::uuid`.execute(
            tx,
          )
        ).rows[0]!.n,
    );

  it('cadastra conta e cartão por conversa', async () => {
    const r1 = await say('abri uma conta no BB com 5.000');
    expect(r1.drafts).toHaveLength(1);
    expect(await count('accounts')).toBe(0); // nada gravado antes da confirmação
    const c1 = await say('sim');
    expect(c1.text).toContain('Conta salva');
    expect(await count('accounts')).toBe(1);

    await say('cartão Santander fecha dia 5 e vence dia 12, limite 10 mil');
    await say('sim');
    expect(await count('cards')).toBe(1);
  });

  it('lança despesa por frase e mostra o efeito na projeção', async () => {
    // o saldo inicial informado hoje já inclui o que foi pago antes; lançamento de hoje altera o saldo
    const r = await say('paguei 230 de luz no BB hoje');
    expect(r.drafts).toHaveLength(1);
    const preview = r.drafts[0]!.preview;
    expect(preview.summary).toContain('R$ 230,00');
    expect(preview.items?.[0]?.category).toBe('Energia');
    expect(preview.projectionImpact).toBeTruthy();
    const c = await say('sim');
    expect(c.text).toMatch(/Lançamento registrado/);
    const tx = await env.as(actor.userId, (t) =>
      t.selectFrom('transactions').selectAll().where('workspaceId', '=', actor.workspaceId).execute(),
    );
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ amountCents: 23_000, direction: 'out', status: 'posted' });
    expect(await count('audit_log')).toBeGreaterThan(0);
  });

  it('compra parcelada no cartão gera 10 parcelas nas faturas certas', async () => {
    const r = await say('comprei uma TV de 3.600 em 10x no cartão Santander');
    expect(r.drafts[0]!.preview.items?.[0]?.description).toContain('10x de R$ 360,00');
    await say('sim');
    const rows = await env.as(actor.userId, (t) =>
      t
        .selectFrom('transactions as t')
        .innerJoin('cardStatements as s', 's.id', 't.cardStatementId')
        .select(['t.installmentN', 's.refMonth'])
        .where('t.workspaceId', '=', actor.workspaceId)
        .orderBy('t.installmentN')
        .execute(),
    );
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.refMonth)).size).toBe(10);
  });

  it('cancelar não grava nada', async () => {
    const before = await count('transactions');
    await say('gastei 50 no mercado');
    const c = await say('não');
    expect(c.text).toContain('Cancelado');
    expect(await count('transactions')).toBe(before);
  });

  it('corrige o último lançamento e desfaz', async () => {
    const f = await say('paguei 80 de farmácia no BB hoje');
    const fc = await say('sim');
    const e = await say('corrige o último lançamento para 250');
    expect(e.drafts[0]!.preview.lines.some((l) => l.value.includes('R$ 250,00'))).toBe(true);
    await say('sim');
    const last = await env.as(actor.userId, (t) =>
      t
        .selectFrom('transactions')
        .select('amountCents')
        .where('description', 'ilike', '%farm%')
        .executeTakeFirstOrThrow(),
    );
    expect(last.amountCents).toBe(25_000);
    await handleMessage(app, actor, { text: 'desfaz' });
    await say('sim');
    const reverted = await env.as(actor.userId, (t) =>
      t
        .selectFrom('transactions')
        .select('amountCents')
        .where('description', 'ilike', '%farm%')
        .executeTakeFirstOrThrow(),
    );
    expect(reverted.amountCents).toBe(8_000);
  });

  it('apaga por descrição', async () => {
    const before = await count('transactions');
    await say('apaga a compra da farmácia');
    await say('sim');
    expect(await count('transactions')).toBe(before - 1);
  });

  it('recorrência de salário materializa 24+ meses', async () => {
    await say('todo dia 5 entra 8.500 de salário no BB');
    await say('sim');
    const n = await env.as(actor.userId, (t) =>
      t
        .selectFrom('transactions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('recurrenceId', 'is not', null)
        .executeTakeFirstOrThrow(),
    );
    expect(Number(n.n)).toBeGreaterThanOrEqual(24);
  });

  it('pagamento real de conta recorrente baixa a ocorrência agendada (sem duplicar)', async () => {
    const { addDays, todayISO } = await import('@sf/shared');
    const day = Number(addDays(todayISO(), 2).slice(8, 10));
    await say(`todo dia ${day} pago 120 de internet no BB`);
    await say('sim');
    const before = await count('transactions');
    await say('paguei 125 de internet no BB hoje');
    await say('sim');
    expect(await count('transactions')).toBe(before); // reconciliou em vez de inserir
    const rows = await env.as(actor.userId, (t) => t.selectFrom('transactions').select(['status', 'amountCents']).where('recurrenceId', 'is not', null).where('amountCents', '=', 12_500).execute());
    expect(rows).toEqual([{ status: 'posted', amountCents: 12_500 }]);
  });

  it('consultas respondem com números', async () => {
    const p = await say('quanto sobra em dezembro?');
    expect(p.text).toMatch(/dezembro de \d{4}.*R\$/);
    const q = await say('quanto gastei com energia em outubro?');
    expect(q.text).toMatch(/R\$ 230,00/);
  });

  it('leitor não consegue gravar', async () => {
    const viewer = await env.createUser('Leitor');
    await env.addMember(actor.workspaceId, viewer, 'viewer');
    const r = await handleMessage(
      app,
      { ...actor, userId: viewer, role: 'viewer' },
      { text: 'paguei 10 de luz no BB' },
    );
    expect(r.drafts).toHaveLength(0);
    expect(r.text).toMatch(/leitura/);
  });
});

describe('Filtro CVM 19', () => {
  it.each([
    'Recomendo comprar PETR4 agora.',
    'Você deveria vender ITUB4 e comprar BBAS3.',
    'Mantenha TAEE11 na carteira.',
    'Sugiro investir em IVVB11 para se proteger.',
  ])('bloqueia: %s', (t) => expect(looksLikeRecommendation(t)).toBe(true));
  it.each([
    'ITUB4 é 31% das suas ações.',
    'Você comprou 100 ITUB4 a R$ 32,50 em 10/10.',
    'Não posso recomendar comprar PETR4; posso mostrar os fatos da carteira.',
    'Sua exposição ao dólar está em 4%; sua meta é 10–15%.',
  ])('permite: %s', (t) => expect(looksLikeRecommendation(t)).toBe(false));
});
