import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ChatMessageDTO, ChatStreamEvent, DraftDTO, PageContext } from '@sf/shared';
import { api, apiFetch, ApiError, readSSE } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import type { CommitResult } from '@/lib/types';

export interface UiAttachment {
  id: string;
  filename: string;
  mime: string;
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  attachments: UiAttachment[];
  drafts: DraftDTO[];
  streaming?: boolean;
  tool?: string | null;
  error?: string | null;
  context?: PageContext | null;
  /** confirmação vinda do próprio chat ("sim") ou do botão */
  notice?: { summary: string; impact: string | null } | null;
}

export interface OpenChatOptions {
  text?: string;
  context?: PageContext;
  focus?: boolean;
}

interface ChatCtx {
  messages: UiMessage[];
  loading: boolean;
  streaming: boolean;
  send: (
    text: string,
    opts?: { attachments?: UiAttachment[]; context?: PageContext | null },
  ) => Promise<void>;
  confirmDraft: (id: string) => Promise<void>;
  cancelDraft: (id: string) => Promise<void>;
  editDraft: (id: string) => void;
  newConversation: () => Promise<void>;
  // composer
  input: string;
  setInput: (v: string) => void;
  context: PageContext | null;
  setContext: (c: PageContext | null) => void;
  hint: string | null;
  setHint: (h: string | null) => void;
  focusTick: number;
  // abertura (o shell decide como: painel, drawer ou tela cheia)
  openChat: (opts?: OpenChatOptions) => void;
  registerOpener: (fn: () => void) => void;
  busyDrafts: Set<string>;
}

const Ctx = createContext<ChatCtx | null>(null);

const TOOL_LABELS: Record<string, string> = {
  parse_attachment: 'Lendo anexo…',
  import_attachment: 'Preparando importação…',
  get_projection: 'Calculando projeção…',
  simulate: 'Simulando cenário…',
  draft_bill: 'Lendo o código de pagamento…',
  get_safe_to_spend: 'Calculando sua folga…',
  evaluate_purchase: 'Avaliando a compra…',
  get_emergency_reserve: 'Simulando o desligamento…',
  query_transactions: 'Consultando lançamentos…',
  aggregate_transactions: 'Somando lançamentos…',
  get_portfolio: 'Analisando carteira…',
  get_insights: 'Buscando insights…',
  list_accounts: 'Consultando contas…',
  list_cards: 'Consultando cartões…',
  list_categories: 'Consultando categorias…',
};

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('draft_') || name.startsWith('set_')) return 'Preparando prévia…';
  if (name.startsWith('get_') || name.startsWith('list_') || name.startsWith('query_'))
    return 'Consultando dados…';
  return 'Pensando…';
}

function fromDTO(m: ChatMessageDTO): UiMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.content,
    createdAt: m.createdAt,
    attachments: m.attachments ?? [],
    drafts: m.drafts ?? [],
  };
}

let tempSeq = 0;
const tempId = (p: string) => `${p}-${Date.now()}-${++tempSeq}`;

