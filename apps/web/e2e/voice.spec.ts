import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { apiSignUp, clientHeaders, seedWorkspace } from './helpers';

test.use({ extraHTTPHeaders: clientHeaders() });

const shot = (name: string) => fileURLToPath(new URL(`./__screenshots__/${name}.png`, import.meta.url));

/**
 * Simula o lado da OpenAI: RTCPeerConnection falso (o data channel é controlado pelo teste),
 * microfone sintético e a troca de SDP. Ferramentas, prévias e histórico passam pela API real.
 */
async function mockRealtime(page: Page, ws: string, provider: 'realtime' | 'live' = 'realtime') {
  await page.addInitScript(() => {
    const w = window as any;
    w.__voiceSent = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const dst = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.connect(dst);
      osc.start();
      return dst.stream;
    };
    class FakeDC {
      readyState = 'open';
      onmessage: ((e: { data: string }) => void) | null = null;
      send(d: string) {
        w.__voiceSent.push(JSON.parse(d));
      }
      close() {
        this.readyState = 'closed';
      }
    }
    class FakePC {
      connectionState = 'new';
      iceGatheringState = 'complete';
      localDescription: { type: string; sdp: string } | null = null;
      addEventListener() {}
      removeEventListener() {}
      ontrack = null;
      onconnectionstatechange = null;
      senders: Array<{ track: MediaStreamTrack }> = [];
      createDataChannel() {
        return (w.__voiceDC = new FakeDC());
      }
      addTrack(track: MediaStreamTrack) {
        this.senders.push({ track });
      }
      getSenders() {
        return this.senders;
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\n' };
      }
      async setLocalDescription(d: { type: string; sdp: string }) {
        this.localDescription = d;
      }
      async setRemoteDescription() {
        this.connectionState = 'connected';
      }
      close() {
        this.connectionState = 'closed';
      }
    }
    w.RTCPeerConnection = FakePC;
    w.__voiceEmit = (ev: unknown) => w.__voiceDC.onmessage({ data: JSON.stringify(ev) });
  });
  await page.route('**/api/me', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({
      response: res,
      json: { ...json, features: { ...json.features, voice: true, voiceProvider: provider } },
    });
  });
  const conv = (await (
    await page.request.post('/api/chat/new', { headers: { 'x-workspace-id': ws }, data: {} })
  ).json()) as { id: string };
  const sessionBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/voice/session', (route) => {
    sessionBodies.push(route.request().postDataJSON());
    const base = { conversationId: conv.id, maxSeconds: 600, userFirstName: 'Vera' };
    if (provider === 'live')
      return route.fulfill({
        json: { ...base, provider: 'live', model: 'gpt-live-1', sessionId: 'live_1', answerSdp: 'v=0\r\n' },
      });
    return route.fulfill({
      json: {
        provider: 'realtime',
        clientSecret: 'ek_fake',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        model: 'gpt-realtime',
        callsUrl: 'http://localhost:5173/__fake_realtime/calls',
        conversationId: conv.id,
        maxSeconds: 600,
        userFirstName: 'Vera',
      },
    });
  });
  await page.route('**/__fake_realtime/calls', (route) =>
    route.fulfill({ status: 201, contentType: 'application/sdp', body: 'v=0\r\n' }),
  );
  return { sessionBodies };
}

const emit = (page: Page, ev: Record<string, unknown>) =>
  page.evaluate((e) => (window as any).__voiceEmit(e), ev);
const sent = (page: Page) => page.evaluate(() => (window as any).__voiceSent as Array<Record<string, any>>);

