import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goalPlan, type FinancialProfileDTO, type MemoryDTO } from '@sf/shared';
import { handleMessage } from '../src/agent/orchestrator.js';
import type { Actor, AppContext } from '../src/context.js';
import { confirmDraft } from '../src/domain/drafts.js';
import {
  budgetTrend,
  detectAll,
  emergencyGap,
  goalBehind,
  goalFromMemory,
  memoryDue,
  noGoalSurplus,
  profileGap,
  seasonalPrep,
} from '../src/domain/nudges/detectors.js';
import { planDeliveries, type PlannerHistory, type PlannerNudge } from '../src/domain/nudges/planner.js';
import { footer, numbersMatch } from '../src/domain/nudges/render.js';
import {
  answerNudge,
  dismissNudge,
  listNudges,
  prepareNudge,
  refreshNudges,
} from '../src/domain/nudges/service.js';
import type { NudgeCtx } from '../src/domain/nudges/types.js';
import { PROFILE_DEFAULTS, getProfile } from '../src/domain/profile.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

const TODAY = '2026-10-21';

function ctx(over: Partial<NudgeCtx> = {}): NudgeCtx {
  return {
    today: TODAY,
    role: 'owner',
    profile: {
      ...PROFILE_DEFAULTS,
      incomeStability: 'clt',
      dependents: 0,
      objectives: ['reserva'],
      interests: ['ir'],
    },
    memories: [],
    goals: [],
    emergencyMonthsTarget: 6,
    projection: null,
    reserve: null,
    commitment: null,
    categories: [],
    calendar: null,
    insights: [],
    ...over,
  };
}

const goal = (o: Partial<NudgeCtx['goals'][number]> = {}) => {
  const g = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Viagem Chile',
    kind: 'travel' as const,
    targetCents: 1_200_000,
    savedCents: 0,
    monthlyContributionCents: 50_000,
    startMonth: '2026-11-01',
    targetDate: '2027-06-30',
    ...o,
  };
  return { ...g, plan: goalPlan(g, TODAY) };
};

const memory = (o: Partial<MemoryDTO>): MemoryDTO => ({
  id: crypto.randomUUID(),
  scope: 'personal',
  category: 'objetivo',
  key: 'objetivo.x',
  content: 'Quer trocar de carro em 2027',
  sensitive: false,
  status: 'active',
  source: 'chat',
  importance: 4,
  pinned: false,
  expiresAt: null,
  mine: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...o,
});

const month = (m: string, net: number) => ({
  month: m,
  openingCents: 0,
  incomeCents: 1_000_000,
  expenseCents: 1_000_000 - net,
  cardBillsCents: 0,
  variableCents: 0,
  goalsCents: 0,
  closingCents: 0,
  closingOptimisticCents: 0,
  closingPessimisticCents: 0,
  belowFloor: false,
});

