import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  formatBRL,
  monthLabel,
  parseAmount,
  retirementMonths,
  retirementPlan,
  type RetirementParams,
  type RetirementScenarioDTO,
} from '@sf/shared';
import { useAction, useRetirement } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Money } from '@/components/common/money';
import { ErrorState } from '@/components/common/states';
import { RetirementChart } from '@/components/charts/charts';

const NEED_LABEL = {
  projection_12m: 'custo médio projetado',
  history_6m: 'média dos últimos 6 meses',
  none: 'sem gastos registrados',
  target: 'renda desejada',
} as const;

const pctText = (v: number) => (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const parsePct = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) ? n / 100 : null;
};
const centsText = (c: number | null) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
const parseCents = (s: string) => (s.trim() ? parseAmount(s) : null);

export function RetirementSection() {
  const q = useRetirement();
  return (
    <Card>
      <CardHeader
        title="Aposentadoria"
        description="Projeta o saldo e as contribuições da previdência além dos 24 meses, em reais de hoje."
      />
      <CardBody>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isPending ? (
          <Skeleton className="h-72" />
        ) : (
          // o estado do formulário recomeça quando o perfil salvo muda
          <Simulator key={JSON.stringify(q.data.profile)} data={q.data} />
        )}
      </CardBody>
    </Card>
  );
}

