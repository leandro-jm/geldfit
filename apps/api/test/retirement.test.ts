import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addMonths, retirementPlan, startOfMonth, todayISO, type RetirementScenarioDTO } from '@sf/shared';
import { handleMessage, routeTier } from '../src/agent/orchestrator.js';
import { parseBirthDate } from '../src/agent/tools-retirement.js';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import { insertAccount, type TestEnv } from '../../../db/tests/helpers.js';

describe('parseBirthDate', () => {
  it('ano de 2 dígitos não cai no futuro; datas inválidas são recusadas', () => {
    expect(parseBirthDate('15/03/85', '2026-10-16')).toBe('1985-03-15');
    expect(parseBirthDate('01/01/05', '2026-10-16')).toBe('2005-01-01');
    expect(parseBirthDate('1985-03-15', '2026-10-16')).toBe('1985-03-15');
    expect(() => parseBirthDate('31/02/1990', '2026-10-16')).toThrow();
    expect(() => parseBirthDate('01/01/2030', '2026-10-16')).toThrow();
  });
});

describe.skipIf(!hasDb)('Aposentadoria', () => {
  let env: TestEnv;
  let app: AppContext;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';
  const m0 = startOfMonth(todayISO());

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
    const body = me.json() as { user: { id: string }; workspaces: Array<{ id: string }> };
    env.users.push(body.user.id);
    env.workspaces.push(...body.workspaces.map((w) => w.id));
    return { cookie, userId: body.user.id, ws: body.workspaces[0]!.id };
  }

  /** Plano com 6 extratos mensais até o mês passado: +1% a.m. e R$ 1.000 de contribuição. */
  async function seedPension(ws: string, owner: string, provider = 'Previsc') {
    const plan = await env.owner.db
      .insertInto('pensionPlans')
      .values({ workspaceId: ws, provider, name: 'Plano CD', ownerUserId: owner })
      .returning('id')
      .executeTakeFirstOrThrow();
    let balance = 10_000_000;
    for (let i = 6; i >= 1; i--) {
      if (i < 6) balance = Math.round(balance * 1.01) + 100_000;
      await env.owner.db
        .insertInto('pensionEntries')
        .values({
          workspaceId: ws,
          planId: plan.id,
          refMonth: addMonths(m0, -i),
          balanceCents: balance,
          contribParticipantCents: 50_000,
          contribSponsorCents: 50_000,
        })
        .execute();
    }
    return balance;
  }

  const get = async (cookie: string, query = '', ws?: string) => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/retirement${query}`,
      headers: { cookie, ...(ws ? { 'x-workspace-id': ws } : {}) },
    });
    return { status: res.statusCode, body: res.json() as RetirementScenarioDTO };
  };
  const saveProfile = (cookie: string, payload: Record<string, unknown>, ws?: string) =>
    server.inject({
      method: 'POST',
      url: '/api/actions',
      headers: { cookie, 'content-type': 'application/json', ...(ws ? { 'x-workspace-id': ws } : {}) },
      payload: {
        kind: 'retirement_profile',
        payload: {
          birthDate: '1985-03-15',
          retireAge: 60,
          endAge: 90,
          accumulationRate: 0.04,
          withdrawalRate: 0.03,
          contributionGrowth: 0,
          inssMonthlyCents: null,
          targetIncomeCents: 800_000,
          includeInvestments: false,
          ...payload,
        },
      },
    });

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  it('cenário pelo HTTP: sem nascimento pede a data; com perfil, projeta 2040 a partir dos extratos', async () => {
    const a = await signUp('Rita');
    const last = await seedPension(a.ws, a.userId);

    const r0 = await get(a.cookie);
    expect(r0.status).toBe(200);
    expect(r0.body.missing).toEqual(['birth_date']);
    expect(r0.body.plan).toBeNull();
    expect(r0.body.baseline).toMatchObject({
      pensionBalanceCents: last,
      balanceAsOf: addMonths(m0, -1),
      startMonth: m0,
      monthlyContributionCents: 100_000,
      contributionMonths: 6,
    });
    // 5 pares a 1% a.m. exatos (o arredondamento mexe só na 6ª casa)
    expect(r0.body.baseline.historical?.months).toBe(5);
    expect(r0.body.baseline.historical?.nominalAnnual).toBeCloseTo(1.01 ** 12 - 1, 4);

    const saved = await saveProfile(a.cookie, {});
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ summary: 'Perfil de aposentadoria salvo.' });

    const r1 = await get(a.cookie, '?retire_year=2040');
    expect(r1.status).toBe(200);
    const { params, plan } = r1.body;
    expect(params).toMatchObject({
      retireMonth: '2040-01-01',
      endMonth: '2075-03-01',
      pensionBalanceCents: last,
      monthlyContributionCents: 100_000,
      neededMonthlyCents: 800_000,
      otherAssetsCents: 0,
    });
    expect(r1.body.needSource).toBe('target');
    expect(plan).toEqual(retirementPlan(params!)); // a web recalcula com os mesmos dados
    expect(plan!.projectedMonthlyCents).toBeGreaterThan(0);
    expect(plan!.gapCents).toBe(Math.max(0, 800_000 - plan!.projectedIncomeCents));

    // A data de nascimento não vai para o log de auditoria (visível ao workspace)
    const log = await env.owner.db
      .selectFrom('auditLog')
      .select('after')
      .where('workspaceId', '=', a.ws)
      .where('entity', '=', 'retirement_profiles')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(log.after)).not.toContain('1985');

    // Investimentos entram só com o flag
    await env.as(a.userId, (tx) =>
      insertAccount(tx, a.ws, {
        name: 'XP',
        type: 'investment',
        openingBalanceCents: 600_000,
        openingDate: addMonths(m0, -1),
      }),
    );
    const r2 = await get(a.cookie, '?retire_year=2040&include_investments=1');
    expect(r2.body.baseline.otherAssetsCents).toBe(600_000);
    expect(r2.body.plan!.capitalAtRetirementCents).toBeGreaterThan(plan!.capitalAtRetirementCents);
    expect(r2.body.warnings.join(' ')).toContain('workspace inteiro');

    const bad = await get(a.cookie, '?retire_age=60&end_age=55');
    expect(bad.status).toBe(422);
    const badSave = await saveProfile(a.cookie, { retireAge: 70, endAge: 65 });
    expect(badSave.statusCode).toBe(422);
  });

  it('cada membro vê só os próprios planos e o próprio perfil; leitor não grava', async () => {
    const a = await signUp('Sara');
    const b = await signUp('Tiago');
    await env.owner.db
      .insertInto('memberships')
      .values({ workspaceId: a.ws, userId: b.userId, role: 'member' })
      .execute();
    await seedPension(a.ws, a.userId);
    await seedPension(a.ws, b.userId, 'Funcef');
    expect((await saveProfile(a.cookie, {})).statusCode).toBe(200);

    const ra = await get(a.cookie);
    expect(ra.body.baseline.plans.map((p) => p.provider)).toEqual(['Previsc']);
    expect(ra.body.warnings.join(' ')).toContain('Há 1 plano de outro membro');
    const rb = await get(b.cookie, '', a.ws);
    expect(rb.body.baseline.plans.map((p) => p.provider)).toEqual(['Funcef']);
    expect(rb.body.profile).toBeNull();
    expect(rb.body.missing).toEqual(['birth_date']);

    const v = await signUp('Ugo');
    await env.owner.db
      .insertInto('memberships')
      .values({ workspaceId: a.ws, userId: v.userId, role: 'viewer' })
      .execute();
    expect((await saveProfile(v.cookie, {}, a.ws)).statusCode).toBe(403);
    // leitor ainda simula informando a data na pergunta
    const rv = await get(v.cookie, '?birth_date=1990-01-01', a.ws);
    expect(rv.status).toBe(200);
    expect(rv.body.plan).not.toBeNull();
  });

  it('pelo chat: pede a data, salva o perfil e responde quanto recebe e quanto falta', async () => {
    const actor = await newActor(env);
    const say = (text: string) => handleMessage(app, actor, { text });
    await seedPension(actor.workspaceId, actor.userId);

    const r0 = await say('se eu aposentar em 2040, quanto recebo?');
    expect(r0.text).toContain('data de nascimento');

    const r1 = await say('nasci em 15/03/1985');
    expect(r1.drafts).toHaveLength(1);
    expect((await say('sim')).text).toContain('Perfil de aposentadoria salvo');

    const r2 = await say('se eu aposentar em 2040, quanto recebo e quanto falta?');
    expect(r2.text).toContain('janeiro de 2040');
    expect(r2.text).toContain('reais de hoje');
    expect(r2.text).toMatch(/R\$ [\d.]+,\d{2}/);
    expect(routeTier('quanto falta para eu me aposentar?', false)).toBe('large');
  });
});