describe('Detectores proativos', () => {
  it('meta atrasada propõe o aporte necessário como prévia', () => {
    const [c] = goalBehind(ctx({ goals: [goal()] }));
    expect(c).toMatchObject({ kind: 'goal_behind', type: 'nudge', category: 'meta' });
    expect(c!.message).toContain('Viagem Chile');
    expect(c!.draft!.kind).toBe('goal');
    const needed = (c!.draft!.payload as { fields: { monthlyContributionCents: number } }).fields
      .monthlyContributionCents;
    expect(needed).toBe(goalPlan(goal(), TODAY).recommendedMonthlyCents);
    expect(goalBehind(ctx({ goals: [goal({ monthlyContributionCents: 200_000 })] }))).toHaveLength(0);
  });

  it('objetivo da memória sem meta vira pergunta; com meta parecida, não', () => {
    const m = memory({ content: 'Quer trocar de carro em 2027' });
    expect(goalFromMemory(ctx({ memories: [m] }))[0]).toMatchObject({
      type: 'question',
      kind: 'goal_from_memory',
    });
    expect(goalFromMemory(ctx({ memories: [m], goals: [goal({ name: 'Carro novo' })] }))).toHaveLength(0);
  });

  it('sobra sem metas: pergunta com reserva de emergência como prévia', () => {
    const c = ctx({
      projection: {
        months: [
          month('2026-10-01', 0),
          month('2026-11-01', 80_000),
          month('2026-12-01', 60_000),
          month('2027-01-01', 70_000),
        ],
        floorCents: 0,
        firstBelowFloor: null,
        minClosing: null,
        computedAt: '',
      },
      reserve: {
        reserveCents: 1_000_000,
        breakdown: { accountsCents: 1_000_000, investmentsCents: 0 },
        months: 2,
        runsOutMonth: '2026-12-01',
        monthlyCostCents: 500_000,
        otherIncomeCents: 0,
        salaries: [],
        targetMonths: 6,
        status: 'low',
        timeline: [],
      },
    });
    const [q] = noGoalSurplus(c);
    expect(q!.message).toContain('R$ 700,00');
    expect(q!.options!.map((o) => o.id)).toEqual(['reserve', 'other', 'later']);
    // a pergunta da sobra já oferece a reserva: o detector de reserva fica quieto
    expect(emergencyGap(c)).toHaveLength(0);
    expect(emergencyGap({ ...c, goals: [goal()] })[0]).toMatchObject({ kind: 'emergency_gap' });
  });

  it('orçamento: só depois do dia 20, sem orçamento e 20% acima da média', () => {
    const cat = {
      categoryId: 'c1',
      name: 'Mercado',
      currentCents: 150_000,
      averageCents: 100_000,
      budgetCents: null,
    };
    expect(budgetTrend(ctx({ categories: [cat] }))[0]!.draft!.payload).toMatchObject({
      amountCents: 100_000,
    });
    expect(budgetTrend(ctx({ today: '2026-10-10', categories: [cat] }))).toHaveLength(0);
    expect(budgetTrend(ctx({ categories: [{ ...cat, budgetCents: 90_000 }] }))).toHaveLength(0);
  });

  it('sazonal: gasto grande entre 45 e 120 dias vira meta mensal', () => {
    const occ = (date: string, amountCents: number) => ({
      itemId: 'i1',
      key: 'ipva',
      label: 'IPVA',
      kind: 'expense' as const,
      direction: 'out' as const,
      date,
      season: 2027,
      amountCents,
      status: 'confirmed' as const,
      confidence: 'alta' as const,
      paid: false,
      inProjection: true,
      installment: null,
    });
    const [c] = seasonalPrep(ctx({ calendar: { items: [], occurrences: [occ('2027-01-20', 180_000)] } }));
    expect(c).toMatchObject({ kind: 'seasonal_prep', fingerprint: 'seasonal_prep:i1:2027' });
    expect(c!.draft!.payload).toMatchObject({ fields: { name: 'IPVA 2027', targetCents: 180_000 } });
    expect(
      seasonalPrep(ctx({ calendar: { items: [], occurrences: [occ('2026-11-10', 180_000)] } })),
    ).toHaveLength(0);
  });

  it('compromisso anotado vencendo vira pergunta com opções', () => {
    const m = memory({ category: 'compromisso', content: 'Cancelar a academia', expiresAt: '2026-10-22' });
    const [q] = memoryDue(ctx({ memories: [m] }));
    expect(q!.options!.map((o) => o.label)).toEqual(['Sim, feito', 'Ainda não', 'Desisti']);
    expect(memoryDue(ctx({ memories: [{ ...m, expiresAt: '2026-12-01' }] }))).toHaveLength(0);
  });

  it('perfil incompleto: uma pergunta por vez, e nenhuma se o usuário desligou', () => {
    const p: FinancialProfileDTO = { ...PROFILE_DEFAULTS };
    expect(profileGap(ctx({ profile: p }))[0]!.fingerprint).toBe('profile_gap:income_stability');
    expect(profileGap(ctx({ profile: { ...p, incomeStability: 'clt' } }))[0]!.fingerprint).toBe(
      'profile_gap:dependents',
    );
    expect(profileGap(ctx({ profile: { ...p, questionsEnabled: false } }))).toHaveLength(0);
  });

  it('leitor não recebe ações de um toque', () => {
    const all = detectAll(ctx({ role: 'viewer', goals: [goal()] }));
    expect(all.some((c) => c.draft)).toBe(false);
  });

  it('nenhum texto de detector recomenda ativo (CVM 19)', async () => {
    const { looksLikeRecommendation } = await import('../src/agent/compliance.js');
    const all = detectAll(
      ctx({
        goals: [goal()],
        memories: [
          memory({}),
          memory({ category: 'compromisso', content: 'Pagar o IPTU', expiresAt: TODAY }),
        ],
        insights: [
          {
            id: 'x',
            title: 'Concentração',
            message: 'PETR4 é 40% da carteira.',
            severity: 'warning',
            rule: 'concentration',
          },
        ],
      }),
    );
    expect(all.length).toBeGreaterThan(2);
    for (const c of all) expect(looksLikeRecommendation(c.message)).toBe(false);
  });
});

