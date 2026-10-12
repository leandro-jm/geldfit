import { useEffect, useState } from 'react';
import { CalendarClock, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatDateBR, parseAmount, type RecurrenceDTO } from '@sf/shared';
import { useAccounts, useAction, useCards, useCategories, useRecurrences } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { todayLocalISO } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog, ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/tabs';
import { Money } from '@/components/common/money';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';

const DAYS = [
  ['MO', 'seg'],
  ['TU', 'ter'],
  ['WE', 'qua'],
  ['TH', 'qui'],
  ['FR', 'sex'],
  ['SA', 'sáb'],
  ['SU', 'dom'],
] as const;

type Freq = 'MONTHLY' | 'WEEKLY' | 'YEARLY';

function parseRule(rule: string): { freq: Freq; day: string; days: string[]; month: string } {
  const p = Object.fromEntries(
    rule
      .replace(/^RRULE:/, '')
      .split(';')
      .filter(Boolean)
      .map((x) => x.split('=') as [string, string]),
  );
  return {
    freq: (p.FREQ as Freq) ?? 'MONTHLY',
    day: p.BYMONTHDAY ?? '5',
    days: p.BYDAY ? p.BYDAY.split(',') : ['MO'],
    month: p.BYMONTH ?? '1',
  };
}

function buildRule(f: { freq: Freq; day: string; days: string[]; month: string }): string {
  if (f.freq === 'WEEKLY') return `FREQ=WEEKLY;BYDAY=${(f.days.length ? f.days : ['MO']).join(',')}`;
  if (f.freq === 'YEARLY') return `FREQ=YEARLY;BYMONTH=${f.month};BYMONTHDAY=${f.day}`;
  return `FREQ=MONTHLY;BYMONTHDAY=${f.day}`;
}

