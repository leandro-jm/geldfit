import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import type { ChatStreamEvent, ChatVisual, VoiceSessionDTO, VoiceToolResponse } from '@sf/shared';
import { api, apiFetch, ApiError, readSSE } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { tempId, useChat, type UiMessage } from './chat-context';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

/** Encerra sozinha depois deste tempo sem ninguém falar. */
const IDLE_SECONDS = 90;
/** GPT-Live: limite de cada `session.*.append` é 500 tokens. */
const LIVE_APPEND_CHARS = 1600;

export function voiceChatSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'RTCPeerConnection' in window &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

// Eventos do servidor Realtime que usamos (o resto é ignorado)
type ServerEvent = { type: string; [k: string]: any };

type EndOpts = { reason?: string; beacon?: boolean };

interface Session {
  provider: 'realtime' | 'live';
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream;
  audio: HTMLAudioElement;
  ctx: AudioContext;
  micAnalyser: AnalyserNode;
  outAnalyser: AnalyserNode;
  conversationId: string;
  userFirstName: string;
  startedAt: number;
  maxSeconds: number;
  lastActivity: number;
  connected: boolean;
  speaking: boolean;
  toolsRunning: number;
  /** item do usuário → mensagem na lista */
  userMsgs: Map<string, string>;
  /** resposta do assistente → mensagem na lista */
  asstMsgs: Map<string, string>;
  /** chamadas de ferramenta em andamento por resposta (a próxima resposta espera todas) */
  calls: Map<string, Array<Promise<void>>>;
  /** prévias e gráficos ainda não gravados no histórico (vão com a próxima fala do assistente) */
  carry: { draftIds: string[]; visuals: ChatVisual[] };
  /** grava as transcrições em ordem */
  persistQueue: Promise<unknown>;
  raf: number;
  timer: ReturnType<typeof setInterval>;
  finished: boolean;
  // --- GPT-Live (transcrições sem turno; agrupamos por quem está falando) ---
  liveUser: string | null;
  liveAsst: string | null;
  /** fala do usuário ainda não delegada ao orquestrador */
  pendingText: string;
  /** delegações rodam uma de cada vez, na ordem */
  delegQueue: Promise<unknown>;
  /** último instante com áudio do assistente (o Live não avisa início/fim da fala) */
  lastOut: number;
  usageSeconds: number | null;
  closing: { opts: EndOpts; timer: ReturnType<typeof setTimeout> } | null;
}

/** Espera o ICE terminar: o GPT-Live recebe a oferta completa (sem trickle). */
function waitForIce(pc: RTCPeerConnection, ms = 10_000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const CLOSE_REASONS: Record<string, string> = {
  expired: 'Tempo máximo da conversa por voz atingido.',
  content: 'A conversa por voz foi encerrada pelo filtro de segurança.',
  connection_lost: 'A conexão de voz caiu.',
  remote_hangup: 'A conversa por voz foi encerrada.',
};

function micErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      return 'Permita o uso do microfone para conversar por voz.';
    if (err.name === 'NotFoundError') return 'Nenhum microfone encontrado.';
    if (err.name === 'NotReadableError') return 'O microfone está em uso por outro aplicativo.';
  }
  return err instanceof Error && err.message ? err.message : 'Não consegui iniciar a conversa por voz.';
}