function Simulator({ data }: { data: RetirementScenarioDTO }) {
  const { canWrite } = useWorkspace();
  const action = useAction();
  const a = data.assumptions;
  const b = data.baseline;
  const [f, setF] = useState({
    birthDate: a.birthDate ?? '',
    retireYear: data.plan ? data.plan.retireMonth.slice(0, 4) : '',
    endAge: String(a.endAge),
    accumulation: pctText(a.accumulationRate),
    withdrawal: pctText(a.withdrawalRate),
    growth: pctText(a.contributionGrowth),
    target: centsText(a.targetIncomeCents),
    inss: centsText(a.inssMonthlyCents),
    includeInvestments: a.includeInvestments,
  });
  // Enquanto o ano não é mexido, vale a idade do perfil (mês do aniversário)
  const [yearTouched, setYearTouched] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  const sim = useMemo(() => {
    const birthYear = Number(f.birthDate.slice(0, 4));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.birthDate) || birthYear < 1900)
      return { error: 'Informe sua data de nascimento para simular.' } as const;
    const acc = parsePct(f.accumulation);
    const wd = parsePct(f.withdrawal);
    const growth = parsePct(f.growth) ?? 0;
    const endAge = Number(f.endAge);
    const year = Number(f.retireYear);
    if (acc === null || wd === null) return { error: 'Informe os rendimentos reais.' } as const;
    if (!Number.isInteger(endAge) || endAge < 50 || endAge > 110)
      return { error: 'A idade final precisa ficar entre 50 e 110 anos.' } as const;
    try {
      const byYear = yearTouched && year > 0;
      const months = retirementMonths({
        birthDate: f.birthDate,
        endAge,
        ...(byYear ? { retireYear: year } : { retireAge: a.retireAge }),
      });
      const target = parseCents(f.target);
      const params: RetirementParams = {
        ...months,
        startMonth: b.startMonth,
        birthDate: f.birthDate,
        pensionBalanceCents: b.pensionBalanceCents,
        otherAssetsCents: f.includeInvestments ? b.otherAssetsCents : 0,
        monthlyContributionCents: b.monthlyContributionCents,
        contributionGrowth: growth,
        accumulationRate: acc,
        withdrawalRate: wd,
        neededMonthlyCents: target ?? b.monthlyExpenseCents,
        inssMonthlyCents: parseCents(f.inss) ?? 0,
      };
      const plan = retirementPlan(params);
      return {
        params,
        plan,
        needSource: target ? ('target' as const) : b.expenseSource,
        // o perfil guarda a idade: a mais próxima do ano escolhido
        retireAge: byYear ? Math.round(plan.retireAge) : a.retireAge,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Cenário inválido.' } as const;
    }
  }, [f, yearTouched, a.retireAge, b]);

  const save = async () => {
    if ('error' in sim) return;
    try {
      const r = await action.mutateAsync({
        kind: 'retirement_profile',
        payload: {
          birthDate: f.birthDate,
          retireAge: sim.retireAge,
          endAge: Number(f.endAge),
          accumulationRate: sim.params.accumulationRate,
          withdrawalRate: sim.params.withdrawalRate,
          contributionGrowth: sim.params.contributionGrowth,
          inssMonthlyCents: sim.params.inssMonthlyCents || null,
          targetIncomeCents: parseCents(f.target),
          includeInvestments: f.includeInvestments,
        },
      });
      toast.success(r.summary);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };

  const plan = 'plan' in sim ? sim.plan : null;
  const warnings = [
    ...b.warnings,
    ...(f.includeInvestments && b.otherAssetsCents > 0
      ? ['Os investimentos considerados são os do workspace inteiro.']
      : []),
    ...(plan?.alreadyRetired ? ['O ano pedido já passou; considerei o benefício a partir de agora.'] : []),
  ];
  const hist = b.historical?.realAnnual ?? null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 @min-[620px]:grid-cols-4">
        <Field label="Nascimento" htmlFor="rt-birth">
          <Input id="rt-birth" type="date" value={f.birthDate} onChange={set('birthDate')} />
        </Field>
        <Field
          label="Aposentar em (ano)"
          htmlFor="rt-year"
          hint={plan ? `aos ${Math.floor(plan.retireAge)} anos` : undefined}
        >
          <Input
            id="rt-year"
            inputMode="numeric"
            value={f.retireYear}
            onChange={(e) => {
              setYearTouched(true);
              setF({ ...f, retireYear: e.target.value });
            }}
            placeholder="2040"
          />
        </Field>
        <Field label="Renda até (idade)" htmlFor="rt-end">
          <Input id="rt-end" inputMode="numeric" value={f.endAge} onChange={set('endAge')} />
        </Field>
        <Field
          label="Contribuições crescem (% a.a.)"
          htmlFor="rt-growth"
          hint={`hoje ${formatBRL(b.monthlyContributionCents)}/mês`}
        >
          <Input id="rt-growth" inputMode="decimal" value={f.growth} onChange={set('growth')} />
        </Field>
        <Field
          label="Rendimento real até aposentar (% a.a.)"
          htmlFor="rt-acc"
          hint={
            hist !== null ? (
              <button
                type="button"
                className="text-left font-medium text-primary hover:underline"
                onClick={() => setF({ ...f, accumulation: pctText(hist) })}
              >
                Histórico do plano: {pctText(hist)}% ({b.historical!.months} meses) — usar
              </button>
            ) : undefined
          }
        >
          <Input id="rt-acc" inputMode="decimal" value={f.accumulation} onChange={set('accumulation')} />
        </Field>
        <Field label="Rendimento real depois (% a.a.)" htmlFor="rt-wd">
          <Input id="rt-wd" inputMode="decimal" value={f.withdrawal} onChange={set('withdrawal')} />
        </Field>
        <Field
          label="Renda desejada (R$/mês)"
          htmlFor="rt-target"
          hint={
            b.monthlyExpenseCents ? `vazio = gasto atual (${formatBRL(b.monthlyExpenseCents)})` : undefined
          }
        >
          <Input id="rt-target" inputMode="decimal" value={f.target} onChange={set('target')} />
        </Field>
        <Field label="INSS esperado (R$/mês)" htmlFor="rt-inss">
          <Input id="rt-inss" inputMode="decimal" value={f.inss} onChange={set('inss')} />
        </Field>
      </div>

      <label className="flex items-center gap-3 text-[13px]">
        <Switch
          checked={f.includeInvestments}
          onCheckedChange={(v) => setF({ ...f, includeInvestments: v })}
          aria-label="Incluir carteira e contas de investimento"
        />
        <span>
          Incluir carteira e contas de investimento{' '}
          <span className="text-muted-foreground">({formatBRL(b.otherAssetsCents)})</span>
        </span>
      </label>

      {'error' in sim ? (
        <p className="rounded-xl bg-subtle p-3 text-[13px] text-muted-foreground">{sim.error}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 @min-[620px]:grid-cols-3">
            <Kpi label={`Renda projetada em ${monthLabel(sim.plan.retireMonth)}`}>
              <Money cents={sim.plan.projectedIncomeCents} className="text-lg font-semibold" />
              <p className="text-[12px] text-muted-foreground">
                {sim.params.inssMonthlyCents
                  ? `${formatBRL(sim.plan.projectedMonthlyCents)} do capital + INSS`
                  : `até os ${f.endAge} anos`}
              </p>
            </Kpi>
            <Kpi label="Referência">
              <Money cents={sim.plan.neededMonthlyCents} className="text-lg font-semibold" />
              <p className="text-[12px] text-muted-foreground">{NEED_LABEL[sim.needSource]}</p>
            </Kpi>
            <Kpi label={sim.plan.gapCents > 0 ? 'Falta por mês' : 'Sobra por mês'}>
              <Money
                cents={sim.plan.gapCents > 0 ? sim.plan.gapCents : sim.plan.surplusCents}
                tone={sim.plan.gapCents > 0 ? 'negative' : 'positive'}
                className="text-lg font-semibold"
              />
              {sim.plan.lastsUntilAge !== null ? (
                <p className="text-[12px] text-muted-foreground">
                  gastando a referência, dura até os {Math.floor(sim.plan.lastsUntilAge)} anos
                </p>
              ) : null}
            </Kpi>
            <Kpi label="Capital na aposentadoria">
              <Money cents={sim.plan.capitalAtRetirementCents} className="text-lg font-semibold" />
              <p className="text-[12px] text-muted-foreground">
                necessário: {formatBRL(sim.plan.requiredCapitalCents)}
              </p>
            </Kpi>
            <Kpi label="Aporte extra para fechar">
              {sim.plan.extraMonthlyCents === null ? (
                <p className="text-[13px] text-muted-foreground">sem meses até a aposentadoria</p>
              ) : (
                <>
                  <Money cents={sim.plan.extraMonthlyCents} className="text-lg font-semibold" />
                  <p className="text-[12px] text-muted-foreground">
                    por mês até {monthLabel(sim.plan.retireMonth)}
                  </p>
                </>
              )}
            </Kpi>
            <Kpi label="Contribuições até lá">
              <Money cents={sim.plan.totalContributedCents} className="text-lg font-semibold" />
              <p className="text-[12px] text-muted-foreground">
                {sim.plan.accumulationMonths} meses a partir de {monthLabel(b.startMonth)}
              </p>
            </Kpi>
          </div>
          {sim.plan.yearly.length > 1 ? (
            <RetirementChart yearly={sim.plan.yearly} retireYear={Number(sim.plan.retireMonth.slice(0, 4))} />
          ) : null}
        </>
      )}

      {warnings.length ? (
        <ul className="space-y-1 text-[12px] text-muted-foreground">
          {warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-3 border-t pt-4 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between">
        <p className="text-[12px] text-muted-foreground">
          Valores em reais de hoje, antes de IR. Os rendimentos são premissas acima da inflação. O plano pode
          oferecer outras formas de benefício (vitalícia, percentual do saldo).
        </p>
        {canWrite ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            disabled={'error' in sim || action.isPending}
          >
            Salvar como meu perfil
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-subtle p-3">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