describe('Planejador de entregas', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const n = (o: Partial<PlannerNudge>): PlannerNudge => ({
    id: crypto.randomUUID(),
    kind: 'goal_behind',
    type: 'nudge',
    category: 'meta',
    priority: 50,
    status: 'candidate',
    snoozeUntil: null,
    ...o,
  });
  const h = (o: Partial<PlannerHistory> = {}): PlannerHistory => ({
    delivered: [],
    dismissed: [],
    mutes: [],
    remindersToday: 0,
    scheduledToday: false,
    ...o,
  });
  const prefs = { frequency: 'normal' as const, questionsEnabled: true };
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it('escolhe o de maior prioridade, um por dia', () => {
    const a = n({ priority: 40 });
    const b = n({ priority: 70, kind: 'emergency_gap' });
    expect(planDeliveries([a, b], h(), prefs, now)).toEqual([b]);
    expect(planDeliveries([a, b], h({ delivered: [{ type: 'nudge', at: ago(0.5) }] }), prefs, now)).toEqual(
      [],
    );
  });

  it('teto semanal pela frequência, desligado, dia cheio de lembretes e agendado pendente', () => {
    const week = [1, 2, 3].map((d) => ({ type: 'nudge' as const, at: ago(d) }));
    expect(planDeliveries([n({})], h({ delivered: week }), prefs, now)).toEqual([]);
    expect(
      planDeliveries([n({})], h({ delivered: week }), { ...prefs, frequency: 'alta' }, now),
    ).toHaveLength(1);
    expect(planDeliveries([n({})], h(), { ...prefs, frequency: 'off' }, now)).toEqual([]);
    expect(planDeliveries([n({})], h({ remindersToday: 3 }), prefs, now)).toEqual([]);
    expect(planDeliveries([n({})], h({ scheduledToday: true }), prefs, now)).toEqual([]);
  });

  it('silêncio por tipo e categoria, pausa depois de dispensa, perguntas espaçadas', () => {
    expect(planDeliveries([n({})], h({ mutes: ['goal_behind'] }), prefs, now)).toEqual([]);
    expect(planDeliveries([n({})], h({ mutes: ['cat:meta'] }), prefs, now)).toEqual([]);
    expect(
      planDeliveries([n({})], h({ dismissed: [{ kind: 'goal_behind', at: ago(5) }] }), prefs, now),
    ).toEqual([]);
    expect(
      planDeliveries([n({})], h({ dismissed: [{ kind: 'goal_behind', at: ago(20) }] }), prefs, now),
    ).toHaveLength(1);
    const q = n({ type: 'question', kind: 'profile_gap' });
    expect(planDeliveries([q], h({ delivered: [{ type: 'question', at: ago(2) }] }), prefs, now)).toEqual([]);
    expect(planDeliveries([q], h(), { ...prefs, questionsEnabled: false }, now)).toEqual([]);
  });

  it('adiado só volta quando vence o adiamento', () => {
    const s = n({ status: 'snoozed', snoozeUntil: new Date(now.getTime() + 86_400_000) });
    expect(planDeliveries([s], h(), prefs, now)).toEqual([]);
    expect(planDeliveries([{ ...s, snoozeUntil: ago(1) }], h(), prefs, now)).toHaveLength(1);
  });
});

