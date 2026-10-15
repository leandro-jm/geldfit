import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellOff,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  CreditCard,
  Info,
  LifeBuoy,
  Minus,
  ShoppingBag,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  formatBRL,
  formatDateBR,
  monthLabel,
  type AccountShortfall,
  type CardDTO,
  type DashboardSummary,
  type InsightDTO,
  type ProjectionDTO,
} from '@sf/shared';
import { api } from '@/lib/api';
import {
  useAccounts,
  useCards,
  useCategorySpend,
  useEmergencyReserve,
  useFlows,
  useInsights,
  useInvalidateWorkspace,
  usePension,
  usePortfolio,
  useProjection,
  useSafeToSpend,
  useSummary,
  useUpcoming,
} from '@/lib/queries';
import { useFilters } from '@/lib/filters';
import { useWorkspace } from '@/lib/workspace';
import { cn, pct, relativeDays, signedPct, todayLocalISO } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Meter } from '@/components/ui/progress';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { Panel, UpdatedAt } from '@/components/common/panel';
import { EmptyState } from '@/components/common/states';
import { AskButton } from '@/components/common/ask';
import { useMarkPaid } from '@/components/common/mark-paid';
import { TransferDialog } from '@/components/common/transfer-dialog';
import { useChat } from '@/components/chat/chat-context';
import {
  AllocationDonut,
  CLASS_LABEL,
  classColor,
  FlowsChart,
  PensionChart,
  PerformanceChart,
  ProjectionChart,
} from '@/components/charts/charts';
import { useChartTheme } from '@/components/charts/echart';

// --------------------------------------------------------------------------------------------
// KPIs
// --------------------------------------------------------------------------------------------

function Delta({ now, prev, invert }: { now: number; prev: number | null | undefined; invert?: boolean }) {
  if (prev === null || prev === undefined)
    return <span className="text-[12px] text-muted-foreground">sem mês anterior</span>;
  const diff = now - prev;
  if (diff === 0)
    return (
      <span className="inline-flex items-center gap-0.5 text-[12px] text-muted-foreground">
        <Minus className="size-3" aria-hidden /> igual ao mês anterior
      </span>
    );
  const good = invert ? diff < 0 : diff > 0;
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[12px] font-medium',
        good ? 'text-positive' : 'text-negative',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <Money cents={Math.abs(diff)} compact />
      <span className="font-normal text-muted-foreground">vs mês anterior</span>
    </span>
  );
}

function KpiCard({
  label,
  children,
  foot,
  to,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  foot: React.ReactNode;
  to: '/contas' | '/projecao';
  testId: string;
}) {
  return (
    <Card
      className="relative flex min-w-0 flex-col gap-1 p-4 transition-shadow hover:shadow-pop sm:p-5"
      data-testid={testId}
    >
      <Link to={to} className="absolute inset-0 rounded-2xl" aria-label={`${label}: ver detalhes`} />
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <div className="truncate text-[22px] font-semibold leading-8 tracking-tight">{children}</div>
      <div className="min-h-5">{foot}</div>
    </Card>
  );
}

