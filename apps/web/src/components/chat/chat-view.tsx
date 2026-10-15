import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Camera, FileText, Loader2, Paperclip, Sparkles, SquarePen, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useBreakpoint, useReducedMotion } from '@/lib/media';
import type { UploadResult } from '@/lib/types';
import { useWorkspace } from '@/lib/workspace';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/menu';
import { toast } from 'sonner';
import { useMe } from '@/lib/queries';
import { DraftCard } from './draft-card';
import { VoiceButton, voiceSupported } from './voice-button';
import { toolLabel, useChat, type UiAttachment, type UiMessage } from './chat-context';

const SUGGESTIONS: Array<{ label: string; text: string; attach?: boolean }> = [
  { label: 'quanto sobra em dezembro?', text: 'quanto sobra em dezembro?' },
  { label: 'importar fatura', text: 'importa essa fatura', attach: true },
  { label: 'paguei 230 de luz no BB hoje', text: 'paguei 230 de luz no BB hoje' },
  { label: 'quanto gastei com energia?', text: 'quanto gastei com energia em outubro?' },
  { label: 'desfaz', text: 'desfaz' },
];

const ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.csv,.ofx,application/pdf,image/jpeg,image/png,text/csv,application/x-ofx';
const MAX_BYTES = 20 * 1024 * 1024;

interface PendingFile extends UiAttachment {
  uploading: boolean;
}

/** Renderiza **negrito** simples sem HTML (texto do modelo é dado não confiável). */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Digitando">
      <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" />
      <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" />
      <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" />
    </span>
  );
}

function MessageBubble({ m }: { m: UiMessage }) {
  const reduced = useReducedMotion();
  const mine = m.role === 'user';
  const empty = !m.text && !m.drafts.length && !m.error && !m.notice;
  return (
    <motion.li
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn('flex flex-col gap-2', mine ? 'items-end' : 'items-start')}
      data-role={m.role}
    >
      {m.context ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          Sobre: {m.context.panel}
        </span>
      ) : null}
      {m.attachments.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {m.attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-[12px]"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{a.filename}</span>
            </span>
          ))}
        </div>
      ) : null}
      {m.text || empty || m.tool ? (
        <div
          className={cn(
            'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[14.5px] leading-relaxed sm:text-[14px]',
            mine
              ? 'rounded-br-md bg-primary text-primary-foreground'
              : 'rounded-bl-md bg-muted text-foreground',
          )}
        >
          {m.text ? <RichText text={m.text} /> : null}
          {m.streaming && !m.text && !m.tool ? <TypingDots /> : null}
          {m.tool ? (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-[12px] text-muted-foreground',
                m.text && 'mt-1.5',
              )}
              data-testid="tool-chip"
            >
              <Loader2 className="size-3 animate-spin" aria-hidden /> {toolLabel(m.tool)}
            </span>
          ) : null}
        </div>
      ) : null}
      {m.drafts.map((d) => (
        <div key={d.id} className="w-full max-w-[460px]">
          <DraftCard draft={d} />
        </div>
      ))}
      {m.notice ? (
        <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-positive-soft px-3.5 py-2 text-[14px] text-positive">
          {m.notice.summary} {m.notice.impact ? <span className="money">{m.notice.impact}</span> : null}
        </div>
      ) : null}
      {m.error ? (
        <div
          role="alert"
          className="max-w-[88%] rounded-2xl bg-negative-soft px-3.5 py-2 text-[13.5px] text-negative"
        >
          {m.error}
        </div>
      ) : null}
    </motion.li>
  );
}