describe('Redação do aviso', () => {
  it('rejeita número que não está no template', () => {
    const t = 'Faltam R$ 1.200,00; o aporte seria R$ 300,00/mês até 30/06/2027.';
    expect(numbersMatch('Olá! Faltam R$ 1.200,00 e o aporte ideal é R$ 300,00/mês até 30/06/2027.', t)).toBe(
      true,
    );
    expect(numbersMatch('Faltam R$ 1.250,00, aporte de R$ 300,00/mês.', t)).toBe(false);
  });
  it('rodapé conforme o tipo', () => {
    expect(footer({ type: 'question', hasDraft: false, options: [1] })).toContain('número');
    expect(footer({ type: 'nudge', hasDraft: true, options: [] })).toContain('*sim*');
    expect(footer({ type: 'nudge', hasDraft: false, options: [] })).toContain('*parar*');
  });
});

describe.skipIf(!hasDb)('Sugestões proativas no banco', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    actor = await newActor(env);
  });
  afterAll(async () => env?.cleanup());

  it('grava candidatos, não repete, aceita pela prévia e supera o que perdeu o sentido', async () => {
    const { id: goalId } = await env.owner.db
      .insertInto('goals')
      .values({
        workspaceId: actor.workspaceId,
        name: 'Intercâmbio',
        kind: 'travel',
        targetCents: 3_000_000,
        monthlyContributionCents: 10_000,
        startMonth: '2026-01-01',
        targetDate: '2027-12-31',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const r1 = await env.as(actor.userId, (tx) => refreshNudges(tx, actor));
    expect(r1.created).toBeGreaterThan(0);
    const r2 = await env.as(actor.userId, (tx) => refreshNudges(tx, actor));
    expect(r2.created).toBe(0);
    const open = await env.as(actor.userId, (tx) => listNudges(tx, actor));
    const behind = open.find((n) => n.kind === 'goal_behind')!;
    expect(behind).toMatchObject({ hasDraft: true, status: 'candidate' });
    // perfil incompleto: pergunta de perfil também está na caixa
    expect(open.some((n) => n.kind === 'profile_gap')).toBe(true);

    const d = await env.as(actor.userId, (tx) => prepareNudge(tx, actor, behind.id));
    // pedir de novo reaproveita a mesma prévia
    expect((await env.as(actor.userId, (tx) => prepareNudge(tx, actor, behind.id))).id).toBe(d.id);
    await env.as(actor.userId, (tx) => confirmDraft(tx, actor, d.id));
    const g = await env.owner.db
      .selectFrom('goals')
      .selectAll()
      .where('id', '=', goalId)
      .executeTakeFirstOrThrow();
    expect(g.monthlyContributionCents).toBeGreaterThan(10_000);
    const after = await env.as(actor.userId, (tx) => listNudges(tx, actor, 'history'));
    expect(after.find((n) => n.id === behind.id)!.status).toBe('accepted');
    // meta em dia: não volta a sugerir
    await env.as(actor.userId, (tx) => refreshNudges(tx, actor));
    expect(
      (await env.as(actor.userId, (tx) => listNudges(tx, actor))).some((n) => n.kind === 'goal_behind'),
    ).toBe(false);
  });

  it('responde pergunta de perfil, dispensa com silêncio e o tipo não volta', async () => {
    const open = await env.as(actor.userId, (tx) => listNudges(tx, actor));
    const q = open.find((n) => n.kind === 'profile_gap')!;
    expect(q.options[0]).toMatchObject({ id: 'clt', label: 'CLT' });
    const r = await env.as(actor.userId, (tx) => answerNudge(tx, actor, q.id, 'clt'));
    expect(r.reply).toContain('clt');
    expect((await env.as(actor.userId, (tx) => getProfile(tx, actor))).incomeStability).toBe('clt');

    await env.as(actor.userId, (tx) => refreshNudges(tx, actor));
    const next = (await env.as(actor.userId, (tx) => listNudges(tx, actor))).find(
      (n) => n.kind === 'profile_gap',
    )!;
    expect(next.options.map((o) => o.label)).toContain('Nenhuma');
    await env.as(actor.userId, (tx) => dismissNudge(tx, actor, next.id, true));
    await env.as(actor.userId, (tx) => refreshNudges(tx, actor));
    // silenciado: nenhuma pergunta de perfil volta, nem com outra pergunta (renda já respondida)
    expect(
      (await env.as(actor.userId, (tx) => listNudges(tx, actor))).some((n) => n.kind === 'profile_gap'),
    ).toBe(false);
  });

  it('redação por LLM: vale quando mantém os números; descarta número inventado ou recomendação', async () => {
    const { phrase } = await import('../src/domain/nudges/render.js');
    const msg =
      'Sua meta *Viagem* está atrasada: faltam R$ 1.200,00; o aporte seria R$ 300,00/mês. Quer que eu ajuste?';
    const withReply = (text: string): AppContext => ({
      ...app,
      llm: {
        name: 'stub',
        extract: async () => {
          throw new Error('n/a');
        },
        chat: async () => ({
          content: [{ type: 'text', text }],
          stopReason: 'end',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costMicroUsd: 0,
          },
          model: 'stub',
          provider: 'stub',
          latencyMs: 0,
        }),
      },
    });
    const ok = 'Oi! Sua meta *Viagem* atrasou: faltam R$ 1.200,00 e o ideal seria R$ 300,00/mês. Ajusto?';
    expect(await phrase(withReply(ok), actor, { message: msg, priority: 70 })).toEqual({
      text: ok,
      byLLM: true,
    });
    const wrong = 'Sua meta atrasou: faltam R$ 1.500,00. Ajusto?';
    expect((await phrase(withReply(wrong), actor, { message: msg, priority: 70 })).byLLM).toBe(false);
    const reco = 'Faltam R$ 1.200,00; compre PETR4 para chegar lá com R$ 300,00/mês.';
    expect((await phrase(withReply(reco), actor, { message: msg, priority: 70 })).text).toBe(msg);
    // prioridade baixa nem chama o modelo
    expect((await phrase(withReply(ok), actor, { message: msg, priority: 30 })).byLLM).toBe(false);
  });

  it('no chat, "1" responde a pergunta proativa da conversa e "parar" silencia', async () => {
    const a = await newActor(env);
    await env.as(a.userId, (tx) => refreshNudges(tx, a));
    const q = (await env.as(a.userId, (tx) => listNudges(tx, a))).find((n) => n.kind === 'profile_gap')!;
    // simula a entrega: mensagem do assistente com a parte da sugestão
    const { conversationId } = await handleMessage(app, a, { text: 'oi' });
    await env.as(a.userId, async (tx) => {
      await tx
        .insertInto('messages')
        .values({
          workspaceId: a.workspaceId,
          conversationId,
          role: 'assistant',
          content: q.message,
          parts: JSON.stringify([{ type: 'proactive' }, { type: 'nudge', nudgeId: q.id }]),
        })
        .execute();
      await tx
        .updateTable('agentNudges')
        .set({ status: 'delivered', deliveredAt: new Date() })
        .where('id', '=', q.id)
        .execute();
    });
    const r = await handleMessage(app, a, { text: '2', conversationId });
    expect(r.text).toContain('servidor público');
    expect((await env.as(a.userId, (tx) => getProfile(tx, a))).incomeStability).toBe('servidor');
  });
});