function rms(an: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  an.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/**
 * Conversa por voz em tempo real (OpenAI Realtime via WebRTC). O áudio vai direto do navegador ao
 * provedor com um segredo efêmero; ferramentas, prévias e histórico passam pela nossa API.
 * Tudo que é falado aparece na lista do chat, em tempo real.
 */
export function useVoiceSession() {
  const chat = useChat();
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const { workspaceId } = useWorkspace();
  const me = useMe();
  const provider = me.data?.features?.voiceProvider ?? 'realtime';
  const [state, setState] = useState<VoiceState>('idle');
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(0);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const levelRef = useRef(0) as MutableRefObject<number>;
  const stateRef = useRef<VoiceState>('idle');
  const sess = useRef<Session | null>(null);
  const attempt = useRef(0);

  const go = useCallback((st: VoiceState) => {
    stateRef.current = st;
    setState(st);
  }, []);

  const send = (S: Session, ev: Record<string, unknown>) => {
    if (S.dc.readyState === 'open') S.dc.send(JSON.stringify(ev));
  };

  const persist = (S: Session, role: 'user' | 'assistant', text: string, msgId?: string) => {
    const carry = role === 'assistant' ? S.carry : { draftIds: [], visuals: [] };
    if (role === 'assistant') S.carry = { draftIds: [], visuals: [] };
    S.persistQueue = S.persistQueue
      .then(() =>
        api<{ id: string; replaced: string | null }>('/api/voice/transcript', {
          method: 'POST',
          body: { conversationId: S.conversationId, role, text, ...carry },
        }),
      )
      .then((r) => {
        if (r.replaced && msgId) chatRef.current.patchMessage(msgId, (m) => ({ ...m, text: r.replaced! }));
      })
      .catch(() => {});
  };

  const newMsg = (role: UiMessage['role'], extra: Partial<UiMessage> = {}): string => {
    const id = tempId(role === 'user' ? 'vu' : 'va');
    chatRef.current.appendMessage({
      id,
      role,
      text: '',
      createdAt: new Date().toISOString(),
      attachments: [],
      drafts: [],
      voice: true,
      streaming: true,
      ...extra,
    });
    return id;
  };
  const userMsg = (S: Session, itemId: string) => {
    let id = S.userMsgs.get(itemId);
    if (!id) S.userMsgs.set(itemId, (id = newMsg('user')));
    return id;
  };
  const asstMsg = (S: Session, responseId: string) => {
    let id = S.asstMsgs.get(responseId);
    if (!id) S.asstMsgs.set(responseId, (id = newMsg('assistant')));
    return id;
  };

  const runToolCall = async (S: Session, ev: ServerEvent) => {
    const c = chatRef.current;
    S.toolsRunning++;
    setActiveTool(ev.name);
    if (!S.speaking) go('thinking');
    const msgId = asstMsg(S, ev.response_id);
    c.patchMessage(msgId, (m) => ({ ...m, tool: ev.name }));
    let output: string;
    try {
      const r = await api<VoiceToolResponse>('/api/voice/tool', {
        method: 'POST',
        body: { conversationId: S.conversationId, name: ev.name, arguments: ev.arguments ?? '{}' },
      });
      output = r.output;
      if (r.drafts.length || r.visuals.length) {
        c.patchMessage(msgId, (m) => ({
          ...m,
          drafts: [...m.drafts.filter((d) => !r.drafts.some((x) => x.id === d.id)), ...r.drafts],
          visuals: [...(m.visuals ?? []).filter((v) => !r.visuals.some((x) => x.type === v.type)), ...r.visuals],
        }));
        S.carry.draftIds.push(...r.drafts.map((d) => d.id));
        S.carry.visuals = [...S.carry.visuals.filter((v) => !r.visuals.some((x) => x.type === v.type)), ...r.visuals];
      }
      for (const k of r.confirmed) c.markDraft(k.draftId, 'confirmed');
      for (const id of r.cancelled) c.markDraft(id, 'cancelled');
      if (r.confirmed.length) {
        const last = r.confirmed.at(-1)!;
        c.patchMessage(msgId, (m) => ({
          ...m,
          notice: { summary: r.confirmed.map((k) => k.summary).join(' '), impact: last.impact },
        }));
        c.invalidate();
      }
    } catch (err) {
      output = JSON.stringify({ error: err instanceof Error ? err.message : 'Falha ao executar a ferramenta.' });
    } finally {
      S.toolsRunning--;
      if (!S.toolsRunning) setActiveTool(null);
      c.patchMessage(msgId, (m) => ({ ...m, tool: null }));
    }
    if (sess.current !== S) return;
    send(S, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output } });
  };

  const handleRealtime = (S: Session, ev: ServerEvent) => {
    const c = chatRef.current;
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
        if (!S.connected) {
          S.connected = true;
          S.startedAt = Date.now();
          S.lastActivity = Date.now();
          go('listening');
          // Cumprimento curto confirma que a conexão está de pé. Vai como item de sistema: `instructions`
          // no response.create substituiria as da sessão (contexto, nome, contas) só nesta resposta.
          send(S, {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: `Inicie a conversa: cumprimente ${S.userFirstName ? `${S.userFirstName} pelo primeiro nome` : 'o usuário'} em uma frase curta e pergunte como pode ajudar com as finanças. Use só os dados do contexto; não invente nomes.`,
                },
              ],
            },
          });
          send(S, { type: 'response.create' });
        }
        break;
      case 'input_audio_buffer.speech_started':
        S.lastActivity = Date.now();
        userMsg(S, ev.item_id);
        go('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        go('thinking');
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = userMsg(S, ev.item_id);
        c.patchMessage(id, (m) => ({ ...m, text: m.text + (ev.delta ?? '') }));
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const id = userMsg(S, ev.item_id);
        const text = String(ev.transcript ?? '').trim();
        if (!text) c.removeMessage(id);
        else {
          c.patchMessage(id, (m) => ({ ...m, text, streaming: false }));
          persist(S, 'user', text);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const id = S.userMsgs.get(ev.item_id);
        if (id) c.patchMessage(id, (m) => ({ ...m, text: m.text || '(não entendi o áudio)', streaming: false }));
        break;
      }
      case 'response.created':
        if (!S.speaking) go('thinking');
        break;
      case 'response.output_audio_transcript.delta': {
        const id = asstMsg(S, ev.response_id);
        c.patchMessage(id, (m) => ({ ...m, text: m.text + (ev.delta ?? '') }));
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = asstMsg(S, ev.response_id);
        const text = String(ev.transcript ?? '').trim();
        c.patchMessage(id, (m) => ({ ...m, text: text || m.text, streaming: false }));
        if (text) persist(S, 'assistant', text, id);
        break;
      }
      case 'output_audio_buffer.started':
        S.speaking = true;
        S.lastActivity = Date.now();
        go('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        S.speaking = false;
        S.lastActivity = Date.now();
        go(S.toolsRunning ? 'thinking' : 'listening');
        break;
      case 'response.function_call_arguments.done': {
        const list = S.calls.get(ev.response_id) ?? [];
        list.push(runToolCall(S, ev));
        S.calls.set(ev.response_id, list);
        break;
      }
      case 'response.done': {
        const r = ev.response ?? {};
        const id = S.asstMsgs.get(r.id);
        if (id) c.patchMessage(id, (m) => ({ ...m, streaming: false }));
        const pending = S.calls.get(r.id);
        if (pending?.length) {
          S.calls.delete(r.id);
          // depois de todas as saídas das ferramentas, o modelo continua a resposta
          void Promise.allSettled(pending).then(() => {
            if (sess.current === S) send(S, { type: 'response.create' });
          });
        } else if (!S.speaking && !S.toolsRunning) go('listening');
        if (r.status === 'failed') console.warn('[voz] resposta falhou', r.status_details);
        break;
      }
      case 'error':
        console.warn('[voz]', ev.error);
        break;
    }
  };


  // ------------------------------------------------------------------------------------------
  // GPT-Live: a voz conversa em full duplex e delega dados/ações ao orquestrador do chat
  // ------------------------------------------------------------------------------------------
  const liveSay = (S: Session, type: 'session.commentary.append' | 'session.thinking.append', delegationId: string | null, content: string) =>
    send(S, { type, event_id: tempId('ev'), delegation_id: delegationId, content: content.slice(0, LIVE_APPEND_CHARS) });

  const closeLiveUser = (S: Session) => {
    if (S.liveUser) chatRef.current.patchMessage(S.liveUser, (m) => ({ ...m, streaming: false }));
    S.liveUser = null;
  };
  const closeLiveAsst = (S: Session) => {
    if (S.liveAsst) chatRef.current.patchMessage(S.liveAsst, (m) => ({ ...m, streaming: false }));
    S.liveAsst = null;
  };

  /** Roda o pedido falado no orquestrador (mesmo /api/chat do chat escrito) e devolve o resultado à voz. */
  const delegate = async (S: Session, delegationId: string) => {
    // a delegação não traz o pedido: usa a fala do usuário desde a última delegação (espera os últimos trechos)
    for (let i = 0; i < 15 && !S.pendingText.trim() && !S.finished; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 250));
    if (S.finished) return;
    const text = S.pendingText.trim();
    S.pendingText = '';
    if (!text) {
      liveSay(S, 'session.commentary.append', delegationId, 'Não entendi o pedido. Peça para o usuário repetir.');
      return;
    }
    const c = chatRef.current;
    closeLiveUser(S);
    closeLiveAsst(S);
    // mensagem de bastidor: mostra a ferramenta em uso, prévias e gráficos (o texto vira fala)
    const msgId = newMsg('assistant');
    S.asstMsgs.set(`deleg-${delegationId}`, msgId);
    S.toolsRunning++;
    if (!S.speaking) go('thinking');
    let answer = '';
    let changed = false;
    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        body: { text, conversationId: S.conversationId, voice: true },
        headers: { accept: 'text/event-stream' },
      });
      await readSSE<ChatStreamEvent | { type: 'done' }>(res, (e) => {
        switch (e.type) {
          case 'text_delta':
            answer += e.text;
            break;
          case 'text_replace':
            answer = e.text;
            break;
          case 'tool':
            setActiveTool(e.status === 'start' ? e.name : null);
            c.patchMessage(msgId, (m) => ({ ...m, tool: e.status === 'start' ? e.name : null }));
            break;
          case 'draft':
            c.patchMessage(msgId, (m) => ({ ...m, drafts: [...m.drafts.filter((d) => d.id !== e.draft.id), e.draft] }));
            break;
          case 'visual':
            c.patchMessage(msgId, (m) => ({
              ...m,
              visuals: [...(m.visuals ?? []).filter((v) => v.type !== e.visual.type), e.visual],
            }));
            break;
          case 'confirmed':
            changed = true;
            c.markDraft(e.draftId, 'confirmed');
            c.patchMessage(msgId, (m) => ({ ...m, notice: { summary: e.summary, impact: e.impact } }));
            break;
          case 'error':
            answer = e.message;
            break;
        }
      });
    } catch (err) {
      answer = `Não consegui consultar agora: ${err instanceof Error ? err.message : 'erro desconhecido'}.`;
    } finally {
      S.toolsRunning--;
      setActiveTool(null);
      c.patchMessage(msgId, (m) => ({ ...m, streaming: false, tool: null }));
      if (changed) c.invalidate();
      if (!S.speaking && !S.toolsRunning && !S.finished) go('listening');
    }
    if (!S.finished) liveSay(S, 'session.commentary.append', delegationId, answer.trim() || 'Pronto.');
  };

  const handleLive = (S: Session, ev: ServerEvent) => {
    const c = chatRef.current;
    switch (ev.type) {
      case 'session.started':
        if (!S.connected) {
          S.connected = true;
          S.startedAt = Date.now();
          S.lastActivity = Date.now();
          go('listening');
        }
        break;
      case 'session.input_transcript.delta': {
        S.lastActivity = Date.now();
        if (!S.liveUser) {
          closeLiveAsst(S);
          S.liveUser = newMsg('user');
        }
        const delta = String(ev.delta ?? '');
        S.pendingText += delta;
        c.patchMessage(S.liveUser, (m) => ({ ...m, text: m.text + delta }));
        break;
      }
      case 'session.output_transcript.delta': {
        S.lastActivity = Date.now();
        if (!S.liveAsst) {
          closeLiveUser(S);
          S.liveAsst = newMsg('assistant');
        }
        const delta = String(ev.delta ?? '');
        c.patchMessage(S.liveAsst, (m) => ({ ...m, text: m.text + delta }));
        break;
      }
      case 'session.delegation.created': {
        const id = String(ev.delegation?.id ?? '');
        if (id) S.delegQueue = S.delegQueue.then(() => delegate(S, id)).catch(() => {});
        break;
      }
      case 'session.usage.updated':
        if (typeof ev.usage?.seconds === 'number') S.usageSeconds = ev.usage.seconds;
        break;
      case 'session.closed':
        if (typeof ev.usage?.seconds === 'number') S.usageSeconds = ev.usage.seconds;
        if (S.closing) {
          clearTimeout(S.closing.timer);
          finish(S, S.closing.opts);
        } else {
          // encerrada pelo servidor (tempo, filtro, conexão)
          if (sess.current === S) sess.current = null;
          finish(S, { reason: CLOSE_REASONS[String(ev.reason)] ?? 'A conversa por voz foi encerrada.' });
        }
        break;
      case 'error':
        console.warn('[voz]', ev.error);
        break;
    }
  };

  /** Libera tudo e registra o uso. Idempotente. */
  function finish(S: Session, opts: EndOpts = {}) {
    if (S.finished) return;
    S.finished = true;
    if (sess.current === S) sess.current = null;
    if (!sess.current) {
      chatRef.current.registerVoiceNotifier(null);
      setActiveTool(null);
      levelRef.current = 0;
    }
    cancelAnimationFrame(S.raf);
    clearInterval(S.timer);
    try {
      S.dc.close();
    } catch {
      /* já fechado */
    }
    S.pc.getSenders().forEach((s) => s.track?.stop());
    S.pc.close();
    S.mic.getTracks().forEach((t) => t.stop());
    S.audio.srcObject = null;
    void S.ctx.close().catch(() => {});
    if (!sess.current) go('idle');
    if (!S.connected) return;
    const seconds = S.usageSeconds ?? Math.round((Date.now() - S.startedAt) / 1000);
    if (opts.beacon && workspaceId) {
      navigator.sendBeacon(
        `/api/voice/end?ws=${encodeURIComponent(workspaceId)}`,
        new Blob([JSON.stringify({ seconds })], { type: 'application/json' }),
      );
      return;
    }
    void api('/api/voice/end', { method: 'POST', body: { seconds } }).catch(() => {});
    if (S.carry.draftIds.length || S.carry.visuals.length) persist(S, 'assistant', 'Prévia preparada na conversa por voz.');
    closeLiveUser(S);
    closeLiveAsst(S);
    const c = chatRef.current;
    for (const id of S.asstMsgs.values()) c.patchMessage(id, (m) => ({ ...m, streaming: false, tool: null }));
    for (const id of S.userMsgs.values()) c.patchMessage(id, (m) => ({ ...m, streaming: false }));
    const min = Math.max(1, Math.round(seconds / 60));
    c.appendMessage({
      id: tempId('vd'),
      role: 'assistant',
      text: `Conversa por voz · ${seconds < 60 ? `${seconds} s` : `${min} min`}`,
      createdAt: new Date().toISOString(),
      attachments: [],
      drafts: [],
      divider: true,
    });
    if (opts.reason) toast.info(opts.reason);
  }

  const end = useCallback(
    (opts: EndOpts = {}) => {
      attempt.current++;
      const S = sess.current;
      sess.current = null;
      chatRef.current.registerVoiceNotifier(null);
      setActiveTool(null);
      levelRef.current = 0;
      if (!S) {
        if (stateRef.current !== 'error') go('idle');
        return;
      }
      // GPT-Live: fecha com session.close e espera o session.closed (uso final) antes de soltar a conexão
      if (S.provider === 'live' && S.connected && !opts.beacon && S.dc.readyState === 'open') {
        go('idle');
        if (S.closing) return;
        send(S, { type: 'session.close' });
        S.closing = { opts, timer: setTimeout(() => finish(S, opts), 2500) };
        return;
      }
      finish(S, opts);
    },
    [go, workspaceId],
  );

  const start = useCallback(async () => {
    if (sess.current || stateRef.current === 'connecting') return;
    const my = ++attempt.current;
    setError(null);
    setMuted(false);
    setElapsed(0);
    go('connecting');
    let mic: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    let ctx: AudioContext | null = null;
    const abandon = () => {
      mic?.getTracks().forEach((t) => t.stop());
      pc?.close();
      void ctx?.close().catch(() => {});
    };
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (my !== attempt.current) return abandon();
      const c = chatRef.current;

      ctx = new AudioContext();
      void ctx.resume().catch(() => {});
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      ctx.createMediaStreamSource(mic).connect(micAnalyser);
      const outAnalyser = ctx.createAnalyser();
      outAnalyser.fftSize = 512;

      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      pc = new RTCPeerConnection();
      const localCtx = ctx;
      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (!stream) return;
        audio.srcObject = stream;
        void audio.play().catch(() => {});
        localCtx.createMediaStreamSource(stream).connect(outAnalyser);
      };
      pc.addTrack(mic.getAudioTracks()[0]!, mic);
      // o canal de eventos (e seus listeners) precisa existir antes da oferta
      const dc = pc.createDataChannel('oai-events');

      const S: Session = {
        provider,
        pc,
        dc,
        mic,
        audio,
        ctx,
        micAnalyser,
        outAnalyser,
        conversationId: '',
        userFirstName: '',
        startedAt: Date.now(),
        maxSeconds: 600,
        lastActivity: Date.now(),
        connected: false,
        speaking: false,
        toolsRunning: 0,
        userMsgs: new Map(),
        asstMsgs: new Map(),
        calls: new Map(),
        carry: { draftIds: [], visuals: [] },
        persistQueue: Promise.resolve(),
        raf: 0,
        timer: 0 as unknown as ReturnType<typeof setInterval>,
        finished: false,
        liveUser: null,
        liveAsst: null,
        pendingText: '',
        delegQueue: Promise.resolve(),
        lastOut: 0,
        usageSeconds: null,
        closing: null,
      };
      dc.onmessage = (e) => {
        if (S.finished) return;
        try {
          const ev = JSON.parse(String(e.data)) as ServerEvent;
          if (S.provider === 'live') handleLive(S, ev);
          else handleRealtime(S, ev);
        } catch (err) {
          console.warn('[voz] evento inválido', err);
        }
      };
      pc.onconnectionstatechange = () => {
        if (sess.current === S && (pc!.connectionState === 'failed' || pc!.connectionState === 'closed'))
          end({ reason: 'A conexão de voz caiu.' });
      };

      const sessionBody = { conversationId: c.getConversationId(), pageContext: c.context ?? undefined };
      let session: VoiceSessionDTO;
      if (provider === 'live') {
        // GPT-Live: nosso servidor cria a sessão com a oferta completa e devolve a resposta SDP
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIce(pc);
        if (my !== attempt.current) return abandon();
        session = await api<VoiceSessionDTO>('/api/voice/session', {
          method: 'POST',
          body: { ...sessionBody, sdp: pc.localDescription?.sdp ?? '' },
        });
        if (my !== attempt.current) return abandon();
        if (session.provider !== 'live') throw new Error('O servidor mudou o modo de voz. Recarregue a página.');
        await pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
      } else {
        // Realtime: segredo efêmero e troca de SDP direto com a OpenAI
        session = await api<VoiceSessionDTO>('/api/voice/session', { method: 'POST', body: sessionBody });
        if (my !== attempt.current) return abandon();
        if (session.provider !== 'realtime') throw new Error('O servidor mudou o modo de voz. Recarregue a página.');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const res = await fetch(session.callsUrl, {
          method: 'POST',
          body: offer.sdp,
          headers: { authorization: `Bearer ${session.clientSecret}`, 'content-type': 'application/sdp' },
        });
        if (!res.ok) throw new Error('Não consegui conectar ao serviço de voz. Tente de novo.');
        const answer = await res.text();
        if (my !== attempt.current) return abandon();
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      }
      S.conversationId = session.conversationId;
      S.userFirstName = session.userFirstName;
      S.maxSeconds = session.maxSeconds;
      c.setConversationId(session.conversationId);
      c.setContext(null);

      sess.current = S;
      setMaxSeconds(session.maxSeconds);
      chatRef.current.registerVoiceNotifier((text) =>
        S.provider === 'live'
          ? liveSay(S, 'session.thinking.append', null, text)
          : send(S, {
              type: 'conversation.item.create',
              item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
            }),
      );

      // nível do áudio (0..1) para o orbe: microfone enquanto ouve, voz do assistente enquanto fala
      const buf = new Uint8Array(new ArrayBuffer(micAnalyser.fftSize));
      const tick = () => {
        if (sess.current !== S) return;
        if (S.provider === 'live') {
          // o Live não avisa quando começa/termina de falar: detecta pela saída de áudio
          const now = performance.now();
          if (rms(outAnalyser, buf) > 0.02) S.lastOut = now;
          const speaking = now - S.lastOut < 450;
          if (speaking !== S.speaking) {
            S.speaking = speaking;
            if (speaking) S.lastActivity = Date.now();
            go(speaking ? 'speaking' : S.toolsRunning ? 'thinking' : 'listening');
          }
        }
        const src = S.speaking ? outAnalyser : micAnalyser;
        const raw = S.speaking || S.mic.getAudioTracks()[0]?.enabled ? rms(src, buf) : 0;
        const target = Math.min(1, raw * 4.5);
        levelRef.current += (target - levelRef.current) * (target > levelRef.current ? 0.35 : 0.12);
        S.raf = requestAnimationFrame(tick);
      };
      S.raf = requestAnimationFrame(tick);
      S.timer = setInterval(() => {
        if (sess.current !== S || !S.connected) return;
        const secs = Math.floor((Date.now() - S.startedAt) / 1000);
        setElapsed(secs);
        if (secs >= S.maxSeconds) end({ reason: 'Tempo máximo da conversa por voz atingido.' });
        else if (!S.speaking && !S.toolsRunning && Date.now() - S.lastActivity > IDLE_SECONDS * 1000)
          end({ reason: 'Conversa por voz encerrada por inatividade.' });
      }, 1000);
    } catch (err) {
      abandon();
      if (my !== attempt.current) return;
      const msg = micErrorMessage(err);
      setError(msg);
      go('error');
    }
  }, [end, go, provider]);

  const toggleMute = useCallback(() => {
    const S = sess.current;
    if (!S) return;
    const track = S.mic.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
    if (S.provider === 'live')
      send(S, { type: track.enabled ? 'session.input_audio.unmute' : 'session.input_audio.mute', event_id: tempId('ev') });
  }, []);

  const dismiss = useCallback(() => {
    setError(null);
    end();
    go('idle');
  }, [end, go]);

  // troca de workspace, saída da tela ou fechamento da aba encerram a conversa
  useEffect(() => () => end(), [workspaceId, end]);
  useEffect(() => {
    const onHide = () => end({ beacon: true });
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [end]);

  return {
    state,
    active: state !== 'idle',
    muted,
    elapsed,
    maxSeconds,
    activeTool,
    error,
    levelRef,
    start,
    end,
    dismiss,
    toggleMute,
  };
}

export type VoiceSessionApi = ReturnType<typeof useVoiceSession>;