test.describe('conversa por voz', () => {
  test('orbe, transcrições no chat, ferramenta com prévia e confirmação', async ({ page }) => {
    const { workspaceId } = await apiSignUp(page.request, 'Vera Voz');
    await seedWorkspace(page.request, workspaceId);
    await mockRealtime(page, workspaceId);
    await page.goto('/');

    const chat = page.getByTestId('chat-panel');
    await chat.getByTestId('voice-mode-button').first().click();
    const stage = chat.getByTestId('voice-stage');
    const orb = stage.getByTestId('voice-orb');
    await expect(orb).toHaveAttribute('data-state', 'connecting');
    await expect(chat.getByLabel('Mensagem para o assistente')).toBeHidden();

    // conexão de pé → cumprimento
    await emit(page, { type: 'session.created', session: {} });
    await expect(orb).toHaveAttribute('data-state', 'listening');
    await expect
      .poll(async () => {
        const s = await sent(page);
        const greet = s.findIndex((e) => e.item?.role === 'system' && /cumprimente Vera/.test(e.item.content[0].text));
        // a resposta não pode trazer `instructions` próprias (substituiriam o contexto da sessão)
        return greet >= 0 && s.slice(greet + 1).some((e) => e.type === 'response.create' && !e.response);
      })
      .toBe(true);

    await emit(page, { type: 'response.created', response: { id: 'r0' } });
    await emit(page, { type: 'output_audio_buffer.started' });
    await expect(orb).toHaveAttribute('data-state', 'speaking');
    await emit(page, { type: 'response.output_audio_transcript.delta', response_id: 'r0', delta: 'Oi, Vera! ' });
    await expect(chat.getByText('Oi, Vera!')).toBeVisible();
    await emit(page, {
      type: 'response.output_audio_transcript.done',
      response_id: 'r0',
      transcript: 'Oi, Vera! Como posso ajudar?',
    });
    await emit(page, { type: 'output_audio_buffer.stopped' });
    await emit(page, { type: 'response.done', response: { id: 'r0', status: 'completed' } });
    await expect(orb).toHaveAttribute('data-state', 'listening');

    // fala do usuário aparece ao vivo
    await emit(page, { type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    await emit(page, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'paguei 230 ' });
    await emit(page, { type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
    await expect(orb).toHaveAttribute('data-state', 'thinking');
    await emit(page, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1',
      transcript: 'paguei 230 de luz no BB hoje',
    });
    const userBubble = chat.locator('li[data-role="user"][data-voice="true"]').last();
    await expect(userBubble).toContainText('paguei 230 de luz no BB hoje');

    // o modelo chama a ferramenta → prévia na tela e saída devolvida ao modelo
    await emit(page, { type: 'response.created', response: { id: 'r1' } });
    await emit(page, {
      type: 'response.function_call_arguments.done',
      response_id: 'r1',
      call_id: 'c1',
      name: 'draft_transactions',
      arguments: JSON.stringify({
        items: [{ description: 'Conta de luz', amount: '230', direction: 'out', account: 'BB' }],
      }),
    });
    await emit(page, { type: 'response.done', response: { id: 'r1', status: 'completed' } });
    const draft = chat.getByTestId('draft-card').last();
    await expect(draft).toHaveAttribute('data-status', 'pending');
    await expect(draft).toContainText('230');
    await expect
      .poll(async () => {
        const s = await sent(page);
        const i = s.findIndex((e) => e.item?.type === 'function_call_output' && e.item.call_id === 'c1');
        return i >= 0 && s.slice(i + 1).some((e) => e.type === 'response.create');
      })
      .toBe(true);

    await emit(page, { type: 'response.created', response: { id: 'r2' } });
    await emit(page, {
      type: 'response.output_audio_transcript.done',
      response_id: 'r2',
      transcript: 'Preparei a conta de luz de duzentos e trinta reais no BB. Posso gravar?',
    });
    await emit(page, { type: 'response.done', response: { id: 'r2', status: 'completed' } });
    await page.screenshot({ path: shot('1280-light-voice') });

    // confirmação pelo toque também avisa o modelo de voz
    await draft.getByRole('button', { name: 'Confirmar' }).click();
    await expect(draft).toHaveAttribute('data-status', 'confirmed');
    await expect
      .poll(async () =>
        (await sent(page)).some((e) => e.item?.role === 'system' && /confirmou na tela/.test(e.item.content[0].text)),
      )
      .toBe(true);

    // minimizar e encerrar
    await stage.getByRole('button', { name: 'Minimizar' }).click();
    await expect(stage).toHaveAttribute('data-minimized', 'true');
    await stage.getByRole('button', { name: 'Encerrar conversa por voz' }).click();
    await expect(stage).toBeHidden();
    await expect(chat.getByTestId('voice-divider')).toContainText('Conversa por voz');
    await expect(chat.getByLabel('Mensagem para o assistente')).toBeVisible();

    // as falas ficaram no histórico
    await page.reload();
    await expect(chat.getByText('paguei 230 de luz no BB hoje')).toBeVisible();
    await expect(chat.getByText('Posso gravar?')).toBeVisible();
  });

  test('palco de voz no celular', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { workspaceId } = await apiSignUp(page.request, 'Marta Móvel');
    await mockRealtime(page, workspaceId);
    await page.goto('/chat');
    await page.getByTestId('voice-mode-button').first().click();
    await emit(page, { type: 'session.created', session: {} });
    await expect(page.getByTestId('voice-orb')).toHaveAttribute('data-state', 'listening');
    await emit(page, { type: 'response.created', response: { id: 'r0' } });
    await emit(page, { type: 'output_audio_buffer.started' });
    await emit(page, {
      type: 'response.output_audio_transcript.done',
      response_id: 'r0',
      transcript: 'Oi, Marta! Como posso ajudar?',
    });
    await expect(page.getByText('Oi, Marta! Como posso ajudar?')).toBeVisible();
    await expect(page.getByTestId('voice-status')).toHaveText('Falando…');
    await page.waitForTimeout(500); // fim da animação de entrada do palco
    await page.screenshot({ path: shot('390-light-voice') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: shot('390-dark-voice') });
    await page.getByRole('button', { name: 'Encerrar conversa por voz' }).click();
    await expect(page.getByTestId('voice-stage')).toBeHidden();
  });

  test('GPT-Live: transcrições ao vivo, delegação ao orquestrador e fechamento com uso', async ({ page }) => {
    const { workspaceId } = await apiSignUp(page.request, 'Vera Live');
    const { sessionBodies } = await mockRealtime(page, workspaceId, 'live');
    // o orquestrador (Claude) é simulado: responde como o /api/chat em SSE
    const chatBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/chat', (route) => {
      chatBodies.push(route.request().postDataJSON());
      const events = [
        { type: 'message_start', messageId: 'm1' },
        { type: 'tool', name: 'query_transactions', status: 'start' },
        { type: 'tool', name: 'query_transactions', status: 'end' },
        { type: 'text_delta', text: 'Você gastou R$ 230,00 com energia ' },
        { type: 'text_delta', text: 'em outubro.' },
        { type: 'message_end', messageId: 'm1' },
        { type: 'done', conversationId: 'c', messageId: 'm1' },
      ];
      return route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const ends: Array<Record<string, unknown>> = [];
    await page.route('**/api/voice/end', (route) => {
      ends.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');

    const chat = page.getByTestId('chat-panel');
    await chat.getByTestId('voice-mode-button').first().click();
    const stage = chat.getByTestId('voice-stage');
    const orb = stage.getByTestId('voice-orb');
    // a oferta SDP vai para o nosso servidor (que cria a sessão GPT-Live)
    await expect.poll(() => sessionBodies.length).toBe(1);
    expect(sessionBodies[0]!.sdp).toContain('v=0');

    await emit(page, { type: 'session.started', session: { id: 'live_1' } });
    await expect(orb).toHaveAttribute('data-state', 'listening');

    await emit(page, { type: 'session.output_transcript.delta', delta: 'Oi, Vera! ', start_ms: 0, end_ms: 400 });
    await emit(page, { type: 'session.output_transcript.delta', delta: 'Como posso ajudar?', start_ms: 400, end_ms: 900 });
    await expect(chat.locator('li[data-role="assistant"][data-voice="true"]').last()).toContainText(
      'Oi, Vera! Como posso ajudar?',
    );
    await emit(page, { type: 'session.input_transcript.delta', delta: 'quanto gastei ', start_ms: 1000, end_ms: 1400 });
    await emit(page, { type: 'session.input_transcript.delta', delta: 'com energia?', start_ms: 1400, end_ms: 1800 });
    await expect(chat.locator('li[data-role="user"][data-voice="true"]').last()).toContainText(
      'quanto gastei com energia?',
    );

    // delegação: a fala do usuário vai ao orquestrador e a resposta volta como commentary
    await emit(page, { type: 'session.delegation.created', offset_ms: 1900, delegation: { id: 'd1', type: 'delegation', target: 'client' } });
    await expect.poll(() => chatBodies.length).toBe(1);
    expect(chatBodies[0]).toMatchObject({ text: 'quanto gastei com energia?', voice: true });
    await expect
      .poll(async () =>
        (await sent(page)).find((e) => e.type === 'session.commentary.append' && e.delegation_id === 'd1'),
      )
      .toMatchObject({ content: 'Você gastou R$ 230,00 com energia em outubro.' });

    // mudo usa o comando do Live
    await stage.getByRole('button', { name: 'Silenciar microfone' }).click();
    await expect.poll(async () => (await sent(page)).some((e) => e.type === 'session.input_audio.mute')).toBe(true);

    // encerrar: session.close → espera session.closed (uso final) antes de soltar a conexão
    await stage.getByRole('button', { name: 'Encerrar conversa por voz' }).click();
    await expect(stage).toBeHidden();
    await expect.poll(async () => (await sent(page)).some((e) => e.type === 'session.close')).toBe(true);
    await emit(page, { type: 'session.closed', reason: 'close_requested', usage: { seconds: 42 } });
    await expect(chat.getByTestId('voice-divider')).toContainText('42 s');
    await expect.poll(() => ends.at(-1)).toEqual({ seconds: 42 });
  });
});
