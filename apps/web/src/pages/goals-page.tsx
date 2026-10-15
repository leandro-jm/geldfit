import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Goal, MoreVertical, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  formatBRL,
  formatDateBR,
  goalPlan,
  monthLabel,
  parseAmount,
  startOfMonth,
  type GoalPlan,
} from '@sf/shared';
import { useAction, useBudgets, useCategories, useCategorySpend, useGoals } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { todayLocalISO } from '@/lib/utils';
import type { BudgetRow, GoalRow } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog, ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Meter } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { EmptyState, PageHeader } from '@/components/common/states';

const GOAL_KIND = {
  emergency: 'Reserva de emergência',
  travel: 'Viagem',
  purchase: 'Compra',
  other: 'Outra',
} as const;
const toInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

function GoalForm({ goal, open, onClose }: { goal: GoalRow | null; open: boolean; onClose: () => void }) {
  const action = useAction();
  const [f, setF] = useState({
    name: '',
    kind: 'other' as GoalRow['kind'],
    target: '',
    saved: '0',
    monthly: '0',
    startMonth: startOfMonth(todayLocalISO()),
    targetDate: '',
  });
  useEffect(() => {
    if (!open) return;
    setF(
      goal
        ? {
            name: goal.name,
            kind: goal.kind,
            target: toInput(goal.targetCents),
            saved: toInput(goal.savedCents),
            monthly: toInput(goal.monthlyContributionCents),
            startMonth: goal.startMonth,
            targetDate: goal.targetDate ?? '',
          }
        : {
            name: '',
            kind: 'other',
            target: '',
            saved: '0',
            monthly: '0',
            startMonth: startOfMonth(todayLocalISO()),
            targetDate: '',
          },
    );
  }, [open, goal]);
  const target = parseAmount(f.target);
  const saved = parseAmount(f.saved || '0') ?? 0;
  const monthly = parseAmount(f.monthly || '0') ?? 0;
  const valid = f.name.trim() && target && target > 0;
  const formPlan =
    target && f.targetDate
      ? goalPlan(
          {
            targetCents: target,
            savedCents: saved,
            monthlyContributionCents: monthly,
            startMonth: startOfMonth(f.startMonth || todayLocalISO()),
            targetDate: f.targetDate,
          },
          todayLocalISO(),
        )
      : null;
  const submit = async () => {
    if (!valid) return;
    try {
      const r = await action.mutateAsync({
        kind: 'goal',
        payload: {
          mode: goal ? 'update' : 'create',
          id: goal?.id ?? null,
          fields: {
            name: f.name.trim(),
            kind: f.kind,
            targetCents: target,
            savedCents: saved,
            monthlyContributionCents: monthly,
            startMonth: startOfMonth(f.startMonth),
            targetDate: f.targetDate || null,
          },
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={goal ? 'Editar meta' : 'Nova meta'}
      description="O aporte mensal entra como saída na projeção."
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
        <Field label="Nome" htmlFor="g-name" className="col-span-2">
          <Input
            id="g-name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="Ex.: Viagem para o Chile"
          />
        </Field>
        <Field label="Tipo" htmlFor="g-kind" className="col-span-2 sm:col-span-1">
          <Select
            id="g-kind"
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as GoalRow['kind'] })}
          >
            {Object.entries(GOAL_KIND).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Valor alvo (R$)" htmlFor="g-target" className="col-span-2 sm:col-span-1">
          <Input
            id="g-target"
            inputMode="decimal"
            value={f.target}
            onChange={(e) => setF({ ...f, target: e.target.value })}
          />
        </Field>
        <Field label="Já guardado (R$)" htmlFor="g-saved">
          <Input
            id="g-saved"
            inputMode="decimal"
            value={f.saved}
            onChange={(e) => setF({ ...f, saved: e.target.value })}
          />
        </Field>
        <Field
          label="Aporte mensal (R$)"
          htmlFor="g-monthly"
          hint={
            formPlan?.recommendedMonthlyCents ? (
              formPlan.status === 'on_track' ? (
                <span className="text-positive">Chega no prazo.</span>
              ) : (
                <button
                  type="button"
                  className="text-left font-medium text-primary hover:underline"
                  onClick={() => setF({ ...f, monthly: toInput(formPlan.recommendedMonthlyCents!) })}
                >
                  Para o prazo: {formatBRL(formPlan.recommendedMonthlyCents)}/mês (usar)
                </button>
              )
            ) : formPlan?.status === 'overdue' ? (
              <span className="text-negative">A data alvo já passou.</span>
            ) : undefined
          }
        >
          <Input
            id="g-monthly"
            inputMode="decimal"
            value={f.monthly}
            onChange={(e) => setF({ ...f, monthly: e.target.value })}
          />
        </Field>
        <Field label="Início" htmlFor="g-start">
          <Input
            id="g-start"
            type="date"
            value={f.startMonth}
            onChange={(e) => setF({ ...f, startMonth: e.target.value })}
          />
        </Field>
        <Field label="Data alvo" htmlFor="g-date">
          <Input
            id="g-date"
            type="date"
            value={f.targetDate}
            onChange={(e) => setF({ ...f, targetDate: e.target.value })}
          />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}

function BudgetForm({
  budget,
  open,
  onClose,
}: {
  budget: BudgetRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const action = useAction();
  const cats = useCategories();
  const [f, setF] = useState({ categoryId: '', amount: '', alertPct: '100' });
  useEffect(() => {
    if (!open) return;
    setF(
      budget
        ? {
            categoryId: budget.categoryId,
            amount: toInput(budget.amountCents),
            alertPct: String(budget.alertPct),
          }
        : { categoryId: '', amount: '', alertPct: '80' },
    );
  }, [open, budget]);
  const cents = parseAmount(f.amount);
  const valid = f.categoryId && cents && cents > 0;
  const submit = async () => {
    if (!valid) return;
    try {
      const r = await action.mutateAsync({
        kind: 'budget',
        payload: {
          categoryId: f.categoryId,
          amountCents: cents,
          alertPct: Math.min(200, Math.max(1, Number(f.alertPct) || 100)),
        },
      });
      toast.success(r.summary);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={budget ? 'Editar orçamento' : 'Novo orçamento'}
      description="Limite mensal por categoria. Avisamos quando o gasto passar do percentual de alerta."
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
        <Field label="Categoria" htmlFor="b-cat" className="col-span-2">
          <Select
            id="b-cat"
            value={f.categoryId}
            onChange={(e) => setF({ ...f, categoryId: e.target.value })}
            disabled={Boolean(budget)}
          >
            <option value="">Escolha…</option>
            {(cats.data ?? [])
              .filter((c) => c.kind === 'expense')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Limite mensal (R$)" htmlFor="b-amount">
          <Input
            id="b-amount"
            inputMode="decimal"
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
        <Field label="Alertar em (%)" htmlFor="b-alert">
          <Input
            id="b-alert"
            type="number"
            min={1}
            max={200}
            value={f.alertPct}
            onChange={(e) => setF({ ...f, alertPct: e.target.value })}
          />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}

/** Aporte recomendado para cumprir o prazo, ou confirmação de que o ritmo atual chega lá. */
function GoalAdvice({
  goal,
  plan,
  canWrite,
  onApply,
  busy,
}: {
  goal: GoalRow;
  plan: GoalPlan;
  canWrite: boolean;
  onApply: (cents: number) => void;
  busy: boolean;
}) {
  if (plan.status === 'behind') {
    const n = plan.contributionsLeft!;
    return (
      <div className="mt-3 rounded-xl bg-warning-soft px-3 py-2.5 text-[12.5px]" data-testid="goal-advice">
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Para chegar até {formatDateBR(goal.targetDate!)}, aporte{' '}
            <Money cents={plan.recommendedMonthlyCents!} className="font-semibold" />
            /mês ({n} {n === 1 ? 'aporte' : 'aportes'}
            {goal.monthlyContributionCents > 0 ? (
              <>
                , <Money cents={plan.recommendedMonthlyCents! - goal.monthlyContributionCents} /> a mais
              </>
            ) : null}
            ).
          </span>
        </p>
        {canWrite ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 bg-card"
            disabled={busy}
            onClick={() => onApply(plan.recommendedMonthlyCents!)}
          >
            Usar{' '}
            <span>
              <Money cents={plan.recommendedMonthlyCents!} />
              /mês
            </span>
          </Button>
        ) : null}
      </div>
    );
  }
  if (plan.status === 'on_track' && plan.finishMonth)
    return (
      <p className="mt-2 flex items-center gap-1 text-[12px] text-positive" data-testid="goal-advice">
        <Check className="size-3.5" aria-hidden /> Em dia: conclui em {monthLabel(plan.finishMonth, true)},
        dentro do prazo.
      </p>
    );
  if (plan.status === 'overdue')
    return (
      <p className="mt-2 flex items-center gap-1 text-[12px] text-negative" data-testid="goal-advice">
        <AlertTriangle className="size-3.5" aria-hidden /> O prazo passou e faltam{' '}
        <Money cents={plan.remainingCents} />. Ajuste a data alvo.
      </p>
    );
  if (plan.status === 'no_date' && goal.monthlyContributionCents === 0)
    return (
      <p className="mt-2 text-[12px] text-muted-foreground" data-testid="goal-advice">
        Defina uma data alvo para ver o aporte mensal recomendado.
      </p>
    );
  return null;
}

export function GoalsPage() {
  const goals = useGoals();
  const budgets = useBudgets();
  const spend = useCategorySpend();
  const action = useAction();
  const { canWrite } = useWorkspace();
  const [gForm, setGForm] = useState<{ open: boolean; goal: GoalRow | null }>({ open: false, goal: null });
  const [bForm, setBForm] = useState<{ open: boolean; budget: BudgetRow | null }>({
    open: false,
    budget: null,
  });
  const [del, setDel] = useState<{ entity: 'goals' | 'budgets'; id: string; name: string } | null>(null);

  /** Passa a usar o aporte recomendado (mesmo fluxo de draft: auditoria, desfazer e impacto na projeção). */
  const applyContribution = async (g: GoalRow, monthlyContributionCents: number) => {
    try {
      const r = await action.mutateAsync({
        kind: 'goal',
        payload: {
          mode: 'update',
          id: g.id,
          fields: {
            name: g.name,
            kind: g.kind,
            targetCents: g.targetCents,
            savedCents: g.savedCents,
            monthlyContributionCents,
            startMonth: g.startMonth,
            targetDate: g.targetDate,
          },
        },
      });
      toast.success(`Aporte de ${formatBRL(monthlyContributionCents)}/mês salvo.`, {
        description: r.impact ?? undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível atualizar o aporte.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Metas e Orçamentos"
        description="Guarde para o que importa e acompanhe limites por categoria."
      />

      <section aria-labelledby="goals-h" className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="goals-h" className="text-[15px] font-semibold">
            Metas
          </h2>
          {canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setGForm({ open: true, goal: null })}>
              <Plus aria-hidden /> Nova meta
            </Button>
          ) : null}
        </div>
        {goals.isPending ? (
          <Skeleton className="h-32" />
        ) : (goals.data ?? []).length === 0 ? (
          <EmptyState
            title="Nenhuma meta"
            icon={<Goal className="size-5" />}
            hint="Ex.: reserva de emergência de 6 meses."
            prompt="quero juntar 30 mil para uma viagem até dezembro de 2027"
          />
        ) : (
          <ul className="grid gap-3 @min-[560px]:grid-cols-2 @min-[1000px]:grid-cols-3">
            {(goals.data ?? []).map((g) => {
              const ratio = g.targetCents > 0 ? g.savedCents / g.targetCents : 0;
              const remaining = Math.max(0, g.targetCents - g.savedCents);
              const months =
                g.monthlyContributionCents > 0 ? Math.ceil(remaining / g.monthlyContributionCents) : null;
              const plan = goalPlan(g, todayLocalISO());
              return (
                <li key={g.id}>
                  <Card className="h-full p-4">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[14px] font-semibold">{g.name}</h3>
                        <p className="text-[12px] text-muted-foreground">
                          {GOAL_KIND[g.kind]}
                          {g.targetDate ? ` · até ${formatDateBR(g.targetDate)}` : ''}
                        </p>
                      </div>
                      {g.status !== 'active' ? (
                        <Badge tone={g.status === 'done' ? 'positive' : 'neutral'}>
                          {g.status === 'done' ? 'concluída' : 'cancelada'}
                        </Badge>
                      ) : null}
                      {canWrite ? (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Ações da meta ${g.name}`}>
                              <MoreVertical aria-hidden />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setGForm({ open: true, goal: g })}>
                              <Pencil aria-hidden /> Editar
                            </MenuItem>
                            <MenuItem
                              onSelect={() => setDel({ entity: 'goals', id: g.id, name: g.name })}
                              className="text-negative"
                            >
                              <Trash2 aria-hidden /> Excluir
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : null}
                    </div>
                    <div className="mt-3 flex items-baseline justify-between gap-2">
                      <Money cents={g.savedCents} className="text-lg font-semibold" />
                      <span className="text-[12px] text-muted-foreground">
                        de <Money cents={g.targetCents} />
                      </span>
                    </div>
                    <Meter
                      className="mt-2"
                      value={g.savedCents}
                      max={g.targetCents}
                      tone={ratio >= 1 ? 'positive' : 'accent'}
                      label={`Progresso da meta ${g.name}`}
                    />
                    <p className="mt-2 text-[12px] text-muted-foreground">
                      {Math.round(ratio * 100)}% · aporte <Money cents={g.monthlyContributionCents} />
                      /mês
                      {months !== null && remaining > 0
                        ? ` · ~${months} ${months === 1 ? 'mês' : 'meses'} para concluir`
                        : ''}
                      {plan.finishMonth && remaining > 0 ? ` (${monthLabel(plan.finishMonth, true)})` : ''}
                    </p>
                    {g.status === 'active' ? (
                      <GoalAdvice
                        goal={g}
                        plan={plan}
                        canWrite={canWrite}
                        onApply={(cents) => void applyContribution(g, cents)}
                        busy={action.isPending}
                      />
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="budgets-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="budgets-h" className="text-[15px] font-semibold">
            Orçamentos de {monthLabel(todayLocalISO(), true)}
          </h2>
          {canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setBForm({ open: true, budget: null })}>
              <Plus aria-hidden /> Novo orçamento
            </Button>
          ) : null}
        </div>
        {budgets.isPending ? (
          <Skeleton className="h-32" />
        ) : (budgets.data ?? []).length === 0 ? (
          <EmptyState
            title="Nenhum orçamento"
            icon={<PiggyBank className="size-5" />}
            prompt="quero gastar no máximo 1.500 com mercado por mês"
          />
        ) : (
          <Card className="divide-y overflow-hidden">
            {(budgets.data ?? []).map((b) => {
              const spent = spend.data?.find((s) => s.categoryId === b.categoryId)?.currentCents ?? 0;
              const ratio = spent / b.amountCents;
              const tone = ratio >= 1 ? 'negative' : ratio * 100 >= b.alertPct ? 'warning' : 'accent';
              return (
                <div key={b.id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{b.name}</span>
                    <span className="text-[13px] text-muted-foreground">
                      <Money
                        cents={spent}
                        className={ratio >= 1 ? 'font-medium text-negative' : 'font-medium text-foreground'}
                      />{' '}
                      de <Money cents={b.amountCents} />
                    </span>
                    {canWrite ? (
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Ações do orçamento ${b.name}`}>
                            <MoreVertical aria-hidden />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setBForm({ open: true, budget: b })}>
                            <Pencil aria-hidden /> Editar
                          </MenuItem>
                          <MenuItem
                            onSelect={() => setDel({ entity: 'budgets', id: b.id, name: b.name })}
                            className="text-negative"
                          >
                            <Trash2 aria-hidden /> Excluir
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </div>
                  <Meter
                    className="mt-2"
                    value={spent}
                    max={b.amountCents}
                    tone={tone}
                    marker={(b.amountCents * b.alertPct) / 100}
                    label={`Orçamento ${b.name}: ${formatBRL(spent)} de ${formatBRL(b.amountCents)}`}
                  />
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <GoalForm open={gForm.open} goal={gForm.goal} onClose={() => setGForm({ open: false, goal: null })} />
      <BudgetForm
        open={bForm.open}
        budget={bForm.budget}
        onClose={() => setBForm({ open: false, budget: null })}
      />
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Excluir “${del?.name ?? ''}”?`}
        confirmLabel="Excluir"
        danger
        busy={action.isPending}
        onConfirm={async () => {
          if (!del) return;
          try {
            const r = await action.mutateAsync({
              kind: 'delete',
              payload: { entity: del.entity, ids: [del.id] },
            });
            toast.success(r.summary);
            setDel(null);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Falhou.');
          }
        }}
      />
    </div>
  );
}
