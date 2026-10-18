import { useEffect, useState } from 'react';
import { Ban, CalendarDays, Check, MoreVertical, Pencil, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  formatBRL,
  formatDateBR,
  monthLabel,
  MONTHS_SHORT,
  parseAmount,
  type SeasonalItemDTO,
  type SeasonalOccurrenceDTO,
  type SeasonalScheduleEntry,
} from '@sf/shared';
import { api } from '@/lib/api';
import { useAction, useCalendar, useInvalidateWorkspace } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/tabs';
import { Money } from '@/components/common/money';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';

const total = (s: SeasonalScheduleEntry[]) => s.reduce((a, e) => a + e.amountCents, 0);

function scheduleText(item: Pick<SeasonalItemDTO, 'kind' | 'schedule' | 'adjustmentPct'>): string {
  const s = item.schedule;
  if (item.kind === 'adjustment')
    return `+${item.adjustmentPct?.toLocaleString('pt-BR')}% em ${MONTHS_SHORT[s[0]!.month - 1]} · +${formatBRL(s[0]!.amountCents)}/mês`;
  if (item.kind === 'info') return s.map((e) => MONTHS_SHORT[e.month - 1]).join(' e ');
  if (s.length === 1)
    return `${formatBRL(s[0]!.amountCents)} em cota única (${String(s[0]!.day).padStart(2, '0')}/${MONTHS_SHORT[s[0]!.month - 1]})`;
  return `${formatBRL(total(s))} em ${s.length} parcelas (${s.map((e) => MONTHS_SHORT[e.month - 1]).join(', ')})`;
}

function evidenceText(item: SeasonalItemDTO): string | null {
  if (item.confidence === 'estimado') return 'Estimado pelo seu salário';
  if (!item.evidence.length) return null;
  return item.evidence
    .map((e) =>
      item.kind === 'adjustment'
        ? `${MONTHS_SHORT[e.months[0]! - 1]}/${e.year}: +${e.totalCents.toLocaleString('pt-BR')}%`
        : `${e.year}: ${formatBRL(e.totalCents)}`,
    )
    .join(' · ');
}

function StatusBadge({ o }: { o: Pick<SeasonalOccurrenceDTO, 'paid' | 'kind' | 'status' | 'confidence'> }) {
  if (o.paid) return <Badge tone="positive">pago</Badge>;
  if (o.kind === 'info') return <Badge tone="outline">informativo</Badge>;
  if (o.status === 'confirmed') return <Badge tone="accent">na projeção</Badge>;
  return <Badge tone="warning">{o.confidence === 'estimado' ? 'estimado' : 'sugerido'}</Badge>;
}

/** Agenda em N parcelas mensais seguidas. */
function buildSchedule(totalCents: number, month: number, day: number, n: number): SeasonalScheduleEntry[] {
  const base = Math.floor(totalCents / n);
  return Array.from({ length: n }, (_, i) => ({
    month: ((month - 1 + i) % 12) + 1,
    day,
    amountCents: i === 0 ? base + (totalCents - base * n) : base,
  }));
}

