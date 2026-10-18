import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessageDTO, VoiceSessionDTO } from '@sf/shared';
import { buildServer } from '../src/server.js';
import type { Actor, AppContext } from '../src/context.js';
import { createVoiceSession, endVoiceSession, realtimeKey, runVoiceTool } from '../src/voice/realtime.js';
import { handleMessage } from '../src/agent/orchestrator.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import { insertAccount, type TestEnv } from '../../../db/tests/helpers.js';

const realFetch = globalThis.fetch;

/** Simula o endpoint de segredo efêmero da OpenAI e guarda o corpo enviado. */
function mockOpenAI(status = 200) {
  const calls: Array<{ url: string; body: any; auth: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes('/realtime/client_secrets') && !u.includes('/live/sessions')) return realFetch(url, init);
    calls.push({
      url: u,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get('authorization'),
    });
    const ok = u.includes('/live/sessions')
      ? { session: { id: 'live_123' }, transport: { type: 'webrtc', sdp: 'v=0 resposta' } }
      : { value: 'ek_teste', expires_at: 1_900_000_000 };
    return new Response(status < 300 ? JSON.stringify(ok) : '{"error":{}}', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe.skipIf(!hasDb)('Conversa por voz (OpenAI Realtime)', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;

  beforeAll(async () => {
    env = setupEnv();
    const base = makeApp(env);
    app = { ...base, config: {
        ...base.config,
        REALTIME_API_KEY: 'sk-teste',
        REALTIME_URL: 'https://api.openai.com/v1',
        REALTIME_MODEL: 'gpt-realtime',
        REALTIME_MAX_MINUTES: 10,
        VOICE_PROVIDER: 'realtime' as const,
        LIVE_MODEL: 'gpt-live-1',
      },
    };
    actor = await newActor(env);
    await env.as(actor.userId, (tx) =>
      insertAccount(tx, actor.workspaceId, { name: 'BB', openingBalanceCents: 500_000, openingDate: '2026-01-01' }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => env?.cleanup());

  it('chave: própria, reaproveitada da transcrição OpenAI ou desligada', () => {
    const c = app.config;
    expect(realtimeKey({ ...c, REALTIME_API_KEY: 'a' })).toBe('a');
    expect(realtimeKey({ ...c, REALTIME_API_KEY: undefined, TRANSCRIBE_API_KEY: 'b', TRANSCRIBE_URL: undefined })).toBe(
      'b',
    );
    expect(
      realtimeKey({
        ...c,
        REALTIME_API_KEY: undefined,
        TRANSCRIBE_API_KEY: 'b',
        TRANSCRIBE_URL: 'https://api.groq.com/openai/v1',
      }),
    ).toBeNull();
  });

  it('cria sessão com segredo efêmero, contexto e ferramentas (sem as de anexo)', async () => {
    const calls = mockOpenAI();
    const s = await createVoiceSession(app, actor, {});
    expect(s).toMatchObject({
      clientSecret: 'ek_teste',
      model: 'gpt-realtime',
      maxSeconds: 600,
      userFirstName: 'Leandro',
    });
    expect(s).toMatchObject({ provider: 'realtime', callsUrl: 'https://api.openai.com/v1/realtime/calls' });
    expect(calls[0]!.auth).toBe('Bearer sk-teste');
    const session = calls[0]!.body.session;
    expect(session.instructions).toContain('Conversa por voz');
    expect(session.instructions).toContain('BB');
    expect(session.instructions).toContain('Usuário: Leandro');
    const names = session.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['draft_transactions', 'confirm_drafts', 'get_projection']));
    expect(names).not.toContain('import_attachment');
    expect(session.audio.input.transcription.language).toBe('pt');
  });

  it('leitor recebe só ferramentas de consulta', async () => {
    const calls = mockOpenAI();
    await createVoiceSession(app, { ...actor, role: 'viewer' }, {});
    const names: string[] = calls[0]!.body.session.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_projection');
    expect(names.some((n) => n.startsWith('draft_') || n === 'confirm_drafts')).toBe(false);
  });

  it('falha do provedor vira erro amigável', async () => {
    mockOpenAI(401);
    await expect(createVoiceSession(app, actor, {})).rejects.toMatchObject({ status: 502, code: 'voice_failed' });
  });

  it('ferramenta cria prévia e a confirmação falada grava', async () => {
    mockOpenAI();
    const { conversationId } = await createVoiceSession(app, actor, {});
    const r = await runVoiceTool(app, actor, {
      conversationId,
      name: 'draft_transactions',
      arguments: JSON.stringify({
        items: [{ description: 'Conta de luz', amount: '230', direction: 'out', account: 'BB' }],
      }),
    });
    expect(r.isError).toBe(false);
    expect(r.drafts).toHaveLength(1);
    expect(JSON.parse(r.output).draft_id).toBe(r.drafts[0]!.id);

    const c = await runVoiceTool(app, actor, {
      conversationId,
      name: 'confirm_drafts',
      arguments: JSON.stringify({ draft_ids: [r.drafts[0]!.id] }),
    });
    expect(c.isError).toBe(false);
    expect(c.confirmed).toHaveLength(1);
    const txs = await env.as(actor.userId, (tx) =>
      tx.selectFrom('transactions').select('amountCents').where('workspaceId', '=', actor.workspaceId).execute(),
    );
    expect(txs.map((t) => Number(t.amountCents))).toContain(23_000);

    // já decidida: não grava de novo
    const again = await runVoiceTool(app, actor, {
      conversationId,
      name: 'confirm_drafts',
      arguments: JSON.stringify({ draft_ids: [r.drafts[0]!.id] }),
    });
    expect(again.isError).toBe(true);
  });

  it('não confirma prévia de outra conversa nem usa conversa de outro usuário', async () => {
    mockOpenAI();
    const a = await createVoiceSession(app, actor, {});
    const draft = await runVoiceTool(app, actor, {
      conversationId: a.conversationId,
      name: 'draft_transactions',
      arguments: JSON.stringify({ items: [{ description: 'Padaria', amount: '12', direction: 'out', account: 'BB' }] }),
    });
    const other = await env.as(actor.userId, (tx) =>
      tx
        .insertInto('conversations')
        .values({ workspaceId: actor.workspaceId, userId: actor.userId, channel: 'web' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const r = await runVoiceTool(app, actor, {
      conversationId: other.id,
      name: 'confirm_drafts',
      arguments: JSON.stringify({ draft_ids: [draft.drafts[0]!.id] }),
    });
    expect(r.isError).toBe(true);
    expect(r.confirmed).toHaveLength(0);

    const intruder = await newActor(env);
    await expect(
      runVoiceTool(app, intruder, { conversationId: a.conversationId, name: 'list_accounts', arguments: '{}' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('argumentos inválidos voltam como erro para o modelo', async () => {
    mockOpenAI();
    const { conversationId } = await createVoiceSession(app, actor, {});
    const bad = await runVoiceTool(app, actor, { conversationId, name: 'draft_transactions', arguments: '{oops' });
    expect(bad.isError).toBe(true);
    const anexo = await runVoiceTool(app, actor, { conversationId, name: 'import_attachment', arguments: '{}' });
    expect(anexo.isError).toBe(true);
  });

  it('GPT-Live: servidor cria a sessão com a oferta SDP e delega ao orquestrador', async () => {
    const calls = mockOpenAI(201);
    const live = { ...app, config: { ...app.config, VOICE_PROVIDER: 'live' as const, LIVE_VOICE: undefined } };
    await expect(createVoiceSession(live, actor, {})).rejects.toMatchObject({ code: 'voice_sdp' });
    const s = await createVoiceSession(live, actor, { sdp: 'v=0 oferta' });
    expect(s).toMatchObject({ provider: 'live', sessionId: 'live_123', answerSdp: 'v=0 resposta', model: 'gpt-live-1' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/live/sessions');
    expect(calls[0]!.auth).toBe('Bearer sk-teste');
    const body = calls[0]!.body;
    expect(body.transport).toEqual({ type: 'webrtc', sdp: 'v=0 oferta' });
    expect(body.session).toMatchObject({ model: 'gpt-live-1', delegation: { type: 'client' } });
    expect(body.session.audio).toBeUndefined(); // voz padrão do GPT-Live
    expect(body.session.tools).toBeUndefined(); // a camada de voz não tem ferramentas
    expect(body.session.instructions).toContain('DELEGUE');
    expect(body.session.instructions).toContain('cumprimente Leandro');

    mockOpenAI(400);
    await expect(createVoiceSession(live, actor, { sdp: 'v=0' })).rejects.toMatchObject({ code: 'voice_failed' });
  });

  it('GPT-Live: pedido delegado passa pelo orquestrador marcado como voz e o "sim" confirma', async () => {
    const r = await handleMessage(app, actor, { text: 'paguei 45 de padaria no BB hoje', voice: true });
    expect(r.drafts).toHaveLength(1);
    const ok = await handleMessage(app, actor, { conversationId: r.conversationId, text: 'sim', voice: true });
    expect(ok.text).toMatch(/registrado/i);
    const rows = await env.as(actor.userId, (tx) =>
      tx
        .selectFrom('messages')
        .select(['role', 'parts'])
        .where('conversationId', '=', r.conversationId)
        .orderBy('createdAt')
        .execute(),
    );
    expect(rows).toHaveLength(4);
    for (const m of rows) expect(m.parts).toEqual(expect.arrayContaining([{ type: 'voice' }]));
  });

  it('limite diário de minutos por plano', async () => {
    mockOpenAI();
    const a = await newActor(env);
    await endVoiceSession(app, a, 600);
    await endVoiceSession(app, a, 600); // 20 min = limite do plano free
    await expect(createVoiceSession(app, a, {})).rejects.toMatchObject({ status: 429, code: 'plan_limit' });
  });
});

describe.skipIf(!hasDb)('Conversa por voz: rotas HTTP', () => {
  let env: TestEnv;
  let server: FastifyInstance;
  const origin = 'http://localhost:5173';

  beforeAll(async () => {
    env = setupEnv();
    const base = makeApp(env);
    ({ server } = await buildServer(
      {
        ...base,
        config: { ...base.config, REALTIME_API_KEY: 'sk-teste', REALTIME_MODEL: 'gpt-realtime', VOICE_PROVIDER: 'realtime' },
      },
      env.app.pool,
    ));
    await server.ready();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await server?.close();
    await env?.cleanup();
  });

  it('sessão, transcrição no histórico e registro de uso', async () => {
    const email = `voz-${Date.now()}@example.test`;
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin, 'content-type': 'application/json' },
      payload: { name: 'Vera', email, password: 'senha-forte-123' },
    });
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = (await server.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    env.users.push(me.user.id);
    env.workspaces.push(...me.workspaces.map((w: { id: string }) => w.id));
    expect(me.features.voice).toBe(true);
    const headers = { cookie, 'x-workspace-id': me.workspaces[0].id };

    mockOpenAI();
    const s = (await server.inject({ method: 'POST', url: '/api/voice/session', headers, payload: {} })).json<
      VoiceSessionDTO
    >();
    expect(s).toMatchObject({ provider: 'realtime', clientSecret: 'ek_teste' });

    for (const [role, text] of [
      ['user', 'quanto tenho de saldo?'],
      ['assistant', 'Você tem cinco mil reais na conta.'],
    ] as const) {
      const t = await server.inject({
        method: 'POST',
        url: '/api/voice/transcript',
        headers,
        payload: { conversationId: s.conversationId, role, text },
      });
      expect(t.statusCode).toBe(200);
    }
    const blocked = await server.inject({
      method: 'POST',
      url: '/api/voice/transcript',
      headers,
      payload: { conversationId: s.conversationId, role: 'assistant', text: 'Recomendo que você compre PETR4 agora.' },
    });
    expect(blocked.json().replaced).toBeTruthy();

    const hist = (await server.inject({ method: 'GET', url: '/api/chat/history', headers })).json<{
      conversationId: string;
      messages: ChatMessageDTO[];
    }>();
    expect(hist.conversationId).toBe(s.conversationId);
    expect(hist.messages.filter((m) => m.voice).map((m) => m.content)).toEqual([
      'quanto tenho de saldo?',
      'Você tem cinco mil reais na conta.',
      expect.not.stringContaining('PETR4'),
    ]);

    const end = await server.inject({ method: 'POST', url: '/api/voice/end', headers, payload: { seconds: 95 } });
    expect(end.statusCode).toBe(200);
  });
});