export function KpiRow() {
  const s = useSummary();
  if (s.isPending)
    return (
      <div
        className="flex gap-3 overflow-hidden @min-[560px]:grid @min-[560px]:grid-cols-2 @min-[1000px]:grid-cols-4"
        aria-busy="true"
        aria-label="Carregando indicadores"
      >
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="w-[78%] shrink-0 space-y-3 p-5 @min-[560px]:w-auto">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-36" />
            <Skeleton className="h-3 w-28" />
          </Card>
        ))}
      </div>
    );
  if (s.error) return null;
  const d: DashboardSummary = s.data;
  return (
    <section aria-label="Indicadores principais" className="min-w-0">
      <div
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 no-scrollbar @min-[560px]:mx-0 @min-[560px]:grid @min-[560px]:grid-cols-2 @min-[560px]:overflow-visible @min-[560px]:px-0 @min-[560px]:pb-0 @min-[1000px]:grid-cols-4"
        data-testid="kpis"
      >
        <div className="w-[80%] max-w-[300px] shrink-0 snap-start @min-[560px]:w-auto @min-[560px]:max-w-none">
          <KpiCard
            label="Patrimônio total"
            to="/contas"
            testId="kpi-networth"
            foot={<Delta now={d.netWorthCents} prev={d.previousMonth?.netWorthCents} />}
          >
            <Money cents={d.netWorthCents} />
          </KpiCard>
        </div>
        <div className="w-[80%] max-w-[300px] shrink-0 snap-start @min-[560px]:w-auto @min-[560px]:max-w-none">
          <KpiCard
            label="Saldo em contas"
            to="/contas"
            testId="kpi-accounts"
            foot={<Delta now={d.accountsBalanceCents} prev={d.previousMonth?.accountsBalanceCents} />}
          >
            <Money cents={d.accountsBalanceCents} />
          </KpiCard>
        </div>
        <div className="w-[80%] max-w-[300px] shrink-0 snap-start @min-[560px]:w-auto @min-[560px]:max-w-none">
          <KpiCard
            label="Faturas abertas"
            to="/contas"
            testId="kpi-bills"
            foot={<Delta now={d.openBillsCents} prev={d.previousMonth?.openBillsCents} invert />}
          >
            <Money cents={d.openBillsCents} />
          </KpiCard>
        </div>
        <div className="w-[80%] max-w-[300px] shrink-0 snap-start @min-[560px]:w-auto @min-[560px]:max-w-none">
          <KpiCard
            label="Menor saldo projetado"
            to="/projecao"
            testId="kpi-min"
            foot={
              d.minProjected ? (
                <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                  em {monthLabel(d.minProjected.month, true)}
                  {d.alert ? (
                    <Badge tone="negative">
                      <AlertTriangle aria-hidden /> abaixo do piso
                    </Badge>
                  ) : null}
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground">próximos 24 meses</span>
              )
            }
          >
            {d.minProjected ? (
              <Money cents={d.minProjected.cents} tone={d.minProjected.cents < 0 ? 'negative' : undefined} />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </KpiCard>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <UpdatedAt at={d.lastUpdate} label="Dados atualizados em" />
        {d.staleAccounts.length ? (
          <p className="mt-3 flex items-center gap-1 text-[11.5px] text-warning">
            <AlertTriangle className="size-3" aria-hidden />
            {d.staleAccounts.length === 1
              ? `${d.staleAccounts[0]!.name} está sem lançamentos há mais de 30 dias`
              : `${d.staleAccounts.length} contas sem lançamentos há mais de 30 dias`}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------------------------
// Folga para gastar ("quanto posso gastar?") e contas que vão ficar negativas
// --------------------------------------------------------------------------------------------

const SAFE_STATUS = {
  ok: { tone: 'positive', label: 'com folga' },
  tight: { tone: 'warning', label: 'apertado' },
  over: { tone: 'negative', label: 'sem folga' },
} as const;

export function SafeToSpendPanel({ className }: { className?: string }) {
  const q = useSafeToSpend();
  const chat = useChat();
  const { canWrite } = useWorkspace();
  const [cover, setCover] = useState<AccountShortfall | null>(null);
  const s = q.data;
  const status = s ? SAFE_STATUS[s.status] : null;
  return (
    <Panel
      id="safe-to-spend"
      title="Quanto posso gastar"
      description="Folga sobre o seu piso nos próximos 24 meses"
      ask={{ question: 'Quanto posso gastar sem apertar os próximos meses?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      skeletonHeight={72}
      actions={
        status ? (
          <Badge tone={status.tone} data-testid="safe-status">
            {status.label}
          </Badge>
        ) : null
      }
    >
      {s ? (
        <div className="grid gap-4 @min-[620px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] @min-[620px]:items-center">
          <div className="min-w-0" data-testid="safe-extra">
            <p className="text-[13px] text-muted-foreground">
              {s.status === 'over' ? 'Falta para voltar ao piso' : 'Folga para gastos extras'}
            </p>
            <p className="mt-0.5 text-[26px] font-semibold leading-9 tracking-tight">
              <Money
                cents={s.status === 'over' ? s.deficitCents : s.extraCents}
                tone={s.status === 'over' ? 'negative' : undefined}
              />
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              {s.status === 'over' && s.firstBelowFloor
                ? `A projeção fura o piso de ${formatBRL(s.floorCents)} em ${monthLabel(s.firstBelowFloor, true)}.`
                : `Sem nenhum mês abaixo do piso de ${formatBRL(s.floorCents)}${
                    s.limitingMonth ? ` · mais apertado: ${monthLabel(s.limitingMonth, true)}` : ''
                  }`}
              {s.status !== 'over' && s.conservativeExtraCents < s.extraCents ? (
                <>
                  {' '}
                  · pessimista: <Money cents={s.conservativeExtraCents} />
                </>
              ) : null}
            </p>
          </div>
          <div className="min-w-0 rounded-xl bg-subtle/70 px-3.5 py-2.5" data-testid="safe-daily">
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Wallet className="size-3.5" aria-hidden /> Dia a dia até o fim do mês
            </p>
            {s.monthVariableLeftCents > 0 ? (
              <p className="mt-0.5 text-[15px] font-semibold">
                ≈ <Money cents={s.dailyCents} />{' '}
                <span className="font-normal text-muted-foreground">por dia</span>
                <span className="block text-[12px] font-normal text-muted-foreground">
                  <Money cents={s.monthVariableLeftCents} /> no seu ritmo normal · {s.daysLeft}{' '}
                  {s.daysLeft === 1 ? 'dia' : 'dias'}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-[13.5px]">O previsto para o dia a dia deste mês já foi usado.</p>
            )}
          </div>
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() =>
              chat.openChat({
                text: 'posso comprar ',
                context: { panel: 'Quanto posso gastar', detail: `folga ${formatBRL(s.extraCents)}` },
              })
            }
          >
            <ShoppingBag aria-hidden /> Posso comprar…?
          </Button>
          {s.shortfalls.length ? (
            <ul className="space-y-2 @min-[620px]:col-span-3" aria-label="Contas que vão ficar negativas">
              {s.shortfalls.map((f) => (
                <li
                  key={f.accountId}
                  role="alert"
                  data-testid="shortfall"
                  className="flex flex-col gap-2 rounded-xl border border-negative/25 bg-negative-soft px-3.5 py-2.5 text-[13.5px] sm:flex-row sm:items-center"
                >
                  <p className="flex min-w-0 flex-1 items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
                    <span>
                      <span className="font-semibold">{f.accountName}</span> fica em{' '}
                      <Money cents={f.balanceCents} className="font-semibold" tone="negative" /> em{' '}
                      {formatDateBR(f.date)}
                      {f.cause ? (
                        <span className="text-muted-foreground">
                          {' '}
                          ({f.cause.description} <Money cents={f.cause.amountCents} />)
                        </span>
                      ) : null}
                    </span>
                  </p>
                  {f.suggestion && canWrite ? (
                    <Button size="sm" variant="outline" className="shrink-0" onClick={() => setCover(f)}>
                      Transferir <Money cents={f.suggestion.amountCents} /> da {f.suggestion.fromAccountName}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <TransferDialog
        open={Boolean(cover)}
        onClose={() => setCover(null)}
        defaultFromAccountId={cover?.suggestion?.fromAccountId}
        defaultToAccountId={cover?.accountId}
        defaultAmountCents={cover?.suggestion?.amountCents}
        defaultDate={cover?.suggestion?.date}
        defaultDescription={cover ? `Cobrir saldo da ${cover.accountName}` : null}
      />
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Reserva de emergência (cenário de desligamento)
// --------------------------------------------------------------------------------------------

const RESERVE_STATUS = {
  ok: { tone: 'positive', label: 'na meta', meter: 'positive' },
  low: { tone: 'warning', label: 'abaixo da meta', meter: 'warning' },
  critical: { tone: 'negative', label: 'baixa', meter: 'negative' },
} as const;

const fmtMonths = (n: number) =>
  `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${n === 1 ? 'mês' : 'meses'}`;

export function EmergencyReservePanel({ className }: { className?: string }) {
  const q = useEmergencyReserve();
  const r = q.data;
  const status = r ? RESERVE_STATUS[r.status] : null;
  const empty = r && r.reserveCents === 0 && r.monthlyCostCents === 0;
  return (
    <Panel
      id="emergency-reserve"
      title="Reserva de emergência"
      description="Se a renda do trabalho parar hoje"
      ask={{ question: 'Quanto tempo minha reserva aguenta se eu for demitido?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      skeletonHeight={120}
      actions={
        status && !empty ? (
          <Badge tone={status.tone} data-testid="reserve-status">
            {status.label}
          </Badge>
        ) : null
      }
    >
      {empty ? (
        <EmptyState
          compact
          title="Cadastre suas contas para calcular"
          icon={<LifeBuoy className="size-5" />}
          prompt="abri uma conta no BB com 5.000"
        />
      ) : r ? (
        <div className="space-y-3">
          <div data-testid="reserve-months">
            <p className="text-[26px] font-semibold leading-9 tracking-tight">
              {r.months === null ? '24+ meses' : fmtMonths(r.months)}
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              {r.months === null
                ? 'pagando as contas sem salário, até o fim da projeção'
                : `pagando as contas sem salário · acaba em ${monthLabel(r.runsOutMonth!, true)}`}
            </p>
          </div>
          <div>
            <Meter
              value={r.months ?? r.targetMonths * 1.5}
              max={Math.max(r.targetMonths * 1.5, 1)}
              marker={r.targetMonths}
              tone={status!.meter}
              label={`Meses cobertos pela reserva; meta de ${fmtMonths(r.targetMonths)}`}
            />
            <p className="mt-1.5 text-right text-[11.5px] text-muted-foreground">
              meta: {fmtMonths(r.targetMonths)}
            </p>
          </div>
          <dl className="space-y-1.5 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Reserva disponível</dt>
              <dd className="font-medium">
                <Money cents={r.reserveCents} />
              </dd>
            </div>
            <div className="flex justify-between gap-3 pl-3 text-[12.5px]">
              <dt className="text-muted-foreground">em contas</dt>
              <dd>
                <Money cents={r.breakdown.accountsCents} />
              </dd>
            </div>
            <div className="flex justify-between gap-3 pl-3 text-[12.5px]">
              <dt className="text-muted-foreground">investimentos com resgate imediato</dt>
              <dd>
                <Money cents={r.breakdown.investmentsCents} />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Custo médio por mês</dt>
              <dd>
                <Money cents={r.monthlyCostCents} direction="out" />
              </dd>
            </div>
            {r.otherIncomeCents > 0 ? (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Outras receitas que continuam</dt>
                <dd>
                  <Money cents={r.otherIncomeCents} direction="in" tone="positive" />
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="text-[12px] text-muted-foreground" data-testid="reserve-salaries">
            {r.salaries.length ? (
              <>
                Param no cenário:{' '}
                {r.salaries.map((s, i) => (
                  <span key={`${s.description}-${i}`}>
                    {i ? ', ' : ''}
                    {s.description} (<Money cents={s.amountCents} />)
                  </span>
                ))}
                .
              </>
            ) : (
              'Nenhum salário recorrente cadastrado: considerei só as receitas já previstas.'
            )}{' '}
            Não inclui FGTS, multa de 40%, rescisão nem seguro-desemprego.{' '}
            <Link to="/configuracoes" className="font-medium text-primary hover:underline">
              Ajustar meta
            </Link>
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Projeção
// --------------------------------------------------------------------------------------------

export function MonthDetail({ data, month }: { data: ProjectionDTO; month: string }) {
  const m = data.months.find((x) => x.month === month);
  if (!m) return null;
  const rows: Array<[string, number, 'in' | 'out' | null]> = [
    ['Saldo inicial', m.openingCents, null],
    ['Entradas', m.incomeCents, 'in'],
    ['Saídas', m.expenseCents, 'out'],
    ['Faturas', m.cardBillsCents, 'out'],
    ['Variável estimado', m.variableCents, 'out'],
    ['Metas', m.goalsCents, 'out'],
  ];
  return (
    <div className="mt-3 rounded-xl border bg-subtle/60 p-3" data-testid="month-detail">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">{monthLabel(m.month, true)}</h3>
        {m.belowFloor ? <Badge tone="negative">abaixo do piso</Badge> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3 lg:grid-cols-4">
        {rows.map(([label, v, dir]) => (
          <div key={label} className="flex min-w-0 justify-between gap-2">
            <dt className="truncate text-muted-foreground">{label}</dt>
            <dd>
              <Money cents={v} direction={dir ?? undefined} tone={dir === 'in' ? 'positive' : undefined} />
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-2 font-medium">
          <dt>Saldo final</dt>
          <dd>
            <Money cents={m.closingCents} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Otimista</dt>
          <dd>
            <Money cents={m.closingOptimisticCents} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Pessimista</dt>
          <dd>
            <Money cents={m.closingPessimisticCents} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function ProjectionLegend({ floorCents }: { floorCents: number }) {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground"
      aria-label="Legenda"
    >
      <li className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded bg-[var(--chart-1)]" aria-hidden /> Saldo base
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm bg-[var(--chart-1)] opacity-20" aria-hidden />{' '}
        Otimista–pessimista
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-4 border-t-2 border-dashed border-[var(--chart-floor)]" aria-hidden /> Piso{' '}
        <Money cents={floorCents} compact />
      </li>
    </ul>
  );
}

export function ProjectionPanel({ className }: { className?: string }) {
  const { accountId } = useFilters();
  const q = useProjection(accountId);
  const [month, setMonth] = useState<string | null>(null);
  const data = q.data;
  const empty =
    data && data.months.every((m) => m.closingCents === 0 && m.incomeCents === 0 && m.expenseCents === 0);
  return (
    <Panel
      id="projection"
      title="Projeção de 24 meses"
      description={
        data?.firstBelowFloor ? (
          <span className="text-negative">
            Fica abaixo do piso a partir de {monthLabel(data.firstBelowFloor, true)}
          </span>
        ) : (
          'Saldo base com faixa otimista e pessimista'
        )
      }
      ask={{
        question: data?.firstBelowFloor
          ? `Por que ${monthLabel(data.firstBelowFloor, true)} fica abaixo do piso?`
          : 'Como está minha projeção para os próximos 24 meses?',
      }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      skeletonHeight={280}
      fetching={q.isFetching && !q.isPending}
    >
      {data && empty ? (
        <EmptyState
          title="Sem dados para projetar ainda"
          hint="Cadastre uma conta e sua renda para ver o futuro."
          prompt="abri uma conta no BB com 5.000"
        />
      ) : data ? (
        <>
          <ProjectionLegend floorCents={data.floorCents} />
          <div className="mt-2">
            <ProjectionChart data={data} onSelectMonth={setMonth} selected={month} height={300} />
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">Toque em um mês para ver o detalhe.</p>
          {month ? <MonthDetail data={data} month={month} /> : null}
          <UpdatedAt at={data.computedAt} label="calculado em" />
        </>
      ) : null}
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Insights
// --------------------------------------------------------------------------------------------

const SEV = {
  critical: { icon: AlertOctagon, label: 'Crítico', cls: 'text-negative bg-negative-soft' },
  warning: { icon: AlertTriangle, label: 'Atenção', cls: 'text-warning bg-warning-soft' },
  info: { icon: Info, label: 'Info', cls: 'text-primary-soft-foreground bg-primary-soft' },
} as const;

const RULE_LABEL: Record<string, string> = {
  usd_exposure: 'Exposição ao dólar',
  usd_cost: 'Custo do dólar',
  concentration: 'Concentração',
  expensive_fund: 'Fundo caro',
  performance: 'Desempenho',
  idle_cash: 'Dinheiro parado',
  emergency_reserve: 'Reserva de emergência',
  rebalance: 'Rebalanceamento',
  dividends: 'Proventos',
  tax_calendar: 'Calendário fiscal',
};

function payloadEntries(p: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(p)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 8)
    .map(([k, v]) => {
      const label = k
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .toLowerCase();
      let value = String(v);
      if (typeof v === 'number' && /cents$/i.test(k)) value = formatBRL(v);
      else if (typeof v === 'number') value = v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) value = formatDateBR(v);
      return [label.replace(/ cents$/, ''), value];
    });
}

export function InsightItem({ ins }: { ins: InsightDTO }) {
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateWorkspace();
  const { canWrite } = useWorkspace();
  const sev = SEV[ins.severity];
  const quoteDate = (ins.payload.priceDate ??
    ins.payload.ptaxDate ??
    ins.payload.quoteDate ??
    ins.payload.date) as string | undefined;
  const dismiss = async () => {
    try {
      await api(`/api/insights/${ins.id}/dismiss`, { method: 'POST', body: {} });
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  const mute = async () => {
    try {
      await api('/api/insights/mute', { method: 'POST', body: { rule: ins.rule, muted: true } });
      toast.success(`Insights de “${RULE_LABEL[ins.rule] ?? ins.rule}” silenciados.`);
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  return (
    <li className="rounded-xl border p-3">
      <div className="flex items-start gap-2.5">
        <span
          className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', sev.cls)}
          title={sev.label}
        >
          <sev.icon className="size-4" aria-hidden />
          <span className="sr-only">{sev.label}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium leading-5">{ins.title}</p>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{ins.message}</p>
          <button
            type="button"
            className="mt-1.5 inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-primary"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Regra e números{' '}
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
          {open ? (
            <div className="mt-1 rounded-lg bg-subtle p-2.5 text-[12px]">
              <p>
                <span className="text-muted-foreground">Regra:</span> {RULE_LABEL[ins.rule] ?? ins.rule}
              </p>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {payloadEntries(ins.payload).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="capitalize text-muted-foreground">{k}</dt>
                    <dd className="money text-right">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1 text-muted-foreground">
                {quoteDate
                  ? `Cotação de ${formatDateBR(quoteDate.slice(0, 10))}`
                  : `Gerado ${relativeDays(ins.createdAt)}`}
              </p>
            </div>
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex shrink-0 flex-col">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dispensar insight"
              title="Dispensar"
              onClick={() => void dismiss()}
            >
              <X aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Silenciar insights de ${RULE_LABEL[ins.rule] ?? ins.rule}`}
              title="Silenciar este tipo"
              onClick={() => void mute()}
            >
              <BellOff aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function InsightsPanel({ className, limit = 4 }: { className?: string; limit?: number }) {
  const q = useInsights();
  const order = { critical: 0, warning: 1, info: 2 };
  const items = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => order[a.severity] - order[b.severity]),
    [q.data],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Panel
      id="insights"
      title="Insights"
      description="Fatos da sua carteira e do seu caixa — sem recomendação de compra ou venda"
      ask={{ question: 'Me explica os insights ativos' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          title="Nenhum insight agora"
          hint="Quando houver dinheiro parado, reserva baixa ou desvio da sua alocação-alvo, aparece aqui."
        />
      ) : (
        <ul className="space-y-2">
          {items.slice(0, limit).map((i) => (
            <InsightItem key={i.id} ins={i} />
          ))}
          {items.length > limit ? (
            <li>
              <Link to="/carteira" className="text-[13px] font-medium text-primary hover:underline">
                Ver todos ({items.length})
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Receitas x despesas / Categorias
// --------------------------------------------------------------------------------------------

export function FlowsPanel({ className }: { className?: string }) {
  const q = useFlows();
  const empty = q.data?.every((d) => d.incomeCents === 0 && d.expenseCents === 0);
  return (
    <Panel
      id="flows"
      title="Receitas x despesas"
      description="12 meses realizados e 3 projetados"
      ask={{ question: 'Como evoluíram minhas receitas e despesas?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      skeletonHeight={240}
    >
      {q.data && !empty ? (
        <>
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground"
            aria-label="Legenda"
          >
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[var(--chart-in)]" aria-hidden /> Receitas
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[var(--chart-out)]" aria-hidden /> Despesas
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-muted-foreground/40" aria-hidden /> Projetado
              (esmaecido)
            </li>
          </ul>
          <div className="mt-2">
            <FlowsChart data={q.data} />
          </div>
        </>
      ) : q.data ? (
        <EmptyState compact title="Sem lançamentos ainda" prompt="paguei 230 de luz no BB hoje" />
      ) : null}
    </Panel>
  );
}

export function CategoriesPanel({ className }: { className?: string }) {
  const q = useCategorySpend();
  const rows = useMemo(
    () =>
      [...(q.data ?? [])]
        .filter((r) => r.currentCents > 0 || r.averageCents > 0)
        .sort((a, b) => b.currentCents - a.currentCents)
        .slice(0, 7),
    [q.data],
  );
  const max = Math.max(1, ...rows.map((r) => Math.max(r.currentCents, r.averageCents, r.budgetCents ?? 0)));
  return (
    <Panel
      id="categories"
      title="Despesas por categoria"
      description="Mês atual vs média dos últimos 3 meses"
      ask={{ question: 'Onde estou gastando mais este mês?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {rows.length === 0 ? (
        <EmptyState compact title="Sem despesas neste mês" prompt="paguei 230 de luz no BB hoje" />
      ) : (
        <>
          <ul
            className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground"
            aria-label="Legenda"
          >
            <li className="flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm bg-[var(--chart-1)]" aria-hidden /> Mês atual
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0.5 rounded bg-foreground/60" aria-hidden /> Média 3 meses
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0.5 rounded bg-[var(--chart-floor)]" aria-hidden /> Orçamento
            </li>
          </ul>
          <ul className="space-y-3">
            {rows.map((r) => {
              const over = r.budgetCents !== null && r.currentCents > r.budgetCents;
              return (
                <li key={r.categoryId ?? r.name} className="text-[13px]">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{r.name}</span>
                    <Money
                      cents={r.currentCents}
                      className={cn('shrink-0 font-medium', over && 'text-negative')}
                    />
                  </div>
                  <div
                    className="relative h-2.5 w-full rounded-full bg-muted"
                    role="img"
                    aria-label={`${r.name}: ${formatBRL(r.currentCents)} neste mês, média ${formatBRL(r.averageCents)}${r.budgetCents !== null ? `, orçamento ${formatBRL(r.budgetCents)}` : ''}`}
                  >
                    <div
                      className={cn(
                        'sensitive h-full rounded-full',
                        over ? 'bg-negative' : 'bg-[var(--chart-1)]',
                      )}
                      style={{ width: `${(r.currentCents / max) * 100}%` }}
                    />
                    <div
                      className="absolute -top-1 h-[18px] w-0.5 rounded bg-foreground/60"
                      style={{ left: `calc(${(r.averageCents / max) * 100}% - 1px)` }}
                      aria-hidden
                    />
                    {r.budgetCents !== null ? (
                      <div
                        className="absolute -top-1 h-[18px] w-0.5 rounded bg-[var(--chart-floor)]"
                        style={{ left: `calc(${(r.budgetCents / max) * 100}% - 1px)` }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    média <Money cents={r.averageCents} />
                    {r.budgetCents !== null ? (
                      <>
                        {' '}
                        · orçamento <Money cents={r.budgetCents} />
                      </>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Carteira: alocação, dólar, desempenho
// --------------------------------------------------------------------------------------------

export function AllocationPanel({ className }: { className?: string }) {
  const q = usePortfolio();
  const t = useChartTheme();
  const data = q.data;
  return (
    <Panel
      id="allocation"
      title="Alocação vs alvo"
      description="% por classe vs a faixa que você definiu"
      ask={{ question: 'Minha carteira está dentro da alocação-alvo?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {!data || data.totalCents === 0 ? (
        <EmptyState compact title="Nenhum investimento informado" prompt="comprei 100 ITUB4 a 32,50 na XP" />
      ) : (
        <div className="@container">
          <div className="flex flex-col gap-3 @min-[440px]:flex-row @min-[440px]:items-center">
            <div className="relative mx-auto w-[180px] shrink-0">
              <AllocationDonut data={data.byClass} height={180} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[11px] text-muted-foreground">Total</span>
                <Money cents={data.totalCents} compact className="text-sm font-semibold" />
              </div>
            </div>
            <ul className="w-full min-w-0 space-y-1.5 text-[13px]">
              {data.byClass
                .filter((c) => c.valueCents > 0 || c.targetPct !== null)
                .map((c) => {
                  const dev = c.targetPct !== null ? c.pct - c.targetPct : null;
                  const out =
                    (c.minPct !== null && c.pct < c.minPct) ||
                    (c.maxPct !== null && c.pct > c.maxPct) ||
                    (dev !== null && Math.abs(dev) > 5);
                  return (
                    <li key={c.assetClass} className="flex items-center gap-2">
                      <span
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ background: classColor(t, c.assetClass) }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {CLASS_LABEL[c.assetClass] ?? c.assetClass}
                      </span>
                      <span className="tnum font-medium">{pct(c.pct)}</span>
                      <span className="tnum w-[70px] text-right text-[12px] text-muted-foreground">
                        {c.targetPct !== null ? `alvo ${pct(c.targetPct, 0)}` : 'sem alvo'}
                      </span>
                      <span
                        className={cn(
                          'tnum w-[58px] text-right text-[12px]',
                          out ? 'font-medium text-warning' : 'text-muted-foreground',
                        )}
                      >
                        {dev !== null
                          ? `${dev > 0 ? '+' : dev < 0 ? '−' : ''}${Math.abs(dev).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`
                          : ''}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function UsdPanel({ className }: { className?: string }) {
  const q = usePortfolio();
  const u = q.data?.usd;
  const scaleMax = u ? Math.max(30, Math.ceil(Math.max(u.pct * 1.3, (u.maxPct ?? 0) * 1.4) / 10) * 10) : 30;
  return (
    <Panel
      id="usd"
      title="Exposição ao dólar"
      description="% do patrimônio em USD vs faixa-alvo"
      ask={{ question: 'Quanto tenho em dólar e quanto paguei em média?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {!u || !q.data || q.data.totalCents === 0 ? (
        <EmptyState compact title="Sem posição em dólar" prompt="comprei 2.000 dólares a 5,42" />
      ) : (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-2xl font-semibold">{pct(u.pct)}</span>
            {u.minPct !== null && u.maxPct !== null ? (
              <span className="text-[13px] text-muted-foreground">
                meta {pct(u.minPct, 0)}–{pct(u.maxPct, 0)}
              </span>
            ) : (
              <span className="text-[13px] text-muted-foreground">sem faixa-alvo</span>
            )}
          </div>
          <div
            className="relative mt-3 h-3 rounded-full bg-muted"
            role="img"
            aria-label={`Exposição ${pct(u.pct)}${u.minPct !== null ? `, faixa-alvo ${pct(u.minPct, 0)} a ${pct(u.maxPct, 0)}` : ''}`}
          >
            {u.minPct !== null && u.maxPct !== null ? (
              <div
                className="absolute inset-y-0 rounded-full bg-positive/25"
                style={{
                  left: `${(u.minPct / scaleMax) * 100}%`,
                  width: `${((u.maxPct - u.minPct) / scaleMax) * 100}%`,
                }}
              />
            ) : null}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-1)]"
              style={{ width: `${Math.min(100, (u.pct / scaleMax) * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tnum">
            <span>0%</span>
            <span>{scaleMax}%</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
            <div className="rounded-lg bg-subtle p-2.5">
              <dt className="text-[12px] text-muted-foreground">Seu preço médio</dt>
              <dd className="money mt-0.5 font-semibold">
                {u.avgRate
                  ? `R$ ${u.avgRate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                  : '—'}
              </dd>
            </div>
            <div className="rounded-lg bg-subtle p-2.5">
              <dt className="text-[12px] text-muted-foreground">
                PTAX{u.ptaxDate ? ` ${formatDateBR(u.ptaxDate)}` : ''}
              </dt>
              <dd className="money mt-0.5 font-semibold">
                {u.ptax
                  ? `R$ ${u.ptax.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
                  : '—'}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </Panel>
  );
}

export function PerformancePanel({ className }: { className?: string }) {
  const q = usePortfolio();
  const perf = q.data?.performance ?? [];
  const hasData = perf.some((p) => p.portfolioPct !== null || p.cdiPct !== null);
  return (
    <Panel
      id="performance"
      title="Desempenho"
      description="Carteira vs CDI, IBOV e IPCA"
      ask={{ question: 'Como está minha carteira vs CDI e IBOV?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {!hasData ? (
        <EmptyState
          compact
          title="Sem histórico suficiente"
          hint="O desempenho aparece depois que houver operações e cotações."
        />
      ) : (
        <>
          <PerformanceChart data={perf} height={200} />
          <table className="mt-2 w-full table-fixed text-[12px]">
            <caption className="sr-only">Desempenho por período</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th className="w-[22%] py-1 text-left font-medium">Período</th>
                <th className="text-right font-medium">Carteira</th>
                <th className="text-right font-medium">CDI</th>
                <th className="text-right font-medium">IBOV</th>
                <th className="text-right font-medium">IPCA</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {perf.map((p) => (
                <tr key={p.period} className="border-t">
                  <td className="py-1">{{ month: 'Mês', '12m': '12m', inception: 'Início' }[p.period]}</td>
                  <td className="text-right font-medium">{signedPct(p.portfolioPct, 2)}</td>
                  <td className="text-right">{signedPct(p.cdiPct, 2)}</td>
                  <td className="text-right">{signedPct(p.ibovPct, 2)}</td>
                  <td className="text-right">{signedPct(p.ipcaPct, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------------------------------------
// Próximos vencimentos / Cartões / Previdência / Contas
// --------------------------------------------------------------------------------------------

const KIND_LABEL = {
  bill: 'Conta',
  statement: 'Fatura',
  recurrence: 'Recorrente',
  scheduled: 'Agendado',
} as const;

export function UpcomingPanel({ className }: { className?: string }) {
  const q = useUpcoming(15);
  const { canWrite } = useWorkspace();
  const { markPaid, dialog, pending } = useMarkPaid();
  const today = todayLocalISO();
  return (
    <Panel
      id="upcoming"
      title="Próximos vencimentos"
      description="Contas, faturas e recorrências dos próximos 15 dias"
      ask={{ question: 'O que vence nos próximos 15 dias?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {q.data && q.data.length === 0 ? (
        <EmptyState
          compact
          title="Nada vencendo nos próximos 15 dias"
          icon={<CalendarDays className="size-5" />}
          prompt="todo dia 5 entra 8.500 de salário no BB"
        />
      ) : (
        <ul className="-mx-1 divide-y">
          {(q.data ?? []).map((it) => {
            const late = it.date < today;
            return (
              <li key={`${it.kind}-${it.id}`} className="flex items-center gap-3 px-1 py-2.5">
                <div
                  className={cn(
                    'flex w-11 shrink-0 flex-col items-center rounded-lg py-1 text-center leading-tight',
                    late ? 'bg-negative-soft text-negative' : 'bg-muted',
                  )}
                >
                  <span className="tnum text-[15px] font-semibold">{it.date.slice(8, 10)}</span>
                  <span className="text-[10px] uppercase">{monthLabel(it.date).slice(0, 3)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium">{it.description}</p>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {KIND_LABEL[it.kind]}
                    {it.accountName ? ` · ${it.accountName}` : ''}
                    {late ? ' · atrasado' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Money
                    cents={it.amountCents}
                    direction={it.direction}
                    tone={it.direction === 'in' ? 'positive' : undefined}
                    className="text-[13.5px] font-semibold"
                  />
                  {canWrite && it.canMarkPaid ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void markPaid(it)}
                      className="inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-primary hover:bg-primary-soft disabled:opacity-50"
                    >
                      <Check className="size-3.5" aria-hidden />{' '}
                      {it.direction === 'in' ? 'Recebido' : 'Marcar pago'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </Panel>
  );
}

export function CardUsage({ card }: { card: CardDTO }) {
  const used = card.usedCents;
  const ratio = card.limitCents > 0 ? used / card.limitCents : 0;
  const current = card.currentStatement;
  const future = Math.max(0, used - (current ? current.totalCents - current.paidCents : 0));
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-medium">
          <CreditCard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{card.name}</span>
          {card.last4 ? (
            <span className="tnum shrink-0 text-[12px] font-normal text-muted-foreground">•{card.last4}</span>
          ) : null}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground">
          <Money cents={used} compact /> de <Money cents={card.limitCents} compact />
        </span>
      </div>
      <Meter
        className="mt-2"
        value={used}
        max={card.limitCents || 1}
        tone={ratio > 0.9 ? 'negative' : ratio > 0.7 ? 'warning' : 'accent'}
        label={`Limite usado do ${card.name}`}
      />
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[12px] text-muted-foreground">
        <span>
          Fatura atual: <Money cents={current?.totalCents ?? 0} className="font-medium text-foreground" />
          {current ? ` · vence ${formatDateBR(current.dueDate).slice(0, 5)}` : ''}
        </span>
        <span>
          Parcelas futuras: <Money cents={future} compact />
        </span>
      </div>
    </div>
  );
}

export function CardsPanel({ className }: { className?: string }) {
  const q = useCards();
  return (
    <Panel
      id="cards"
      title="Cartões"
      description="Limite usado, fatura atual e parcelas futuras"
      ask={{ question: 'Como estão as faturas dos meus cartões?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {q.data && q.data.length === 0 ? (
        <EmptyState
          compact
          title="Nenhum cartão cadastrado"
          icon={<CreditCard className="size-5" />}
          prompt="cartão Santander fecha dia 5 e vence dia 12, limite 10 mil"
        />
      ) : (
        <ul className="space-y-4">
          {(q.data ?? []).map((c) => (
            <li key={c.id}>
              <CardUsage card={c} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function PensionPanel({ className }: { className?: string }) {
  const q = usePension();
  const plans = q.data?.plans ?? [];
  const plan = plans[0];
  const last = plan?.entries.at(-1);
  return (
    <Panel
      id="pension"
      title="Previdência"
      description="Saldo mensal e contribuições"
      ask={{ question: 'Como está minha previdência?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {!plan || !last ? (
        <EmptyState
          compact
          title="Nenhum extrato de previdência"
          hint="Anexe o extrato da previdência no chat para acompanhar o saldo."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-[12px] text-muted-foreground">
                {plan.provider} · {plan.name}
              </p>
              <Money cents={last.balanceCents} className="text-xl font-semibold" />
            </div>
            <dl className="flex gap-4 text-[12px]">
              <div>
                <dt className="text-muted-foreground">Participante</dt>
                <dd>
                  <Money cents={last.participantCents} className="font-medium" />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Patrocinadora</dt>
                <dd>
                  <Money cents={last.sponsorCents} className="font-medium" />
                </dd>
              </div>
            </dl>
          </div>
          {plan.entries.length > 1 ? <PensionChart entries={plan.entries} height={170} /> : null}
          <UpdatedAt at={last.refMonth} label="extrato de" />
        </>
      )}
    </Panel>
  );
}

export function AccountsPanel({ className }: { className?: string }) {
  const q = useAccounts();
  return (
    <Panel
      id="accounts"
      title="Contas"
      description="Saldos de hoje"
      ask={{ question: 'Qual o saldo de cada conta?' }}
      className={className}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      {q.data && q.data.length === 0 ? (
        <EmptyState
          compact
          title="Nenhuma conta ainda"
          icon={<Building2 className="size-5" />}
          hint="Comece dizendo:"
          prompt="abri uma conta no BB com 5.000"
        />
      ) : (
        <ul className="-mx-1 divide-y">
          {(q.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-1 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-semibold">
                {a.institution.slice(0, 3).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium">{a.name}</p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {a.lastActivityDate
                    ? `último lançamento ${relativeDays(a.lastActivityDate)}`
                    : 'sem lançamentos'}
                  {a.stale ? (
                    <Badge tone="warning" className="ml-1.5">
                      desatualizada
                    </Badge>
                  ) : null}
                </p>
              </div>
              <div className="text-right">
                <Money
                  cents={a.balanceCents}
                  currency={a.currency}
                  tone={a.balanceCents < 0 ? 'negative' : undefined}
                  className="block text-[13.5px] font-semibold"
                />
                {a.fx ? (
                  <span className="text-[11.5px] text-muted-foreground">
                    ≈ <Money cents={a.balanceBrlCents} />
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export { AskButton };
