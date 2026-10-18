import { Fragment, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Bell,
  BellOff,
  CalendarClock,
  Check,
  Clock,
  Eye,
  MessageCircle,
  MoreVertical,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { DraftDTO, NudgeAnswerDTO, NudgeDTO } from '@sf/shared';
import { api } from '@/lib/api';
import { useInvalidateWorkspace, useNudges } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import type { CommitResult } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useChat } from '@/components/chat/chat-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/menu';

export const NUDGE_CATEGORY: Record<string, string> = {
  meta: 'Metas',
  reserva: 'Reserva',
  orcamento: 'Orçamento',
  sazonal: 'Calendário',
  renda: 'Renda',
  carteira: 'Carteira',
  memoria: 'Lembrete',
  perfil: 'Perfil',
  mercado: 'Mercado',
  regra: 'Regras',
  preco: 'Preços',
};

/** *negrito* do WhatsApp vira <strong> (o texto vem do template, não de HTML). */
export function WaText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('*') && p.endsWith('*') && p.length > 2 ? (
          <strong key={i}>{p.slice(1, -1)}</strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : 'Falhou.');

function InlinePreview({ draft, onDone }: { draft: DraftDTO; onDone: () => void }) {
  const invalidate = useInvalidateWorkspace();
  const [busy, setBusy] = useState(false);
  const p = draft.preview;
  const decide = async (action: 'confirm' | 'cancel') => {
    setBusy(true);
    try {
      if (action === 'confirm') {
        const r = await api<CommitResult>(`/api/drafts/${draft.id}/confirm`, { method: 'POST', body: {} });
        toast.success(r.summary, { description: r.impact ?? undefined });
      } else {
        await api(`/api/drafts/${draft.id}/cancel`, { method: 'POST', body: {} });
        toast('Sugestão dispensada. Nada foi gravado.');
      }
      void invalidate();
      onDone();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 rounded-xl border bg-subtle/60 p-3" data-testid="nudge-preview">
      <p className="text-[13.5px] font-semibold">{p.title}</p>
      {p.summary ? <p className="mt-0.5 text-[12.5px] text-muted-foreground">{p.summary}</p> : null}
      {p.lines.length ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
          {p.lines.map((l) => (
            <Fragment key={l.label}>
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd>{l.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {p.projectionImpact ? <p className="mt-2 text-[12.5px] text-primary">{p.projectionImpact}</p> : null}
      {p.warnings.map((w) => (
        <p key={w} className="mt-1 text-[12px] text-warning">
          {w}
        </p>
      ))}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('confirm')}>
          <Check /> Confirmar
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('cancel')}>
          Agora não
        </Button>
      </div>
    </div>
  );
}

/** Uma sugestão ou pergunta do assistente, com as ações de um toque. */
export function NudgeCard({ n, compact }: { n: NudgeDTO; compact?: boolean }) {
  const chat = useChat();
  const invalidate = useInvalidateWorkspace();
  const { canWrite } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftDTO | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const prepare = () =>
    run(async () =>
      setDraft(await api<DraftDTO>(`/api/nudges/${n.id}/prepare`, { method: 'POST', body: {} })),
    );
  const answer = (optionId: string) =>
    run(async () => {
      const r = await api<NudgeAnswerDTO>(`/api/nudges/${n.id}/answer`, {
        method: 'POST',
        body: { optionId },
      });
      if (r.draft) setDraft(r.draft);
      else {
        if (r.reply) toast.success(r.reply);
        void invalidate();
      }
      if (r.chatPrompt) chat.openChat({ text: r.chatPrompt, focus: true });
    });
  const snooze = () =>
    run(async () => {
      await api(`/api/nudges/${n.id}/snooze`, { method: 'POST', body: { days: 7 } });
      toast('Adiado por uma semana.');
      void invalidate();
    });
  const dismiss = (mute: boolean) =>
    run(async () => {
      await api(`/api/nudges/${n.id}/dismiss`, { method: 'POST', body: { mute } });
      toast(mute ? 'Não vou mais sugerir isso.' : 'Dispensado.');
      void invalidate();
    });

  const options = n.options.filter((o) => o.id !== 'later');
  return (
    <li
      className={cn('rounded-2xl border bg-card p-3.5 shadow-soft', compact && 'shadow-none')}
      data-testid="nudge-card"
      data-kind={n.kind}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={n.type === 'question' ? 'accent' : 'neutral'}>
              {n.type === 'question' ? 'Pergunta' : (NUDGE_CATEGORY[n.category] ?? 'Sugestão')}
            </Badge>
            {n.deliveredChannel === 'whatsapp' ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <MessageCircle className="size-3" aria-hidden /> enviada no WhatsApp
              </span>
            ) : null}
          </div>
          <h3 className="text-[14px] font-semibold leading-5">{n.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            <WaText text={n.message} />
          </p>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Mais opções: ${n.title}`} disabled={busy}>
              <MoreVertical />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void snooze()}>
              <Clock /> Lembrar em 7 dias
            </MenuItem>
            <MenuItem onSelect={() => void dismiss(false)}>
              <X /> Dispensar
            </MenuItem>
            <MenuItem onSelect={() => void dismiss(true)}>
              <BellOff /> Não sugerir mais isto
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {draft ? (
        <InlinePreview draft={draft} onDone={() => setDraft(null)} />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {n.hasDraft && canWrite ? (
            <Button size="sm" variant="soft" disabled={busy} onClick={() => void prepare()}>
              <Eye /> Ver prévia
            </Button>
          ) : null}
          {options.map((o) => (
            <Button key={o.id} size="sm" variant="outline" disabled={busy} onClick={() => void answer(o.id)}>
              {o.label}
            </Button>
          ))}
          {!n.hasDraft && !options.length ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void dismiss(false)}>
              <Check /> Entendi
            </Button>
          ) : null}
          {n.options.some((o) => o.id === 'later') || n.hasDraft ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void snooze()}>
              <CalendarClock /> Depois
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function NudgeList({
  items,
  compact,
  empty,
}: {
  items: NudgeDTO[];
  compact?: boolean;
  empty?: ReactNode;
}) {
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <ul className="space-y-3" aria-label="Sugestões do assistente">
      {items.map((n) => (
        <NudgeCard key={n.id} n={n} compact={compact} />
      ))}
    </ul>
  );
}

/** Sino do cabeçalho: quantas sugestões e perguntas estão abertas. */
export function AssistantBell() {
  const open = useNudges('open');
  const count = open.data?.length ?? 0;
  const label = count ? `Assistente: ${count} ${count === 1 ? 'sugestão' : 'sugestões'}` : 'Assistente';
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon" asChild>
        <Link to="/assistente" aria-label={label} className="relative" data-testid="assistant-bell">
          <Bell aria-hidden />
          {count ? (
            <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Link>
      </Button>
    </Tip>
  );
}
