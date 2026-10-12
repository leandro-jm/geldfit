import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Copy, FileText, ListChecks, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { formatBRL, formatDateBR } from '@sf/shared';
import { api } from '@/lib/api';
import { useAccounts, useAttachments, useCards, useCategories, useInvalidateWorkspace, usePendingDrafts } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, formatDateTimeBR } from '@/lib/utils';
import type { CommitResult, DraftWithPayload, ImportPayload } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { useChat } from '@/components/chat/chat-context';

const STATUS_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'positive' | 'negative' | 'warning' | 'accent' }
> = {
  uploaded: { label: 'enviado', tone: 'neutral' },
  processing: { label: 'lendo…', tone: 'accent' },
  extracted: { label: 'lido', tone: 'positive' },
  imported: { label: 'importado', tone: 'positive' },
  failed: { label: 'falhou', tone: 'negative' },
};

const DOC_LABEL: Record<string, string> = {
  bank_statement: 'Extrato bancário',
  card_bill: 'Fatura de cartão',
  pension_statement: 'Extrato de previdência',
  brokerage_note: 'Nota de corretagem',
  position_statement: 'Extrato de posição',
  receipt: 'Comprovante',
  unknown: 'Desconhecido',
};

export function ImportsPage() {
  const q = useAttachments();
  const chat = useChat();
  const pendingQ = usePendingDrafts('import');
  const pending = useMemo(() => pendingQ.data ?? [], [pendingQ.data]);
  return (
    <div>
      <PageHeader
        title="Importações"
        description="Extratos, faturas e notas enviados pelo chat. Revise item a item antes de confirmar."
        actions={
          <Button size="sm" onClick={() => chat.openChat({ text: 'importa esse extrato' })}>
            <Upload aria-hidden /> Importar pelo chat
          </Button>
        }
      />
      {pending.length ? (
        <section aria-labelledby="pending-h" className="mb-6">
          <h2 id="pending-h" className="mb-2 text-[15px] font-semibold">
            Aguardando revisão
          </h2>
          <Card className="divide-y overflow-hidden">
            {pending.map((d) => (
              <Link
                key={d.id}
                to="/importacoes/$draftId"
                params={{ draftId: d.id }}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-subtle"
              >
                <ListChecks className="size-5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{d.preview.title}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {d.preview.summary}
                  </span>
                </span>
                <Badge tone="accent">revisar</Badge>
              </Link>
            ))}
          </Card>
        </section>
      ) : null}
      <h2 className="mb-2 text-[15px] font-semibold">Arquivos enviados</h2>
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : (q.data ?? []).length === 0 ? (
        <EmptyState
          title="Nenhum arquivo enviado"
          icon={<FileText className="size-5" />}
          hint="Anexe no chat um extrato (OFX, CSV, PDF) ou a foto de uma fatura."
          prompt="importa essa fatura"
        />
      ) : (
        <Card className="divide-y overflow-hidden">
          {(q.data ?? []).map((a) => {
            const st = STATUS_LABEL[a.status] ?? { label: a.status, tone: 'neutral' as const };
            return (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{a.filename}</p>
                  <p className="truncate text-[12.5px] text-muted-foreground">
                    {a.docType ? `${DOC_LABEL[a.docType] ?? a.docType} · ` : ''}
                    {formatDateTimeBR(a.createdAt)} ·{' '}
                    {(a.sizeBytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB
                  </p>
                  {a.error ? <p className="mt-0.5 truncate text-[12px] text-negative">{a.error}</p> : null}
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

type Item = ImportPayload['items'][number] & { _key: number; _dup: boolean; _low: boolean };

export function ImportReviewPage({ draftId }: { draftId: string }) {
  const { workspaceId, canWrite } = useWorkspace();
  const navigate = useNavigate();
  const invalidate = useInvalidateWorkspace();
  const cats = useCategories();
  const accounts = useAccounts();
  const cards = useCards();
  const q = useQuery({
    queryKey: ['ws', workspaceId, 'draft', draftId],
    queryFn: () => api<DraftWithPayload>(`/api/drafts/${draftId}`),
    staleTime: Infinity,
  });
  const [items, setItems] = useState<Item[]>([]);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.data || q.data.kind !== 'import') return;
    const p = q.data.payload as ImportPayload;
    const its = p.items.map((it, i) => ({
      ...it,
      _key: i,
      _dup: Boolean(it.duplicate),
      _low: it.confidence !== null && it.confidence !== undefined && it.confidence < 0.7,
    }));
    setItems(its);
    setIncluded(new Set(its.filter((i) => !(p.skipDuplicates && i._dup)).map((i) => i._key)));
  }, [q.data]);

  const catName = (id?: string | null) => (id ? cats.data?.find((c) => c.id === id)?.name : null) ?? '—';
  const srcName = (it: Item) =>
    (it.cardId
      ? cards.data?.find((c) => c.id === it.cardId)?.name
      : accounts.data?.find((a) => a.id === it.accountId)?.name) ?? '—';
  const chosen = items.filter((i) => included.has(i._key));
  const net = chosen.reduce((s, i) => s + (i.direction === 'out' ? -i.amountCents : i.amountCents), 0);
  const dups = items.filter((i) => i._dup).length;
  const lows = items.filter((i) => i._low).length;

  const toggle = (k: number) =>
    setIncluded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const confirm = async () => {
    if (!q.data) return;
    const p = q.data.payload as ImportPayload;
    setBusy(true);
    try {
      const nextItems = chosen.map(({ _key, _dup, _low, ...rest }) => {
        void _key;
        void _low;
        return { ...rest, duplicate: _dup ? false : rest.duplicate };
      });
      await api(`/api/drafts/${draftId}`, {
        method: 'PATCH',
        body: { payload: { ...p, items: nextItems, skipDuplicates: true } },
      });
      const r = await api<CommitResult>(`/api/drafts/${draftId}/confirm`, { method: 'POST', body: {} });
      toast.success(r.summary, { description: r.impact ?? undefined });
      void invalidate();
      void navigate({ to: '/lancamentos' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível importar.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/api/drafts/${draftId}/cancel`, { method: 'POST', body: {} });
      toast.success('Importação cancelada.');
      void navigate({ to: '/importacoes' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    } finally {
      setBusy(false);
    }
  };

  const d = q.data;
  return (
    <div>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
        <Link to="/importacoes">
          <ArrowLeft aria-hidden /> Importações
        </Link>
      </Button>
      <PageHeader
        title="Revisar importação"
        description={d ? d.preview.summary || d.preview.title : undefined}
      />
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : d && d.kind !== 'import' ? (
        <EmptyState title="Este rascunho não é uma importação" />
      ) : d ? (
        <>
          {d.status !== 'pending' ? (
            <p role="status" className="mb-4 rounded-xl bg-muted px-4 py-3 text-[13.5px]">
              Esta importação já foi{' '}
              {d.status === 'confirmed' ? 'confirmada' : d.status === 'cancelled' ? 'cancelada' : 'encerrada'}
              .
            </p>
          ) : null}
          <Card className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 p-4 text-[13.5px]">
            <span>
              <span className="font-semibold tnum">{chosen.length}</span> de {items.length} selecionados
            </span>
            <span>
              Saldo: <Money cents={net} tone="auto" signed className="font-semibold" />
            </span>
            {dups ? (
              <Badge tone="warning">
                <Copy aria-hidden /> {dups} possíveis duplicatas (desmarcadas)
              </Badge>
            ) : null}
            {lows ? (
              <Badge tone="warning">
                <AlertTriangle aria-hidden /> {lows} com baixa confiança
              </Badge>
            ) : null}
            {d.status === 'pending' && canWrite ? (
              <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
                <Button
                  variant="outline"
                  onClick={() => void cancel()}
                  disabled={busy}
                  className="flex-1 sm:flex-none"
                >
                  Cancelar importação
                </Button>
                <Button
                  onClick={() => void confirm()}
                  disabled={busy || chosen.length === 0}
                  className="flex-1 sm:flex-none"
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Importar {chosen.length}
                </Button>
              </div>
            ) : null}
          </Card>
          <Card className="divide-y overflow-hidden">
            <div className="flex items-center gap-3 bg-subtle px-4 py-2 text-[12px] text-muted-foreground">
              <Checkbox
                aria-label="Selecionar todos"
                checked={
                  chosen.length === items.length ? true : chosen.length === 0 ? false : 'indeterminate'
                }
                onCheckedChange={(v) =>
                  setIncluded(v === true ? new Set(items.map((i) => i._key)) : new Set())
                }
                disabled={d.status !== 'pending'}
              />
              <span>Lançamento</span>
            </div>
            {items.map((it) => (
              <label
                key={it._key}
                className={cn(
                  'flex cursor-pointer items-center gap-3 px-4 py-2.5',
                  !included.has(it._key) && 'opacity-60',
                )}
              >
                <Checkbox
                  checked={included.has(it._key)}
                  onCheckedChange={() => toggle(it._key)}
                  disabled={d.status !== 'pending'}
                  aria-label={`Incluir ${it.description}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                    <span className="truncate">{it.description}</span>
                    {it._dup ? <Badge tone="warning">duplicata?</Badge> : null}
                    {it._low ? <Badge tone="warning">conferir</Badge> : null}
                  </p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    <span className="tnum">{formatDateBR(it.date)}</span> · {catName(it.categoryId)} ·{' '}
                    {srcName(it)}
                    {it.installments && it.installments > 1
                      ? ` · ${it.installmentStart ?? 1}/${it.installments}`
                      : ''}
                  </p>
                </div>
                <Money
                  cents={it.amountCents}
                  direction={it.direction}
                  tone={it.direction === 'in' ? 'positive' : undefined}
                  className="shrink-0 text-[13.5px] font-semibold"
                />
              </label>
            ))}
          </Card>
          <p className="mt-3 text-[12px] text-muted-foreground">
            Total bruto dos selecionados: {formatBRL(chosen.reduce((s, i) => s + i.amountCents, 0))}
          </p>
        </>
      ) : null}
    </div>
  );
}
