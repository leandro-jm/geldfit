import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, CircleSlash, Copy, ListChecks, Pencil, TrendingUp, X } from 'lucide-react';
import { formatDateBR, type DraftDTO } from '@sf/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/common/money';
import { useWorkspace } from '@/lib/workspace';
import { cn } from '@/lib/utils';
import { useChat } from './chat-context';

const STATUS: Record<
  DraftDTO['status'],
  { label: string; tone: 'positive' | 'neutral' | 'negative' | 'warning' | 'accent' }
> = {
  pending: { label: 'Aguardando confirmação', tone: 'accent' },
  confirmed: { label: 'Confirmado', tone: 'positive' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
  expired: { label: 'Expirou', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'negative' },
};

const MAX_ITEMS = 6;

export function DraftCard({ draft }: { draft: DraftDTO }) {
  const chat = useChat();
  const { canWrite } = useWorkspace();
  const p = draft.preview;
  const pending = draft.status === 'pending';
  const busy = chat.busyDrafts.has(draft.id);
  const items = p.items ?? [];
  const st = STATUS[draft.status];

  return (
    <section
      aria-label={`Prévia: ${p.title}`}
      data-testid="draft-card"
      data-status={draft.status}
      className={cn(
        'w-full overflow-hidden rounded-2xl border bg-card shadow-soft',
        !pending && 'opacity-90',
      )}
    >
      <header className="flex items-start justify-between gap-2 border-b bg-subtle/70 px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5">{p.title}</h3>
          {p.summary ? <p className="mt-0.5 text-[13px] text-muted-foreground">{p.summary}</p> : null}
        </div>
        <Badge tone={st.tone} className="mt-0.5 shrink-0">
          {draft.status === 'confirmed' ? (
            <Check aria-hidden />
          ) : draft.status === 'cancelled' ? (
            <CircleSlash aria-hidden />
          ) : null}
          {st.label}
        </Badge>
      </header>

      <div className="space-y-2.5 px-3.5 py-3">
        {p.totals ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" data-testid="draft-totals">
            <span className="font-medium">
              {p.totals.count} {p.totals.count === 1 ? 'lançamento' : 'lançamentos'}
            </span>
            <span className="text-muted-foreground">·</span>
            <Money cents={p.totals.amountCents} className="font-medium" />
            {p.totals.duplicates > 0 ? (
              <Badge tone="warning">
                <Copy aria-hidden /> {p.totals.duplicates} possíveis duplicatas
              </Badge>
            ) : null}
            {p.totals.lowConfidence > 0 ? (
              <Badge tone="warning">
                <AlertTriangle aria-hidden /> {p.totals.lowConfidence} baixa confiança
              </Badge>
            ) : null}
          </div>
        ) : null}

        {p.lines.length ? (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            {p.lines.map((l, i) => (
              <div key={i} className="contents">
                <dt className="text-muted-foreground">{l.label}</dt>
                <dd
                  className={cn(
                    'money text-right font-medium break-words',
                    l.tone === 'positive' && 'text-positive',
                    l.tone === 'negative' && 'text-negative',
                    l.tone === 'warning' && 'text-warning',
                    l.tone === 'muted' && 'text-muted-foreground',
                  )}
                >
                  {l.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {items.length ? (
          <ul className="divide-y rounded-xl border text-[13px]">
            {items.slice(0, MAX_ITEMS).map((it, i) => (
              <li key={i} className="flex items-center gap-2 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{it.description}</div>
                  <div className="flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground">
                    <span className="tnum">{formatDateBR(it.date)}</span>
                    {it.category ? <span>· {it.category}</span> : null}
                    {it.duplicate ? <Badge tone="warning">duplicata?</Badge> : null}
                    {it.lowConfidence ? <Badge tone="warning">conferir</Badge> : null}
                  </div>
                </div>
                <Money
                  cents={it.amountCents}
                  direction={it.direction}
                  tone={it.direction === 'in' ? 'positive' : undefined}
                  className="shrink-0 text-[13px] font-medium"
                />
              </li>
            ))}
            {items.length > MAX_ITEMS ? (
              <li className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
                e mais {items.length - MAX_ITEMS}…
              </li>
            ) : null}
          </ul>
        ) : null}

        {p.warnings.length ? (
          <ul className="space-y-1">
            {p.warnings.map((w, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12.5px] text-warning"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {p.projectionImpact ? (
          <p
            className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground"
            data-testid="draft-impact"
          >
            <TrendingUp className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="money">{p.projectionImpact}</span>
          </p>
        ) : null}
      </div>

      {pending && canWrite ? (
        <footer className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2.5">
          <Button
            size="sm"
            onClick={() => void chat.confirmDraft(draft.id)}
            disabled={busy}
            className="min-h-9 flex-1 sm:flex-none"
          >
            <Check aria-hidden /> Confirmar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => chat.editDraft(draft.id)}
            disabled={busy}
            className="min-h-9"
          >
            <Pencil aria-hidden /> Editar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void chat.cancelDraft(draft.id)}
            disabled={busy}
            className="min-h-9"
          >
            <X aria-hidden /> Cancelar
          </Button>
          {draft.kind === 'import' ? (
            <Button size="sm" variant="link" asChild className="ml-auto">
              <Link to="/importacoes/$draftId" params={{ draftId: draft.id }}>
                <ListChecks aria-hidden /> Revisar itens
              </Link>
            </Button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