describe.skipIf(!hasDb)('Caixa do assistente pela API', () => {
  let env: TestEnv;
  let app: AppContext;
  let server: import('fastify').FastifyInstance;

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(env);
    const { buildServer } = await import('../src/server.js');
    ({ server } = await buildServer(app, env.app.pool));
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  it('atualiza, lista, responde, adia, dispensa; histórico junta a conversa do WhatsApp', async () => {
    const email = `cx-${Date.now()}@example.test`;
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      payload: { name: 'Caixa', email, password: 'senha-forte-123' },
    });
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = (await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json() as {
      user: { id: string };
      workspaces: Array<{ id: string }>;
    };
    env.users.push(me.user.id);
    env.workspaces.push(me.workspaces[0]!.id);
    const h = { cookie, 'content-type': 'application/json' };

    const ref = await server.inject({ method: 'POST', url: '/api/nudges/refresh', headers: h, payload: {} });
    expect(ref.json().created).toBeGreaterThan(0);
    const open = (
      await server.inject({ method: 'GET', url: '/api/nudges', headers: { cookie } })
    ).json() as Array<{
      id: string;
      kind: string;
      options: Array<{ id: string }>;
    }>;
    const q = open.find((n) => n.kind === 'profile_gap')!;
    const ans = await server.inject({
      method: 'POST',
      url: `/api/nudges/${q.id}/answer`,
      headers: h,
      payload: { optionId: 'servidor' },
    });
    expect(ans.json()).toMatchObject({ reply: expect.stringContaining('servidor'), draft: null });
    const again = await server.inject({
      method: 'POST',
      url: `/api/nudges/${q.id}/answer`,
      headers: h,
      payload: { optionId: 'clt' },
    });
    expect(again.statusCode).toBe(409);

    await server.inject({ method: 'POST', url: '/api/nudges/refresh', headers: h, payload: {} });
    const next = (
      (await server.inject({ method: 'GET', url: '/api/nudges', headers: { cookie } })).json() as Array<{
        id: string;
        kind: string;
      }>
    ).find((n) => n.kind === 'profile_gap')!;
    const sn = await server.inject({
      method: 'POST',
      url: `/api/nudges/${next.id}/snooze`,
      headers: h,
      payload: { days: 3 },
    });
    expect(sn.json()).toEqual({ ok: true });
    const hist = (
      await server.inject({ method: 'GET', url: '/api/nudges?scope=history', headers: { cookie } })
    ).json();
    expect(hist.map((n: { status: string }) => n.status).sort()).toEqual(['answered', 'snoozed']);

    const mute = await server.inject({
      method: 'POST',
      url: '/api/nudges/mute',
      headers: h,
      payload: { kind: 'cat:meta', muted: true },
    });
    expect(mute.json()).toEqual({ ok: true });
    expect(
      (await server.inject({ method: 'GET', url: '/api/nudges/mutes', headers: { cookie } })).json(),
    ).toEqual(['cat:meta']);

    // mensagem proativa no WhatsApp aparece no histórico unificado da web
    const ws = me.workspaces[0]!.id;
    await env.as(me.user.id, async (tx) => {
      const c = await tx
        .insertInto('conversations')
        .values({ workspaceId: ws, userId: me.user.id, channel: 'whatsapp' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('messages')
        .values({
          workspaceId: ws,
          conversationId: c.id,
          role: 'assistant',
          content: 'Sua conta de luz vence amanhã.',
          parts: JSON.stringify([{ type: 'proactive' }]),
        })
        .execute();
    });
    const only = (
      await server.inject({ method: 'GET', url: '/api/chat/history', headers: { cookie } })
    ).json();
    expect(only.messages).toHaveLength(0);
    const all = (
      await server.inject({ method: 'GET', url: '/api/chat/history?scope=all', headers: { cookie } })
    ).json();
    expect(all.messages).toEqual([
      expect.objectContaining({
        content: 'Sua conta de luz vence amanhã.',
        channel: 'whatsapp',
        proactive: true,
      }),
    ]);
  });
});
