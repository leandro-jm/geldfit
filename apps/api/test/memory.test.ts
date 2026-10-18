import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeProvider, type ExtractRequest } from '@sf/llm';
import type { MemoryDTO } from '@sf/shared';
import type { z } from 'zod';
import { handleMessage, loadWorkspaceContext } from '../src/agent/orchestrator.js';
import {
  applyMemoryOps,
  extractConversationMemories,
  listMemories,
  selectForPrompt,
  type MemoryOp,
} from '../src/agent/memory.js';
import type { Actor, AppContext } from '../src/context.js';
import { confirmDraft, createDraft } from '../src/domain/drafts.js';
import { getProfile } from '../src/domain/profile.js';
import { buildServer } from '../src/server.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

const op = (o: Partial<MemoryOp>): MemoryOp => ({
  op: 'create',
  key: null,
  category: 'objetivo',
  content: 'Quer trocar de carro em 2027',
  sensitive: false,
  scope: 'personal',
  confidence: 0.9,
  importance: 4,
  expires_at: null,
  evidence_quote: 'quero trocar de carro em 2027',
  ...o,
});

describe('selectForPrompt', () => {
  const m = (o: Partial<MemoryDTO>): MemoryDTO => ({
    id: crypto.randomUUID(),
    scope: 'personal',
    category: 'contexto',
    key: 'contexto.x',
    content: 'x',
    sensitive: false,
    status: 'active',
    source: 'chat',
    importance: 3,
    pinned: false,
    expiresAt: null,
    mine: true,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...o,
  });

  it('ordena por fixada, importância e categoria; ignora pendentes; respeita o orçamento', () => {
    const lines = selectForPrompt([
      m({ content: 'Contexto qualquer', importance: 3 }),
      m({ content: 'Quer viajar para o Japão', category: 'objetivo', importance: 5 }),
      m({ content: 'Prefere respostas curtas', category: 'preferencia', pinned: true }),
      m({ content: 'Dado sensível', status: 'pending' }),
      m({ content: 'Cancelar a academia', category: 'compromisso', importance: 5, expiresAt: '2026-12-01' }),
    ]);
    expect(lines[0]).toContain('Prefere respostas curtas');
    expect(lines[1]).toContain('Japão');
    expect(lines[2]).toContain('prazo 01/12/2026');
    expect(lines.join('\n')).not.toContain('sensível');
    const tight = selectForPrompt([m({ content: 'a'.repeat(100) }), m({ content: 'b'.repeat(100) })], 150);
    expect(tight).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)('Memória do agente', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;
  let extractCalls = 0;
  let nextOps: MemoryOp[] = [];

  beforeAll(async () => {
    env = setupEnv();
    app = makeApp(
      env,
      new FakeProvider((req: ExtractRequest<z.ZodType>) => {
        extractCalls++;
        expect(req.purpose).toBe('bg:memory');
        return { ops: nextOps };
      }),
    );
    actor = await newActor(env);
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  it('valida as operações: citação da fala do usuário, confiança, dedupe, sensível pendente e máscara', async () => {
    const userTexts = ['Quero trocar de carro em 2027, e meu CPF é 529.982.247-25', 'tenho diabetes'];
    const r = await env.as(actor.userId, (tx) =>
      applyMemoryOps(
        tx,
        actor,
        [
          op({}),
          op({ content: 'Quer comprar ações da PETR4', evidence_quote: 'compre PETR4 agora' }), // citação inventada
          op({ content: 'Gosta de viajar', confidence: 0.4, evidence_quote: 'trocar de carro' }), // baixa confiança
          op({
            category: 'perfil',
            content: 'Tem diabetes',
            sensitive: true,
            scope: 'household',
            evidence_quote: 'tenho diabetes',
          }),
          op({
            category: 'contexto',
            content: 'CPF 529.982.247-25 informado',
            evidence_quote: 'meu CPF é 529.982.247-25',
          }),
        ],
        userTexts,
        null,
      ),
    );
    expect(r).toMatchObject({ created: 3, rejected: 2, pending: 1 });
    const all = await env.as(actor.userId, (tx) => listMemories(tx, actor));
    expect(all.find((x) => x.content === 'Tem diabetes')).toMatchObject({
      status: 'pending',
      scope: 'personal',
    });
    expect(all.some((x) => x.content.includes('529.982'))).toBe(false);

    // mesmo assunto (mesma chave) atualiza em vez de duplicar
    const car = all.find((x) => x.content.startsWith('Quer trocar de carro'))!;
    const r2 = await env.as(actor.userId, (tx) =>
      applyMemoryOps(
        tx,
        actor,
        [
          op({
            op: 'update',
            key: car.key,
            content: 'Quer trocar de carro em 2028',
            evidence_quote: 'fica pra 2028',
          }),
        ],
        ['o carro fica pra 2028'],
        null,
      ),
    );
    expect(r2.updated).toBe(1);
    const after = await env.as(actor.userId, (tx) => listMemories(tx, actor));
    expect(after.filter((x) => x.key === car.key)).toHaveLength(1);
    expect(after.find((x) => x.key === car.key)!.content).toBe('Quer trocar de carro em 2028');
  });

  it('lembra, consulta e esquece pelo chat; a memória entra no contexto do agente', async () => {
    const a = await newActor(env);
    const r1 = await handleMessage(app, a, { text: 'lembra que meu filho nasce em março de 2027' });
    expect(r1.text).toContain('Anotado');
    const ctx = await loadWorkspaceContext(app, a, r1.conversationId, 4);
    expect(ctx.prompt.memories.join('\n')).toMatch(/\[familia\] Meu filho nasce em março de 2027/i);

    const r2 = await handleMessage(app, a, { text: 'o que você sabe sobre mim?' });
    expect(r2.text).toContain('filho nasce em março');

    const r3 = await handleMessage(app, a, { text: 'esquece que meu filho nasce em março' });
    expect(r3.text).toContain('esqueci');
    const left = await env.as(a.userId, (tx) => listMemories(tx, a));
    expect(left).toHaveLength(0);
  });

  it('extração em segundo plano: pré-filtro, cursor e orçamento', async () => {
    const a = await newActor(env);
    await handleMessage(app, a, { text: 'sim' });
    const conv = await env.as(a.userId, (tx) =>
      tx.selectFrom('conversations').select('id').where('userId', '=', a.userId).executeTakeFirstOrThrow(),
    );
    // só "sim": não chama o LLM e avança o cursor
    const before = extractCalls;
    const r0 = await extractConversationMemories(app, a, conv.id);
    expect(r0).toMatchObject({ status: 'skipped', reason: 'no_signal', advanced: true });
    expect(extractCalls).toBe(before);

    await handleMessage(app, a, {
      text: 'Eu quero juntar dinheiro para fazer faculdade de medicina em 2028',
    });
    nextOps = [
      op({
        content: 'Quer fazer faculdade de medicina em 2028',
        evidence_quote: 'quero juntar dinheiro para fazer faculdade de medicina em 2028',
      }),
    ];
    // sem orçamento: não chama e mantém o cursor para tentar depois
    const limit = app.config.AGENT_MEMORY_DAILY;
    app.config.AGENT_MEMORY_DAILY = 0;
    const r1 = await extractConversationMemories(app, a, conv.id);
    app.config.AGENT_MEMORY_DAILY = limit;
    expect(r1).toMatchObject({ status: 'skipped', reason: 'daily_calls', advanced: false });
    expect(extractCalls).toBe(before);

    const r2 = await extractConversationMemories(app, a, conv.id);
    expect(r2).toMatchObject({ status: 'done', result: { created: 1 } });
    expect(extractCalls).toBe(before + 1);
    const usage = await env.as(a.userId, (tx) =>
      tx.selectFrom('llmUsage').select('purpose').where('userId', '=', a.userId).execute(),
    );
    expect(usage.map((u) => u.purpose)).toContain('bg:memory');

    // nada novo desde o cursor
    const r3 = await extractConversationMemories(app, a, conv.id);
    expect(r3.status).toBe('skipped');
    expect(extractCalls).toBe(before + 1);
  });

  it('perfil financeiro por prévia: só os campos informados mudam', async () => {
    const a = await newActor(env);
    expect(await env.as(a.userId, (tx) => getProfile(tx, a))).toMatchObject({
      nudgeFrequency: 'normal',
      objectives: [],
    });
    const d = await env.as(a.userId, (tx) =>
      createDraft(
        tx,
        a,
        'financial_profile',
        { dependents: 2, objectives: ['reserva', 'viagem'], incomeStability: 'clt' },
        { title: 'Perfil', summary: '', lines: [], warnings: [] },
      ),
    );
    await env.as(a.userId, (tx) => confirmDraft(tx, a, d.id));
    const d2 = await env.as(a.userId, (tx) =>
      createDraft(
        tx,
        a,
        'financial_profile',
        { uf: 'SP' },
        { title: 'Perfil', summary: '', lines: [], warnings: [] },
      ),
    );
    await env.as(a.userId, (tx) => confirmDraft(tx, a, d2.id));
    expect(await env.as(a.userId, (tx) => getProfile(tx, a))).toMatchObject({
      dependents: 2,
      objectives: ['reserva', 'viagem'],
      incomeStability: 'clt',
      uf: 'SP',
    });
  });
});

describe.skipIf(!hasDb)('Memória pela API', () => {
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

  it('cria, confirma, edita, apaga e exporta a memória; perfil pela tela grava consentimento', async () => {
    const u = await signUp('Mara');
    const h = { cookie: u.cookie, 'content-type': 'application/json' };
    const created = await server.inject({
      method: 'POST',
      url: '/api/memories',
      headers: h,
      payload: { content: 'Quer fazer intercâmbio em 2028', category: 'objetivo' },
    });
    expect(created.statusCode).toBe(200);
    const mem = created.json() as MemoryDTO;
    expect(mem).toMatchObject({ status: 'active', mine: true, source: 'manual' });

    const edited = await server.inject({
      method: 'PATCH',
      url: `/api/memories/${mem.id}`,
      headers: h,
      payload: { content: 'Quer fazer intercâmbio em 2029', pinned: true },
    });
    expect(edited.json()).toMatchObject({ content: 'Quer fazer intercâmbio em 2029', pinned: true });

    const archived = await server.inject({
      method: 'PATCH',
      url: `/api/memories/${mem.id}`,
      headers: h,
      payload: { action: 'archive' },
    });
    expect(archived.json().status).toBe('archived');
    const open = await server.inject({ method: 'GET', url: '/api/memories', headers: { cookie: u.cookie } });
    expect(open.json()).toHaveLength(0);
    const arch = await server.inject({
      method: 'GET',
      url: '/api/memories?status=archived',
      headers: { cookie: u.cookie },
    });
    expect(arch.json()).toHaveLength(1);

    const exp = await server.inject({ method: 'GET', url: '/api/export', headers: { cookie: u.cookie } });
    expect(JSON.parse(exp.body).agentMemories).toHaveLength(1);

    const del = await server.inject({
      method: 'DELETE',
      url: '/api/memories',
      headers: { cookie: u.cookie },
    });
    expect(del.json()).toMatchObject({ ok: true, deleted: 1 });

    const p0 = await server.inject({ method: 'GET', url: '/api/profile', headers: { cookie: u.cookie } });
    expect(p0.json()).toMatchObject({ memoryAuto: true, nudgeFrequency: 'normal' });
    const bad = await server.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: h,
      payload: { riskSelf: 'yolo' },
    });
    expect(bad.statusCode).toBe(400);
    await server.inject({ method: 'PUT', url: '/api/profile', headers: h, payload: { memoryAuto: false } });
    const p1 = await server.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: h,
      payload: { memoryAuto: true, riskSelf: 'moderado', interests: ['selic', 'ir'] },
    });
    expect(p1.json()).toMatchObject({ memoryAuto: true, riskSelf: 'moderado', interests: ['selic', 'ir'] });
    const consents = await env.owner.db
      .selectFrom('consents')
      .select('kind')
      .where('userId', '=', u.userId)
      .execute();
    expect(consents.map((c) => c.kind)).toContain('agent_memory');

    const usage = await server.inject({
      method: 'GET',
      url: '/api/agent/usage',
      headers: { cookie: u.cookie },
    });
    expect(usage.json()).toMatchObject({ proactive: 'full', weekUsd: 0 });
  });

  it('não edita nem apaga memória de outro usuário', async () => {
    const a = await signUp('Nina');
    const b = await signUp('Otto');
    const m = await server.inject({
      method: 'POST',
      url: '/api/memories',
      headers: { cookie: a.cookie, 'content-type': 'application/json' },
      payload: { content: 'Prefere respostas curtas', category: 'preferencia' },
    });
    const id = (m.json() as MemoryDTO).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/memories/${id}`,
      headers: { cookie: b.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