export function ChatView({
  headerActions,
  className,
  title = 'Assistente',
}: {
  headerActions?: ReactNode;
  className?: string;
  title?: string;
}) {
  const chat = useChat();
  const { canWrite } = useWorkspace();
  const bp = useBreakpoint();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const me = useMe();
  const canDictate = Boolean(me.data?.features?.audio) && voiceSupported();

  // mantém a conversa "grudada" no fim enquanto o usuário não rolar para cima
  const stick = useRef(true);
  const last = chat.messages.at(-1);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, last?.text, last?.drafts.length, last?.tool]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      ro.disconnect();
      for (const child of Array.from(el.children)) ro.observe(child);
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  useEffect(() => {
    if (chat.focusTick > 0) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [chat.focusTick]);

  // altura automática do textarea
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [chat.input]);

  const upload = useCallback(async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      if (file.size > MAX_BYTES) {
        toast.error(`“${file.name}” tem mais de 20 MB.`);
        continue;
      }
      const temp: PendingFile = {
        id: `tmp-${file.name}-${Date.now()}`,
        filename: file.name,
        mime: file.type,
        uploading: true,
      };
      setFiles((f) => [...f, temp].slice(-5));
      try {
        const fd = new FormData();
        fd.append('file', file, file.name);
        const r = await api<UploadResult>('/api/attachments', { method: 'POST', body: fd });
        setFiles((f) =>
          f.map((x) =>
            x.id === temp.id ? { id: r.id, filename: r.filename, mime: r.mime, uploading: false } : x,
          ),
        );
        if (r.duplicate) toast.info('Este arquivo já foi enviado antes; vou reaproveitar a leitura.');
      } catch (err) {
        setFiles((f) => f.filter((x) => x.id !== temp.id));
        toast.error(err instanceof Error ? err.message : 'Falha no envio do arquivo.');
      }
    }
  }, []);

  const uploading = files.some((f) => f.uploading);
  const canSend = !chat.streaming && !uploading && (chat.input.trim().length > 0 || files.length > 0);

  const submit = () => {
    if (!canSend) return;
    const text = chat.input;
    const atts = files.map(({ id, filename, mime }) => ({ id, filename, mime }));
    stick.current = true;
    chat.setInput('');
    setFiles([]);
    void chat.send(text, { attachments: atts });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && bp !== 'phone') {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canWrite) return;
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };

  const pickSuggestion = (s: (typeof SUGGESTIONS)[number]) => {
    if (s.attach) {
      chat.setInput(s.text);
      fileRef.current?.click();
      return;
    }
    void chat.send(s.text);
  };

  const showSuggestions =
    !chat.streaming && canWrite && (chat.messages.length === 0 || (!chat.input && !files.length));

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col bg-card', className)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
      data-testid="chat"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
          <Sparkles className="size-4" aria-hidden />
        </div>
        <h2 className="flex-1 truncate text-[15px] font-semibold">{title}</h2>
        <Tip label="Nova conversa">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Nova conversa"
            onClick={() => void chat.newConversation()}
          >
            <SquarePen aria-hidden />
          </Button>
        </Tip>
        {headerActions}
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 scrollbar-thin"
        aria-live="polite"
        aria-busy={chat.streaming}
      >
        {chat.loading ? (
          <div className="space-y-3">
            <Skeleton className="ml-auto h-9 w-2/3" />
            <Skeleton className="h-16 w-3/4" />
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="mx-auto flex max-w-sm flex-col items-center px-2 pt-6 text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-foreground">
              <Sparkles className="size-6" aria-hidden />
            </div>
            <p className="text-[15px] font-semibold">Fale com suas finanças</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Lance gastos, cadastre contas e pergunte sobre o futuro. Tudo que muda dados aparece como prévia
              para você confirmar.
            </p>
            <p className="mt-3 text-[13px] text-muted-foreground">
              Comece dizendo:{' '}
              <span className="font-medium text-foreground">“abri uma conta no BB com 5.000”</span>
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-4" aria-label="Mensagens">
            {chat.messages.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t bg-card px-3 pb-3 pt-2">
        <AnimatePresence initial={false}>
          {showSuggestions ? (
            <div
              className="-mx-3 mb-2 flex gap-1.5 overflow-x-auto px-3 pb-0.5 no-scrollbar"
              role="list"
              aria-label="Sugestões"
            >
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  role="listitem"
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="h-8 shrink-0 rounded-full border bg-card px-3 text-[12.5px] text-foreground transition-colors hover:bg-muted"
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </AnimatePresence>

        {chat.context || chat.hint ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {chat.context ? (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-[12px] text-primary-soft-foreground">
                <span className="truncate">Sobre: {chat.context.panel}</span>
                <button
                  type="button"
                  aria-label="Remover contexto"
                  className="rounded-full p-1 hover:bg-card/50"
                  onClick={() => chat.setContext(null)}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ) : null}
            {chat.hint ? <span className="text-[12px] text-muted-foreground">{chat.hint}</span> : null}
          </div>
        ) : null}

        {files.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span
                key={f.id}
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border bg-subtle py-1 pl-2 pr-1 text-[12px]"
                data-testid="pending-attachment"
              >
                {f.uploading ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{f.filename}</span>
                <button
                  type="button"
                  aria-label={`Remover ${f.filename}`}
                  className="rounded p-1 hover:bg-muted"
                  onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <form
          className="flex items-end gap-1.5 rounded-2xl border border-input bg-card p-1.5 shadow-soft focus-within:border-ring"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) =>
              e.target.files && void upload(e.target.files).finally(() => (e.target.value = ''))
            }
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) =>
              e.target.files && void upload(e.target.files).finally(() => (e.target.value = ''))
            }
          />
          <Tip label="Anexar arquivo (PDF, imagem, CSV, OFX)" side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-xl"
              aria-label="Anexar arquivo"
              disabled={!canWrite}
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip aria-hidden />
            </Button>
          </Tip>
          {bp === 'phone' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-xl"
              aria-label="Fotografar documento"
              disabled={!canWrite}
              onClick={() => cameraRef.current?.click()}
            >
              <Camera aria-hidden />
            </Button>
          ) : null}
          <label htmlFor="chat-input" className="sr-only">
            Mensagem para o assistente
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={chat.input}
            onChange={(e) => chat.setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              canWrite
                ? bp === 'phone'
                  ? 'Mensagem ou anexo…'
                  : 'Escreva ou anexe um extrato…'
                : 'Pergunte sobre suas finanças…'
            }
            enterKeyHint="send"
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-[16px] leading-6 outline-none placeholder:text-muted-foreground sm:text-[14px]"
          />
          {canDictate && !chat.input.trim() && !files.length ? (
            <VoiceButton
              disabled={chat.streaming}
              onText={(t) => {
                chat.setInput(t);
                inputRef.current?.focus();
              }}
            />
          ) : null}
          <Button
            type="submit"
            size="icon"
            className="size-10 shrink-0 rounded-xl"
            aria-label="Enviar"
            disabled={!canSend}
          >
            {chat.streaming ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
          </Button>
        </form>
      </div>

      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-medium text-primary-soft-foreground">
          Solte o arquivo para anexar
        </div>
      ) : null}
    </div>
  );
}
