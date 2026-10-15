import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import { hasDb, makeApp, setupEnv } from './helpers.js';
import { clearTestPtax, insertPtax, type TestEnv } from '../../../db/tests/helpers.js';

describe.skipIf(!hasDb)('HTTP', () => {
  let env: TestEnv;
  let app: AppContext;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';

  async function signUp(name: string) {
    const email = `${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin, 'content-type': 'application/json' },
      payload: { name, email, password: 'senha-forte-123' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    const body = me.json() as { user: { id: string }; workspaces: Array<{ id: string; role: string }> };
    env.users.push(body.user.id);
    env.workspaces.push(...body.workspaces.map((w) => w.id));
    return { cookie, userId: body.user.id, ws: body.workspaces[0]!.id };
  }

  beforeAll(async () => {
    env = setupEnv();
    app = {
      ...makeApp(env),
      config: { ...makeApp(env).config, EVOLUTION_WEBHOOK_SECRET: 'segredo-do-webhook-123' },
    };
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    if (env) await clearTestPtax(env.owner.db);
    await env?.cleanup();
  });

  it('cadastro cria workspace pessoal e exige login nas rotas', async () => {
    const a = await signUp('Alice');
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
    expect(me.json()).toMatchObject({ workspaces: [{ name: 'Pessoal', role: 'owner' }], consented: false });
    const anon = await server.inject({ method: 'GET', url: '/api/accounts' });
    expect(anon.statusCode).toBe(401);
  });

  it('não acessa workspace de outro usuário pelo cabeçalho', async () => {
    const a = await signUp('Ana');
    const b = await signUp('Bruno');
    const res = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie: b.cookie, 'x-workspace-id': a.ws },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ações por formulário passam pelo draft (auditoria) e leitor é bloqueado', async () => {
    const a = await signUp('Carla');
    const ok = await server.inject({
      method: 'POST',
      url: '/api/actions',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: {
        kind: 'account',
        payload: {
          mode: 'create',
          fields: {
            institution: 'Cresol',
            name: 'Cresol',
            type: 'checking',
            openingBalanceCents: 100_000,
            openingDate: '2026-10-01',
            isPrivate: false,
          },
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ summary: 'Conta salva.' });

    const v = await signUp('Vitor');
    await env.owner.db
      .insertInto('memberships')
      .values({ workspaceId: a.ws, userId: v.userId, role: 'viewer' })
      .execute();
    const denied = await server.inject({
      method: 'POST',
      url: '/api/actions',
      headers: { cookie: v.cookie, 'x-workspace-id': a.ws, 'content-type': 'application/json' },
      payload: {
        kind: 'budget',
        payload: { categoryId: '00000000-0000-0000-0000-000000000000', amountCents: 100 },
      },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('conta em dólar: saldo convertido pela PTAX e transferência com câmbio', async () => {
    await insertPtax(env.owner.db, '2026-10-01', 5);
    const a = await signUp('Dora');
    const act = (kind: string, payload: unknown) =>
      server.inject({
        method: 'POST',
        url: '/api/actions',
        headers: { cookie: a.cookie, 'content-type': 'application/json' },
        payload: { kind, payload },
      });
    const account = (name: string, currency: 'BRL' | 'USD', openingBalanceCents: number) => ({
      institution: name,
      name,
      type: 'checking',
      currency,
      openingBalanceCents,
      openingDate: '2026-10-01',
      isPrivate: false,
    });
    const bb = (await act('account', { mode: 'create', fields: account('BB', 'BRL', 1_000_000) })).json()
      .ids[0] as string;
    const nomadRes = await act('account', { mode: 'create', fields: account('Nomad', 'USD', 100_000) });
    expect(nomadRes.statusCode).toBe(200);
    const nomad = nomadRes.json().ids[0] as string;

    const list = async () =>
      (
        await server.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: a.cookie } })
      ).json() as Array<{
        id: string;
        currency: string;
        balanceCents: number;
        balanceBrlCents: number;
        fx: { rate: number; date: string } | null;
      }>;
    expect((await list()).find((x) => x.id === nomad)).toMatchObject({
      currency: 'USD',
      balanceCents: 100_000,
      balanceBrlCents: 500_000,
      fx: { rate: 5, date: '2026-10-01' },
    });
    expect((await list()).find((x) => x.id === bb)).toMatchObject({ currency: 'BRL', fx: null });

    const transfer = {
      fromAccountId: bb,
      toAccountId: nomad,
      amountCents: 560_000,
      date: '2026-10-05',
      description: 'Envio Nomad',
    };
    const noRate = await act('transfer', transfer);
    expect(noRate.statusCode).toBe(422);
    expect(await act('transfer', { ...transfer, toAmountCents: 100_000 })).toMatchObject({ statusCode: 200 });
    const after = await list();
    expect(after.find((x) => x.id === nomad)!.balanceCents).toBe(200_000);
    expect(after.find((x) => x.id === bb)!.balanceCents).toBe(440_000);

    // Moeda não muda depois de haver lançamentos; fatura de cartão não é paga em dólar
    expect(
      (await act('account', { mode: 'update', id: nomad, fields: account('Nomad', 'BRL', 100_000) }))
        .statusCode,
    ).toBe(422);
    const card = await act('card', {
      mode: 'create',
      fields: { name: 'Visa', accountId: nomad, limitCents: 100_000, closingDay: 5, dueDay: 12 },
    });
    expect(card.statusCode).toBe(422);
  });

  it('transferência: recusa mesma conta e edição mantém o par alinhado', async () => {
    await insertPtax(env.owner.db, '2026-10-01', 5);
    const a = await signUp('Dora');
    const act = (kind: string, payload: unknown) =>
      server.inject({
        method: 'POST',
        url: '/api/actions',
        headers: { cookie: a.cookie, 'content-type': 'application/json' },
        payload: { kind, payload },
      });
    const create = async (name: string, currency: 'BRL' | 'USD') =>
      (
        await act('account', {
          mode: 'create',
          fields: {
            institution: name,
            name,
            type: 'checking',
            currency,
            openingBalanceCents: 1_000_000,
            openingDate: '2026-10-01',
            isPrivate: false,
          },
        })
      ).json().ids[0] as string;
    const bb = await create('BB', 'BRL');
    const nubank = await create('Nubank', 'BRL');
    const nomad = await create('Nomad', 'USD');
    type Tx = { id: string; accountId: string; transferId: string | null; amountCents: number; date: string };
    const txs = async () =>
      (
        (
          await server.inject({ method: 'GET', url: '/api/transactions', headers: { cookie: a.cookie } })
        ).json() as { items: Tx[] }
      ).items;
    const pairOf = async (legId: string) => {
      const all = await txs();
      const transferId = all.find((t) => t.id === legId)!.transferId;
      return all.filter((t) => t.transferId === transferId);
    };
    const balances = async () =>
      Object.fromEntries(
        (
          (
            await server.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: a.cookie } })
          ).json() as Array<{ id: string; balanceCents: number }>
        ).map((x) => [x.id, x.balanceCents]),
      );

    const base = { amountCents: 10_000, date: '2026-10-05', description: 'Reserva' };
    expect((await act('transfer', { ...base, fromAccountId: bb, toAccountId: bb })).statusCode).toBe(422);

    // Mesma moeda: data e valor de uma perna vão para a outra
    const r = await act('transfer', { ...base, fromAccountId: bb, toAccountId: nubank });
    expect(r.statusCode).toBe(200);
    const outId = r.json().ids[0] as string;
    const edit = await act('edit', {
      transactionIds: [outId],
      changes: { amountCents: 25_000, date: '2026-10-06' },
    });
    expect(edit.statusCode).toBe(200);
    const pair = await pairOf(outId);
    expect(pair).toHaveLength(2);
    for (const leg of pair) expect(leg).toMatchObject({ amountCents: 25_000, date: '2026-10-06' });
    const bal = await balances();
    expect(bal[bb]).toBe(975_000);
    expect(bal[nubank]).toBe(1_025_000);
    expect((await act('edit', { transactionIds: [outId], changes: { accountId: nomad } })).statusCode).toBe(
      422,
    );

    // Moedas diferentes: o valor enviado não mexe no valor recebido em dólar
    const fx = await act('transfer', {
      ...base,
      fromAccountId: bb,
      toAccountId: nomad,
      toAmountCents: 2_000,
    });
    expect(fx.statusCode).toBe(200);
    const fxOut = fx.json().ids[0] as string;
    expect(
      (await act('edit', { transactionIds: [fxOut], changes: { amountCents: 11_000, date: '2026-10-07' } }))
        .statusCode,
    ).toBe(200);
    const fxPair = await pairOf(fxOut);
    expect(fxPair.find((t) => t.id === fxOut)).toMatchObject({ amountCents: 11_000, date: '2026-10-07' });
    expect(fxPair.find((t) => t.accountId === nomad)).toMatchObject({
      amountCents: 2_000,
      date: '2026-10-07',
    });
  });

  it('lançamento avulso pela tela: categoria automática, origem manual e parcelas no cartão', async () => {
    const a = await signUp('Dora');
    const act = (kind: string, payload: unknown) =>
      server.inject({
        method: 'POST',
        url: '/api/actions',
        headers: { cookie: a.cookie, 'content-type': 'application/json' },
        payload: { kind, payload },
      });
    const bb = (
      await act('account', {
        mode: 'create',
        fields: {
          institution: 'BB',
          name: 'BB',
          type: 'checking',
          openingBalanceCents: 100_000,
          openingDate: '2026-10-01',
          isPrivate: false,
        },
      })
    ).json().ids[0] as string;
    const card = (
      await act('card', {
        mode: 'create',
        fields: { name: 'Visa', accountId: bb, limitCents: 500_000, closingDay: 5, dueDay: 12 },
      })
    ).json().ids[0] as string;
    type Tx = {
      id: string;
      description: string;
      categoryName: string | null;
      source: string;
      amountCents: number;
      installmentTotal: number | null;
    };
    const txs = async () =>
      (
        (
          await server.inject({
            method: 'GET',
            url: '/api/transactions',
            headers: { cookie: a.cookie },
          })
        ).json() as { items: Tx[] }
      ).items;

    const item = { date: '2026-10-05', direction: 'out', amountCents: 8_500 };
    expect(
      (
        await act('transactions', {
          source: 'manual',
          items: [{ ...item, accountId: bb, description: 'Mercado Extra' }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await txs()).find((t) => t.description === 'Mercado Extra')).toMatchObject({
      categoryName: 'Mercado',
      source: 'manual',
    });

    // Nem conta nem cartão: mensagem clara em vez de erro de constraint
    const none = await act('transactions', {
      source: 'manual',
      items: [{ date: '2026-10-05', direction: 'out', amountCents: 100, description: 'Solto' }],
    });
    expect(none.statusCode).toBe(422);

    const inst = await act('transactions', {
      source: 'manual',
      items: [
        { ...item, accountId: null, cardId: card, amountCents: 30_000, description: 'TV', installments: 3 },
      ],
    });
    expect(inst.statusCode).toBe(200);
    expect(inst.json().ids).toHaveLength(3);
    const parts = (await txs()).filter((t) => t.description.startsWith('TV ('));
    expect(parts).toHaveLength(3);
    expect(parts.reduce((s, t) => s + t.amountCents, 0)).toBe(30_000);
  });

  it('webhook exige o segredo e download exige assinatura', async () => {
    const bad = await server.inject({ method: 'POST', url: '/webhooks/evolution/errado', payload: {} });
    expect(bad.statusCode).toBe(401);
    const good = await server.inject({
      method: 'POST',
      url: '/webhooks/evolution/segredo-do-webhook-123',
      payload: { event: 'connection.update' },
    });
    expect(good.statusCode).toBeLessThan(300);
    const file = await server.inject({
      method: 'GET',
      url: '/api/files/00000000-0000-0000-0000-000000000000?exp=9999999999&sig=abc',
    });
    expect(file.statusCode).toBe(403);
  });

  it('consentimento LGPD e exportação', async () => {
    const a = await signUp('Dora');
    const c = await server.inject({
      method: 'POST',
      url: '/api/me/consent',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: { terms: true, privacy: true, llm: true },
    });
    expect(c.statusCode).toBe(200);
    const me = await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
    expect(me.json().consented).toBe(true);
    const exp = await server.inject({ method: 'GET', url: '/api/export', headers: { cookie: a.cookie } });
    expect(exp.statusCode).toBe(200);
    expect(JSON.parse(exp.body)).toHaveProperty('transactions');
  });
});