export function ChatProvider({ children }: { children: ReactNode }) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [context, setContext] = useState<PageContext | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [busyDrafts, setBusyDrafts] = useState<Set<string>>(new Set());
  const conversationId = useRef<string | null>(null);
  const opener = useRef<() => void>(() => {});
  const abortRef = useRef<AbortController | null>(null);

  const invalidate = useCallback(
    () => void qc.invalidateQueries({ queryKey: ['ws', workspaceId] }),
    [qc, workspaceId],
  );

  // histórico da conversa web mais recente do workspace
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setLoading(true);
    setMessages([]);
    conversationId.current = null;
    api<{ conversationId: string | null; messages: ChatMessageDTO[] }>('/api/chat/history?limit=60')
      .then((r) => {
        if (!alive) return;
        conversationId.current = r.conversationId;
        setMessages(r.messages.map(fromDTO));
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [workspaceId]);

  const patch = useCallback((id: string, fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const markDraft = useCallback((draftId: string, status: DraftDTO['status']) => {
    setMessages((ms) =>
      ms.map((m) =>
        m.drafts.some((d) => d.id === draftId)
          ? { ...m, drafts: m.drafts.map((d) => (d.id === draftId ? { ...d, status } : d)) }
          : m,
      ),
    );
  }, []);

  const send = useCallback<ChatCtx['send']>(
    async (text, opts = {}) => {
      const attachments = opts.attachments ?? [];
      const ctx = opts.context === undefined ? context : opts.context;
      if (!text.trim() && !attachments.length) return;
      const userMsg: UiMessage = {
        id: tempId('u'),
        role: 'user',
        text: text.trim(),
        createdAt: new Date().toISOString(),
        attachments,
        drafts: [],
        context: ctx,
      };
      let asstId = tempId('a');
      const asst: UiMessage = {
        id: asstId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        attachments: [],
        drafts: [],
        streaming: true,
        tool: null,
      };
      setMessages((ms) => [...ms, userMsg, asst]);
      setStreaming(true);
      setContext(null);
      setHint(null);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let changed = false;
      try {
        const res = await apiFetch('/api/chat', {
          method: 'POST',
          body: {
            text: text.trim(),
            conversationId: conversationId.current,
            attachmentIds: attachments.map((a) => a.id),
            pageContext: ctx ?? undefined,
          },
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        await readSSE<ChatStreamEvent | { type: 'done'; conversationId: string; messageId: string }>(
          res,
          (e) => {
            switch (e.type) {
              case 'message_start': {
                const old = asstId;
                asstId = e.messageId;
                patch(old, (m) => ({ ...m, id: e.messageId }));
                break;
              }
              case 'text_delta':
                patch(asstId, (m) => ({ ...m, text: m.text + e.text, tool: null }));
                break;
              case 'text_replace':
                patch(asstId, (m) => ({ ...m, text: e.text }));
                break;
              case 'tool':
                patch(asstId, (m) => ({ ...m, tool: e.status === 'start' ? e.name : null }));
                break;
              case 'draft':
                patch(asstId, (m) => ({
                  ...m,
                  drafts: [...m.drafts.filter((d) => d.id !== e.draft.id), e.draft],
                }));
                break;
              case 'confirmed':
                changed = true;
                markDraft(e.draftId, 'confirmed');
                patch(asstId, (m) => ({ ...m, notice: { summary: e.summary, impact: e.impact } }));
                break;
              case 'error':
                patch(asstId, (m) => ({ ...m, error: e.message }));
                break;
              case 'message_end':
                patch(asstId, (m) => ({ ...m, streaming: false, tool: null }));
                break;
              case 'done':
                conversationId.current = e.conversationId;
                break;
            }
          },
          ctrl.signal,
        );
      } catch (err) {
        if (!ctrl.signal.aborted)
          patch(asstId, (m) => ({ ...m, error: err instanceof Error ? err.message : 'Falha ao enviar.' }));
      } finally {
        patch(asstId, (m) => ({ ...m, streaming: false, tool: null }));
        setStreaming(false);
        abortRef.current = null;
        // respostas como "desfaz" ou "sim" alteram dados; o SSE global também avisa
        if (changed) invalidate();
      }
    },
    [context, invalidate, markDraft, patch],
  );

  const confirmDraft = useCallback(
    async (id: string) => {
      setBusyDrafts((s) => new Set(s).add(id));
      try {
        const r = await api<CommitResult>(`/api/drafts/${id}/confirm`, { method: 'POST', body: {} });
        markDraft(id, 'confirmed');
        setMessages((ms) => [
          ...ms,
          {
            id: tempId('c'),
            role: 'assistant',
            text: [r.summary, r.impact].filter(Boolean).join(' '),
            createdAt: new Date().toISOString(),
            attachments: [],
            drafts: [],
          },
        ]);
        invalidate();
        toast.success(r.summary, { description: r.impact ?? undefined });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'draft_decided') markDraft(id, 'confirmed');
        if (err instanceof ApiError && err.code === 'draft_expired') markDraft(id, 'expired');
        toast.error(err instanceof Error ? err.message : 'Não foi possível confirmar.');
      } finally {
        setBusyDrafts((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    },
    [invalidate, markDraft],
  );

  const cancelDraft = useCallback(
    async (id: string) => {
      setBusyDrafts((s) => new Set(s).add(id));
      try {
        await api(`/api/drafts/${id}/cancel`, { method: 'POST', body: {} });
        markDraft(id, 'cancelled');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Não foi possível cancelar.');
      } finally {
        setBusyDrafts((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    },
    [markDraft],
  );

  const editDraft = useCallback((_id: string) => {
    setHint('Diga o que mudar, ex.: “muda o valor para 250” ou “a data é ontem”.');
    setFocusTick((t) => t + 1);
  }, []);

  const newConversation = useCallback(async () => {
    try {
      const r = await api<{ id: string }>('/api/chat/new', { method: 'POST', body: {} });
      conversationId.current = r.id;
      setMessages([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível iniciar nova conversa.');
    }
  }, []);

  const openChat = useCallback((opts: OpenChatOptions = {}) => {
    if (opts.text !== undefined) setInput(opts.text);
    if (opts.context) setContext(opts.context);
    opener.current();
    setFocusTick((t) => t + 1);
  }, []);

  const registerOpener = useCallback((fn: () => void) => {
    opener.current = fn;
  }, []);

  const value = useMemo<ChatCtx>(
    () => ({
      messages,
      loading,
      streaming,
      send,
      confirmDraft,
      cancelDraft,
      editDraft,
      newConversation,
      input,
      setInput,
      context,
      setContext,
      hint,
      setHint,
      focusTick,
      openChat,
      registerOpener,
      busyDrafts,
    }),
    [
      messages,
      loading,
      streaming,
      send,
      confirmDraft,
      cancelDraft,
      editDraft,
      newConversation,
      input,
      context,
      hint,
      focusTick,
      openChat,
      registerOpener,
      busyDrafts,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('ChatProvider ausente');
  return v;
}