function RecurrenceForm({
  rec,
  open,
  onClose,
}: {
  rec: RecurrenceDTO | null;
  open: boolean;
  onClose: () => void;
}) {
  const action = useAction();
  const accounts = useAccounts();
  const cards = useCards();
  const cats = useCategories();
  const blank = {
    description: '',
    direction: 'out' as 'in' | 'out',
    amount: '',
    source: '',
    categoryId: '',
    freq: 'MONTHLY' as Freq,
    day: '5',
    days: ['MO'],
    month: '1',
    startDate: todayLocalISO(),
    endDate: '',
    isBill: true,
    autoPost: false,
  };
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (!open) return;
    if (rec) {
      const r = parseRule(rec.rule);
      setF({
        description: rec.description,
        direction: rec.direction,
        amount: (rec.amountCents / 100).toFixed(2).replace('.', ','),
        source: rec.cardId ? `card:${rec.cardId}` : rec.accountId ? `acc:${rec.accountId}` : '',
        categoryId: rec.categoryId ?? '',
        ...r,
        startDate: rec.startDate,
        endDate: rec.endDate ?? '',
        isBill: rec.isBill,
        autoPost: rec.autoPost,
      });
    } else setF({ ...blank, source: accounts.data?.[0] ? `acc:${accounts.data[0].id}` : '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rec]);
  const cents = parseAmount(f.amount);
  const day = Number(f.day);
  const valid =
    f.description.trim() && cents && cents > 0 && (f.freq === 'WEEKLY' || (day >= 1 && day <= 31));
  const submit = async () => {
    if (!valid) return;
    const [kind, id] = f.source.split(':');
    try {
      const r = await action.mutateAsync({
        kind: 'recurrence',
        payload: {
          mode: rec ? 'update' : 'create',
          id: rec?.id ?? null,
          fields: {
            description: f.description.trim(),
            amountCents: cents,
            direction: f.direction,
            accountId: kind === 'acc' ? id : null,
            cardId: kind === 'card' ? id : null,
            categoryId: f.categoryId || null,
            rule: buildRule(f),
            startDate: f.startDate,
            endDate: f.endDate || null,
            amountMode: 'fixed',
            autoPost: f.autoPost,
            isBill: f.isBill,
          },
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.');
    }
  };
  const catList = (cats.data ?? []).filter((c) => c.kind === (f.direction === 'in' ? 'income' : 'expense'));
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={rec ? 'Editar recorrência' : 'Nova recorrência'}
      description="Pelo chat: “todo dia 5 entra 8.500 de salário no BB”."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Segmented
            label="Tipo"
            value={f.direction}
            onChange={(v) => setF({ ...f, direction: v, categoryId: '' })}
            options={[
              { value: 'out', label: 'Saída' },
              { value: 'in', label: 'Entrada' },
            ]}
          />
        </div>
        <Field label="Descrição" htmlFor="rec-desc" className="col-span-2">
          <Input
            id="rec-desc"
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder="Ex.: Aluguel"
          />
        </Field>
        <Field label="Valor (R$)" htmlFor="rec-amount">
          <Input
            id="rec-amount"
            inputMode="decimal"
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
        <Field label="Conta ou cartão" htmlFor="rec-src">
          <Select id="rec-src" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="">—</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={`acc:${a.id}`}>
                {a.name}
              </option>
            ))}
            {(cards.data ?? []).map((c) => (
              <option key={c.id} value={`card:${c.id}`}>
                Cartão {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria" htmlFor="rec-cat" className="col-span-2 sm:col-span-1">
          <Select
            id="rec-cat"
            value={f.categoryId}
            onChange={(e) => setF({ ...f, categoryId: e.target.value })}
          >
            <option value="">Sem categoria</option>
            {catList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Frequência" htmlFor="rec-freq" className="col-span-2 sm:col-span-1">
          <Select id="rec-freq" value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value as Freq })}>
            <option value="MONTHLY">Mensal</option>
            <option value="WEEKLY">Semanal</option>
            <option value="YEARLY">Anual</option>
          </Select>
        </Field>
        {f.freq === 'WEEKLY' ? (
          <fieldset className="col-span-2">
            <legend className="mb-1.5 text-[13px] font-medium">Dias da semana</legend>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([code, label]) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={f.days.includes(code)}
                  onClick={() =>
                    setF({
                      ...f,
                      days: f.days.includes(code) ? f.days.filter((d) => d !== code) : [...f.days, code],
                    })
                  }
                  className="h-10 min-w-11 rounded-lg border px-2 text-[13px] aria-pressed:border-primary aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-foreground"
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : (
          <>
            {f.freq === 'YEARLY' ? (
              <Field label="Mês" htmlFor="rec-month">
                <Select
                  id="rec-month"
                  value={f.month}
                  onChange={(e) => setF({ ...f, month: e.target.value })}
                >
                  {['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'].map(
                    (m, i) => (
                      <option key={m} value={String(i + 1)}>
                        {m}
                      </option>
                    ),
                  )}
                </Select>
              </Field>
            ) : null}
            <Field label="Dia do mês" htmlFor="rec-day">
              <Input
                id="rec-day"
                type="number"
                min={1}
                max={31}
                value={f.day}
                onChange={(e) => setF({ ...f, day: e.target.value })}
              />
            </Field>
          </>
        )}
        <Field label="Início" htmlFor="rec-start">
          <Input
            id="rec-start"
            type="date"
            value={f.startDate}
            onChange={(e) => setF({ ...f, startDate: e.target.value })}
          />
        </Field>
        <Field label="Fim (opcional)" htmlFor="rec-end">
          <Input
            id="rec-end"
            type="date"
            value={f.endDate}
            onChange={(e) => setF({ ...f, endDate: e.target.value })}
          />
        </Field>
        <div className="col-span-2 space-y-2 rounded-xl border p-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="rec-bill" className="text-[13px]">
              <span className="font-medium">É uma conta a pagar</span>
              <span className="block text-muted-foreground">Gera lembrete de vencimento.</span>
            </label>
            <Switch id="rec-bill" checked={f.isBill} onCheckedChange={(v) => setF({ ...f, isBill: v })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="rec-auto" className="text-[13px]">
              <span className="font-medium">Lançar automaticamente</span>
              <span className="block text-muted-foreground">
                Marca como realizado na data, sem confirmação.
              </span>
            </label>
            <Switch id="rec-auto" checked={f.autoPost} onCheckedChange={(v) => setF({ ...f, autoPost: v })} />
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

export function RecurrencesPage() {
  const q = useRecurrences();
  const accounts = useAccounts();
  const cards = useCards();
  const action = useAction();
  const { canWrite } = useWorkspace();
  const [form, setForm] = useState<{ open: boolean; rec: RecurrenceDTO | null }>({ open: false, rec: null });
  const [del, setDel] = useState<RecurrenceDTO | null>(null);
  const name = (r: RecurrenceDTO) =>
    (r.cardId
      ? cards.data?.find((c) => c.id === r.cardId)?.name
      : accounts.data?.find((a) => a.id === r.accountId)?.name) ?? '—';
  const list = q.data ?? [];
  const monthlyIn = list
    .filter((r) => r.direction === 'in' && r.rule.includes('MONTHLY') && !r.pausedAt)
    .reduce((s, r) => s + r.amountCents, 0);
  const monthlyOut = list
    .filter((r) => r.direction === 'out' && r.rule.includes('MONTHLY') && !r.pausedAt)
    .reduce((s, r) => s + r.amountCents, 0);

  return (
    <div>
      <PageHeader
        title="Recorrências"
        description="Salário, aluguel, assinaturas — entram na projeção automaticamente."
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setForm({ open: true, rec: null })}>
              <Plus aria-hidden /> Nova recorrência
            </Button>
          ) : null
        }
      />
      {list.length ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Entradas mensais</p>
            <Money cents={monthlyIn} tone="positive" className="mt-1 block text-lg font-semibold" />
          </Card>
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Saídas mensais</p>
            <Money cents={monthlyOut} className="mt-1 block text-lg font-semibold" />
          </Card>
        </div>
      ) : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : list.length === 0 ? (
        <EmptyState
          title="Nenhuma recorrência"
          icon={<CalendarClock className="size-5" />}
          hint="Cadastre sua renda e contas fixas para a projeção ficar realista."
          prompt="todo dia 5 entra 8.500 de salário no BB"
        />
      ) : (
        <Card className="divide-y overflow-hidden">
          {list.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium">
                  <span className="truncate">{r.description}</span>
                  {r.isBill ? <Badge tone="outline">conta</Badge> : null}
                  {r.pausedAt ? <Badge tone="warning">pausada</Badge> : null}
                </p>
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {r.ruleText} · {name(r)}
                  {r.nextDate ? ` · próxima ${formatDateBR(r.nextDate)}` : ''}
                  {r.endDate ? ` · até ${formatDateBR(r.endDate)}` : ''}
                </p>
              </div>
              <Money
                cents={r.amountCents}
                direction={r.direction}
                tone={r.direction === 'in' ? 'positive' : undefined}
                className="shrink-0 text-[14px] font-semibold"
              />
              {canWrite ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Ações de ${r.description}`}>
                      <MoreVertical aria-hidden />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => setForm({ open: true, rec: r })}>
                      <Pencil aria-hidden /> Editar
                    </MenuItem>
                    <MenuItem onSelect={() => setDel(r)} className="text-negative">
                      <Trash2 aria-hidden /> Excluir
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : null}
            </div>
          ))}
        </Card>
      )}
      <RecurrenceForm open={form.open} rec={form.rec} onClose={() => setForm({ open: false, rec: null })} />
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Excluir “${del?.description ?? ''}”?`}
        description="As ocorrências futuras saem da projeção."
        confirmLabel="Excluir"
        danger
        busy={action.isPending}
        onConfirm={async () => {
          if (!del) return;
          try {
            const r = await action.mutateAsync({
              kind: 'delete',
              payload: { entity: 'recurrences', ids: [del.id] },
            });
            toast.success(r.summary, { description: r.impact ?? undefined });
            setDel(null);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Falhou.');
          }
        }}
      />
    </div>
  );
}
