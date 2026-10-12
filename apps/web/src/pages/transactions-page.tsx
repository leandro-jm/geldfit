import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Pencil, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatBRL, formatDateBR, parseAmount, type CategoryDTO, type TransactionDTO } from '@sf/shared';
import { useFilters } from '@/lib/filters';
import {
  useAccounts,
  useAction,
  useCards,
  useCategories,
  useTransactions,
  type TxFilters,
} from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { apiFetch } from '@/lib/api';
import { cn, downloadBlob, todayLocalISO } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog, ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';

const PAGE = 50;

interface EditState {
  description: string;
  categoryId: string;
  amount: string;
  date: string;
}

function toEdit(t: TransactionDTO): EditState {
  return {
    description: t.description,
    categoryId: t.categoryId ?? '',
    amount: (t.amountCents / 100).toFixed(2).replace('.', ','),
    date: t.date,
  };
}

function diff(t: TransactionDTO, e: EditState): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  if (e.description.trim() && e.description.trim() !== t.description)
    changes.description = e.description.trim();
  if (e.categoryId && e.categoryId !== (t.categoryId ?? '')) changes.categoryId = e.categoryId;
  const cents = parseAmount(e.amount);
  if (cents && cents > 0 && cents !== t.amountCents) changes.amountCents = cents;
  if (e.date && e.date !== t.date) changes.date = e.date;
  return Object.keys(changes).length ? changes : null;
}