function ItemForm({
  item,
  open,
  onClose,
}: {
  item: SeasonalItemDTO | null;
  open: boolean;
  onClose: () => void;
}) {
  const action = useAction();
  const blank = { label: '', direction: 'out' as 'in' | 'out', amount: '', month: '1', day: '10', n: '1' };
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (!open) return;
    if (item) {
      const s = item.schedule;
      setF({
        label: item.label,
        direction: item.direction ?? 'out',
        amount: (total(s) / 100).toFixed(2).replace('.', ','),
        month: String(s[0]?.month ?? 1),
        day: String(s[0]?.day ?? 10),
        n: String(s.length || 1),
      });
    } else setF(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);
  const cents = parseAmount(f.amount);
  const day = Number(f.day);
  const n = Number(f.n);
  const valid = (item || f.label.trim()) && cents && cents > 0 && day >= 1 && day <= 31 && n >= 1 && n <= 12;
  const submit = async () => {
    if (!valid) return;
    const schedule = buildSchedule(cents!, Number(f.month), day, n);
    try {
      const r = await action.mutateAsync({
        kind: 'seasonal',
        payload: item
          ? { mode: 'edit', id: item.id, fields: { schedule } }
          : { mode: 'create', fields: { label: f.label.trim(), direction: f.direction, schedule } },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.');
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={item ? `Ajustar ${item.label}` : 'Novo item anual'}
      description={
        item
          ? 'O valor ajustado entra na projeção e vale até os pagamentos reais deste ano aparecerem.'
          : 'Pelo chat: “todo março pago 980 de anuidade da OAB”.'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Salvar e incluir na projeção
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        {item ? null : (
          <>
            <div className="col-span-2">
              <Segmented
                label="Tipo"
                value={f.direction}
                onChange={(v) => setF({ ...f, direction: v })}
                options={[
                  { value: 'out', label: 'Despesa' },
                  { value: 'in', label: 'Receita' },
                ]}
              />
            </div>
            <Field label="Nome" htmlFor="sea-label" className="col-span-2">
              <Input
                id="sea-label"
                value={f.label}
                onChange={(e) => setF({ ...f, label: e.target.value })}
                placeholder="Ex.: Anuidade OAB"
              />
            </Field>
          </>
        )}
        <Field label="Total no ano (R$)" htmlFor="sea-amount">
          <Input
            id="sea-amount"
            inputMode="decimal"
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
        <Field label="Parcelas" htmlFor="sea-n">
          <Input
            id="sea-n"
            type="number"
            min={1}
            max={12}
            value={f.n}
            onChange={(e) => setF({ ...f, n: e.target.value })}
          />
        </Field>
        <Field label={Number(f.n) > 1 ? 'Mês da 1ª parcela' : 'Mês'} htmlFor="sea-month">
          <Select id="sea-month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })}>
            {MONTHS_SHORT.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Dia" htmlFor="sea-day">
          <Input
            id="sea-day"
            type="number"
            min={1}
            max={31}
            value={f.day}
            onChange={(e) => setF({ ...f, day: e.target.value })}
          />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}

function ItemActions({ item, onEdit }: { item: SeasonalItemDTO; onEdit: (i: SeasonalItemDTO) => void }) {
  const action = useAction();
  const run = async (mode: 'confirm' | 'dismiss') => {
    try {
      const r = await action.mutateAsync({ kind: 'seasonal', payload: { mode, id: item.id, fields: {} } });
      toast.success(r.summary, { description: r.impact ?? undefined });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  if (item.kind === 'info') return null;
  const editable = item.kind !== 'adjustment';
  return (
    <div className="flex shrink-0 items-center gap-1">
      {item.status !== 'confirmed' ? (
        <Button size="sm" variant="outline" onClick={() => void run('confirm')} disabled={action.isPending}>
          <Check aria-hidden /> {item.status === 'dismissed' ? 'Reativar' : 'Confirmar'}
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Ações de ${item.label}`}>
            <MoreVertical aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {editable ? (
            <MenuItem onSelect={() => onEdit(item)}>
              <Pencil aria-hidden /> Ajustar valor
            </MenuItem>
          ) : null}
          {item.status !== 'dismissed' ? (
            <MenuItem onSelect={() => void run('dismiss')} className="text-negative">
              <Ban aria-hidden /> Ignorar
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
}

export function CalendarPage() {
  const q = useCalendar(12);
  const { canWrite } = useWorkspace();
  const invalidate = useInvalidateWorkspace();
  const [form, setForm] = useState<{ open: boolean; item: SeasonalItemDTO | null }>({
    open: false,
    item: null,
  });
  const [detecting, setDetecting] = useState(false);
  const items = q.data?.items ?? [];
  const occ = q.data?.occurrences ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const toConfirm = items.filter((i) => i.status === 'suggested');
  const dismissed = items.filter((i) => i.status === 'dismissed');
  const months = [...new Set(occ.map((o) => o.date.slice(0, 7)))];

  const detect = async () => {
    setDetecting(true);
    try {
      const r = await api<{ created: number }>('/api/calendar/detect', { method: 'POST' });
      toast.success(r.created ? `${r.created} item(ns) novo(s) no calendário.` : 'Nada novo no histórico.');
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Calendário anual"
        description="IPVA, IPTU, matrícula, 13º e reajustes aprendidos do seu histórico. Só entram na projeção depois que você confirma."
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void detect()} disabled={detecting}>
                <RefreshCw aria-hidden className={detecting ? 'animate-spin' : undefined} /> Reanalisar
              </Button>
              <Button size="sm" onClick={() => setForm({ open: true, item: null })}>
                <Plus aria-hidden /> Adicionar
              </Button>
            </div>
          ) : null
        }
      />
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nenhum gasto anual encontrado"
          icon={<CalendarDays className="size-5" />}
          hint="Com pelo menos um ano de lançamentos, IPVA, IPTU, matrícula e seguros aparecem aqui sozinhos."
          prompt="todo janeiro pago 2.300 de IPVA em 3 parcelas"
        />
      ) : (
        <div className="space-y-6">
          {toConfirm.length ? (
            <section aria-labelledby="sea-confirm">
              <h2 id="sea-confirm" className="mb-2 text-[13px] font-semibold text-muted-foreground">
                A confirmar ({toConfirm.length})
              </h2>
              <Card className="divide-y overflow-hidden">
                {toConfirm.map((i) => (
                  <div key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium">
                        <span className="truncate">{i.label}</span>
                        {i.confidence === 'estimado' ? <Badge tone="warning">estimado</Badge> : null}
                        {i.confidence === 'media' ? <Badge tone="outline">1 ano de histórico</Badge> : null}
                      </p>
                      <p className="text-[12.5px] text-muted-foreground">{scheduleText(i)}</p>
                      {evidenceText(i) ? (
                        <p className="text-[12.5px] text-muted-foreground">{evidenceText(i)}</p>
                      ) : null}
                    </div>
                    {canWrite ? (
                      <ItemActions item={i} onEdit={(it) => setForm({ open: true, item: it })} />
                    ) : null}
                  </div>
                ))}
              </Card>
            </section>
          ) : null}

          <section aria-labelledby="sea-next">
            <h2 id="sea-next" className="mb-2 text-[13px] font-semibold text-muted-foreground">
              Próximos 12 meses
            </h2>
            {months.length ? (
              <div className="grid gap-3 @min-[880px]:grid-cols-2">
                {months.map((m) => {
                  const list = occ.filter((o) => o.date.startsWith(m));
                  const out = list
                    .filter((o) => o.direction === 'out' && !o.paid && o.kind !== 'info')
                    .reduce((s, o) => s + o.amountCents, 0);
                  return (
                    <Card key={m} className="overflow-hidden">
                      <div className="flex items-baseline justify-between border-b px-4 py-2.5">
                        <h3 className="text-[14px] font-semibold first-letter:uppercase">
                          {monthLabel(`${m}-01`, true)}
                        </h3>
                        {out ? (
                          <span className="text-[12.5px] text-muted-foreground">
                            saídas <Money cents={out} className="font-medium text-foreground" />
                          </span>
                        ) : null}
                      </div>
                      <ul className="divide-y">
                        {list.map((o) => {
                          const item = byId.get(o.itemId);
                          return (
                            <li key={`${o.itemId}-${o.date}`} className="flex items-center gap-3 px-4 py-2.5">
                              <span className="w-11 shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                                {formatDateBR(o.date).slice(0, 5)}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-1.5 text-[13.5px]">
                                  <span className="truncate">
                                    {o.label}
                                    {o.installment ? ` (${o.installment.n}/${o.installment.total})` : ''}
                                  </span>
                                  <StatusBadge o={o} />
                                </p>
                              </div>
                              {o.kind === 'info' ? null : (
                                <span className="shrink-0 text-[13.5px] font-medium">
                                  {o.kind === 'adjustment' ? '+' : ''}
                                  <Money
                                    cents={o.amountCents}
                                    direction={o.direction ?? undefined}
                                    tone={o.direction === 'in' ? 'positive' : o.paid ? 'muted' : undefined}
                                  />
                                  {o.kind === 'adjustment' ? '/mês' : ''}
                                </span>
                              )}
                              {canWrite && item && item.status === 'confirmed' ? (
                                <ItemActions item={item} onEdit={(it) => setForm({ open: true, item: it })} />
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card className="p-4 text-[13px] text-muted-foreground">
                Nada previsto nos próximos 12 meses.
              </Card>
            )}
          </section>

          {dismissed.length ? (
            <section aria-labelledby="sea-dismissed">
              <h2 id="sea-dismissed" className="mb-2 text-[13px] font-semibold text-muted-foreground">
                Ignorados
              </h2>
              <Card className="divide-y overflow-hidden">
                {dismissed.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] text-muted-foreground">{i.label}</p>
                      <p className="text-[12.5px] text-muted-foreground">{scheduleText(i)}</p>
                    </div>
                    {canWrite ? (
                      <ItemActions item={i} onEdit={(it) => setForm({ open: true, item: it })} />
                    ) : null}
                  </div>
                ))}
              </Card>
            </section>
          ) : null}
        </div>
      )}
      <ItemForm open={form.open} item={form.item} onClose={() => setForm({ open: false, item: null })} />
    </div>
  );
}