function CategorySelect({
  id,
  value,
  onChange,
  categories,
  direction,
  className,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  categories: CategoryDTO[];
  direction: 'in' | 'out';
  className?: string;
}) {
  const list = categories.filter((c) => c.kind === (direction === 'in' ? 'income' : 'expense'));
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Sem categoria</option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

function useTxActions() {
  const action = useAction();
  const save = async (t: TransactionDTO, e: EditState) => {
    const changes = diff(t, e);
    if (!changes) return true;
    try {
      const r = await action.mutateAsync({ kind: 'edit', payload: { transactionIds: [t.id], changes } });
      toast.success(r.summary, { description: r.impact ?? undefined });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.');
      return false;
    }
  };
  const remove = async (ids: string[]) => {
    try {
      const r = await action.mutateAsync({ kind: 'delete', payload: { entity: 'transactions', ids } });
      toast.success(r.summary, { description: r.impact ?? undefined });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível apagar.');
      return false;
    }
  };
  const markPaid = async (t: TransactionDTO) => {
    try {
      const r = await action.mutateAsync({
        kind: 'mark_paid',
        payload: { transactionId: t.id, date: todayLocalISO() },
      });
      toast.success(r.summary);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  return { save, remove, markPaid, pending: action.isPending };
}

function TxRow({
  t,
  categories,
  sourceName,
  canWrite,
  onDelete,
}: {
  t: TransactionDTO;
  categories: CategoryDTO[];
  sourceName: string;
  canWrite: boolean;
  onDelete: (t: TransactionDTO) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [e, setE] = useState<EditState>(() => toEdit(t));
  const { save, markPaid, pending } = useTxActions();
  useEffect(() => setE(toEdit(t)), [t]);

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (await save(t, e)) setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-t bg-primary-soft/30">
        <td className="px-3 py-2" colSpan={6}>
          <form
            className="grid grid-cols-[140px_minmax(0,1fr)_200px_140px_auto] items-end gap-2"
            onSubmit={submit}
            onKeyDown={(k) => k.key === 'Escape' && setEditing(false)}
          >
            <Field label="Data" htmlFor={`d-${t.id}`}>
              <Input
                id={`d-${t.id}`}
                type="date"
                value={e.date}
                onChange={(x) => setE({ ...e, date: x.target.value })}
              />
            </Field>
            <Field label="Descrição" htmlFor={`desc-${t.id}`}>
              <Input
                id={`desc-${t.id}`}
                value={e.description}
                onChange={(x) => setE({ ...e, description: x.target.value })}
                autoFocus
              />
            </Field>
            <Field label="Categoria" htmlFor={`c-${t.id}`}>
              <CategorySelect
                id={`c-${t.id}`}
                value={e.categoryId}
                onChange={(v) => setE({ ...e, categoryId: v })}
                categories={categories}
                direction={t.direction}
              />
            </Field>
            <Field label="Valor (R$)" htmlFor={`a-${t.id}`}>
              <Input
                id={`a-${t.id}`}
                inputMode="decimal"
                value={e.amount}
                onChange={(x) => setE({ ...e, amount: x.target.value })}
                className="text-right tnum"
              />
            </Field>
            <div className="flex gap-1 pb-0.5">
              <Button type="submit" size="icon" aria-label="Salvar" disabled={pending}>
                <Check aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Cancelar edição"
                onClick={() => setEditing(false)}
              >
                <X aria-hidden />
              </Button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="group border-t hover:bg-subtle">
      <td className="tnum whitespace-nowrap px-3 py-2.5 text-muted-foreground">{formatDateBR(t.date)}</td>
      <td className="max-w-0 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="truncate text-left font-medium hover:underline disabled:no-underline"
            disabled={!canWrite}
            onClick={() => setEditing(true)}
            title={t.description}
          >
            {t.description}
          </button>
          {t.installmentN ? <Badge tone="outline">{`${t.installmentN}/${t.installmentTotal}`}</Badge> : null}
          {t.status === 'scheduled' ? <Badge tone="accent">agendado</Badge> : null}
          {t.kind === 'transfer' ? <Badge>transferência</Badge> : null}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{t.categoryName ?? '—'}</td>
      <td className="max-w-[160px] truncate whitespace-nowrap px-3 py-2.5 text-muted-foreground">
        {sourceName}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium">
        <Money
          cents={t.amountCents}
          direction={t.direction}
          tone={t.direction === 'in' ? 'positive' : undefined}
        />
      </td>
      <td className="w-[1%] whitespace-nowrap px-2 py-1 text-right">
        {canWrite ? (
          <div className="flex justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {t.status === 'scheduled' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Marcar “${t.description}” como pago`}
                title="Marcar como pago"
                onClick={() => void markPaid(t)}
              >
                <Check aria-hidden />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Editar “${t.description}”`}
              title="Editar"
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Apagar “${t.description}”`}
              title="Apagar"
              onClick={() => onDelete(t)}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function EditSheet({
  t,
  categories,
  onClose,
  onDelete,
}: {
  t: TransactionDTO | null;
  categories: CategoryDTO[];
  onClose: () => void;
  onDelete: (t: TransactionDTO) => void;
}) {
  const [e, setE] = useState<EditState | null>(null);
  const { save, markPaid, pending } = useTxActions();
  const { canWrite } = useWorkspace();
  useEffect(() => setE(t ? toEdit(t) : null), [t]);
  if (!t || !e)
    return (
      <ResponsiveDialog open={false} onOpenChange={() => {}} title="">
        {null}
      </ResponsiveDialog>
    );
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Editar lançamento"
      description={`${formatDateBR(t.date)} · ${formatBRL(t.amountCents)}`}
      footer={
        canWrite ? (
          <>
            <Button variant="outline" onClick={() => onDelete(t)} aria-label="Apagar lançamento">
              <Trash2 aria-hidden /> Apagar
            </Button>
            <Button disabled={pending} onClick={async () => (await save(t, e)) && onClose()}>
              Salvar
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <Field label="Descrição" htmlFor="sheet-desc">
          <Input
            id="sheet-desc"
            value={e.description}
            onChange={(x) => setE({ ...e, description: x.target.value })}
            disabled={!canWrite}
          />
        </Field>
        <Field label="Categoria" htmlFor="sheet-cat">
          <CategorySelect
            id="sheet-cat"
            value={e.categoryId}
            onChange={(v) => setE({ ...e, categoryId: v })}
            categories={categories}
            direction={t.direction}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)" htmlFor="sheet-amount">
            <Input
              id="sheet-amount"
              inputMode="decimal"
              value={e.amount}
              onChange={(x) => setE({ ...e, amount: x.target.value })}
              disabled={!canWrite}
            />
          </Field>
          <Field label="Data" htmlFor="sheet-date">
            <Input
              id="sheet-date"
              type="date"
              value={e.date}
              onChange={(x) => setE({ ...e, date: x.target.value })}
              disabled={!canWrite}
            />
          </Field>
        </div>
        {t.status === 'scheduled' && canWrite ? (
          <Button variant="soft" className="w-full" onClick={async () => (await markPaid(t), onClose())}>
            <Check aria-hidden /> Marcar como pago hoje
          </Button>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

export function TransactionsPage() {
  const { accountId, setAccountId } = useFilters();
  const { canWrite } = useWorkspace();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [status, setStatus] = useState<'' | 'posted' | 'scheduled'>('posted');
  const [offset, setOffset] = useState(0);
  const [sheet, setSheet] = useState<TransactionDTO | null>(null);
  const [toDelete, setToDelete] = useState<TransactionDTO | null>(null);
  const { remove, pending } = useTxActions();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => setOffset(0), [debounced, from, to, category, direction, status, accountId]);

  const filters: TxFilters = {
    q: debounced || undefined,
    from: from || undefined,
    to: to || undefined,
    category: category || undefined,
    direction: direction || undefined,
    status: status || undefined,
    account: accountId ?? undefined,
    limit: PAGE,
    offset,
  };
  const tx = useTransactions(filters);
  const accounts = useAccounts();
  const cards = useCards();
  const cats = useCategories();
  const categories = cats.data ?? [];

  const sourceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts.data ?? []) m.set(a.id, a.name);
    for (const c of cards.data ?? []) m.set(c.id, c.name);
    return (t: TransactionDTO) =>
      t.cardId ? (m.get(t.cardId) ?? 'Cartão') : t.accountId ? (m.get(t.accountId) ?? 'Conta') : '—';
  }, [accounts.data, cards.data]);

  const items = tx.data?.items ?? [];
  const total = tx.data?.total ?? 0;
  const sum = items.reduce((s, t) => s + (t.direction === 'in' ? t.amountCents : -t.amountCents), 0);

  const exportCsv = async () => {
    try {
      const res = await apiFetch('/api/export/transactions.csv');
      downloadBlob(await res.blob(), 'lancamentos.csv');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao exportar.');
    }
  };

  // agrupa por data no celular
  const groups = useMemo(() => {
    const g: Array<{ date: string; items: TransactionDTO[] }> = [];
    for (const t of items) {
      const last = g.at(-1);
      if (last && last.date === t.date) last.items.push(t);
      else g.push({ date: t.date, items: [t] });
    }
    return g;
  }, [items]);

  return (
    <div>
      <PageHeader
        title="Lançamentos"
        description="Clique na descrição para editar. Toda alteração fica no histórico e pode ser desfeita pelo chat (“desfaz”)."
        actions={
          <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
            <Download aria-hidden /> Exportar CSV
          </Button>
        }
      />

      <Card className="mb-4 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-2.5 @min-[520px]:grid-cols-2 @min-[1100px]:grid-cols-[minmax(0,2fr)_repeat(5,minmax(0,1fr))]">
          <div className="relative @min-[520px]:col-span-2 @min-[1100px]:col-span-1">
            <label htmlFor="tx-q" className="sr-only">
              Buscar
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="tx-q"
              type="search"
              placeholder="Buscar descrição…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5 @min-[1100px]:contents">
            <div>
              <label htmlFor="tx-from" className="sr-only">
                De
              </label>
              <Input
                id="tx-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Data inicial"
              />
            </div>
            <div>
              <label htmlFor="tx-to" className="sr-only">
                Até
              </label>
              <Input
                id="tx-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Data final"
              />
            </div>
          </div>
          <Select
            aria-label="Conta"
            value={accountId ?? ''}
            onChange={(e) => setAccountId(e.target.value || null)}
          >
            <option value="">Todas as contas</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Todas as categorias</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-2.5 @min-[700px]:grid-cols-1 @min-[1100px]:contents">
            <Select
              aria-label="Tipo"
              value={direction}
              onChange={(e) => setDirection(e.target.value as '' | 'in' | 'out')}
            >
              <option value="">Todos os tipos</option>
              <option value="in">Entradas</option>
              <option value="out">Saídas</option>
            </Select>
            <Select
              aria-label="Situação"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | 'posted' | 'scheduled')}
              className="@min-[700px]:hidden"
            >
              <option value="posted">Realizados</option>
              <option value="scheduled">Agendados</option>
              <option value="">Todos</option>
            </Select>
          </div>
        </div>
        <div className="mt-2.5 hidden flex-wrap items-center gap-2 @min-[700px]:flex">
          {(['posted', 'scheduled', ''] as const).map((s) => (
            <button
              key={s || 'all'}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className="h-8 rounded-full border px-3 text-[12.5px] text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-foreground"
            >
              {s === 'posted' ? 'Realizados' : s === 'scheduled' ? 'Agendados' : 'Todos'}
            </button>
          ))}
          <span className="ml-auto text-[12.5px] text-muted-foreground">
            {total} {total === 1 ? 'lançamento' : 'lançamentos'} · saldo da página{' '}
            <Money cents={sum} tone="auto" signed className="font-medium" />
          </span>
        </div>
      </Card>

      {tx.error ? <ErrorState error={tx.error} onRetry={() => void tx.refetch()} /> : null}

      {tx.isPending ? (
        <Card className="space-y-3 p-4" aria-busy="true" aria-label="Carregando lançamentos">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </Card>
      ) : items.length === 0 && !tx.error ? (
        <EmptyState
          title="Nenhum lançamento encontrado"
          hint={
            debounced || category || from || to
              ? 'Ajuste os filtros acima.'
              : 'Lance pelo chat — é mais rápido.'
          }
          prompt="paguei 230 de luz no BB hoje"
        />
      ) : (
        <>
          {/* Desktop/tablet: tabela com edição inline */}
          <Card className={cn('hidden overflow-hidden @min-[700px]:block', tx.isFetching && 'opacity-80')}>
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-[13.5px]" data-testid="tx-table">
                <caption className="sr-only">Lançamentos</caption>
                <colgroup>
                  <col className="w-[100px]" />
                  <col />
                  <col className="w-[140px]" />
                  <col className="w-[130px]" />
                  <col className="w-[124px]" />
                  <col className="w-[112px]" />
                </colgroup>
                <thead className="bg-subtle text-[12px] text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">
                      Data
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">
                      Descrição
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">
                      Categoria
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">
                      Conta/cartão
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">
                      Valor
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <TxRow
                      key={t.id}
                      t={t}
                      categories={categories}
                      sourceName={sourceName(t)}
                      canWrite={canWrite}
                      onDelete={setToDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Celular: lista de cards agrupada por dia */}
          <div className="space-y-4 @min-[700px]:hidden" data-testid="tx-list">
            {groups.map((g) => (
              <section key={g.date} aria-label={formatDateBR(g.date)}>
                <h2 className="tnum mb-1.5 px-1 text-[12px] font-medium text-muted-foreground">
                  {formatDateBR(g.date)}
                </h2>
                <Card className="divide-y overflow-hidden">
                  {g.items.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSheet(t)}
                      className="flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-muted"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{t.description}</p>
                        <p className="flex items-center gap-1 truncate text-[12px] text-muted-foreground">
                          <span className="truncate">
                            {[t.categoryName, sourceName(t)].filter(Boolean).join(' · ')}
                          </span>
                          {t.installmentN ? (
                            <Badge tone="outline">{`${t.installmentN}/${t.installmentTotal}`}</Badge>
                          ) : null}
                          {t.status === 'scheduled' ? <Badge tone="accent">agendado</Badge> : null}
                        </p>
                      </div>
                      <Money
                        cents={t.amountCents}
                        direction={t.direction}
                        tone={t.direction === 'in' ? 'positive' : undefined}
                        className="shrink-0 text-[14px] font-semibold"
                      />
                    </button>
                  ))}
                </Card>
              </section>
            ))}
          </div>

          {total > PAGE ? (
            <nav aria-label="Paginação" className="mt-4 flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                <ChevronLeft aria-hidden /> Anteriores
              </Button>
              <span className="tnum text-[12.5px] text-muted-foreground">
                {offset + 1}–{Math.min(offset + PAGE, total)} de {total}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Próximos <ChevronRight aria-hidden />
              </Button>
            </nav>
          ) : null}
        </>
      )}

      <EditSheet
        t={sheet}
        categories={categories}
        onClose={() => setSheet(null)}
        onDelete={(t) => setToDelete(t)}
      />
      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Apagar lançamento?"
        description={
          toDelete
            ? `${toDelete.description} · ${formatBRL(toDelete.amountCents)} em ${formatDateBR(toDelete.date)}. Dá para desfazer pelo chat.`
            : undefined
        }
        confirmLabel="Apagar"
        danger
        busy={pending}
        onConfirm={async () => {
          if (toDelete && (await remove([toDelete.id]))) {
            setToDelete(null);
            setSheet(null);
          }
        }}
      />
    </div>
  );
}
