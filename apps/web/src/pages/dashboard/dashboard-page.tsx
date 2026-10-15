import { useSummary } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { useMe } from '@/lib/queries';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { monthLabel } from '@sf/shared';
import { Money } from '@/components/common/money';
import { useChat } from '@/components/chat/chat-context';
import { Button } from '@/components/ui/button';
import {
  AccountsPanel,
  AllocationPanel,
  CardsPanel,
  CategoriesPanel,
  EmergencyReservePanel,
  FlowsPanel,
  InsightsPanel,
  KpiRow,
  PensionPanel,
  PerformancePanel,
  ProjectionPanel,
  SafeToSpendPanel,
  UpcomingPanel,
  UsdPanel,
} from './panels';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function OnboardingHint() {
  const chat = useChat();
  const { canWrite } = useWorkspace();
  if (!canWrite) return null;
  return (
    <div
      className="mb-4 flex flex-col gap-3 rounded-2xl border border-primary/20 bg-primary-soft/60 p-4 sm:flex-row sm:items-center sm:p-5"
      data-testid="onboarding"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Sparkles className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">Vamos começar pela sua primeira conta</p>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground">
          Tudo funciona pelo chat. Comece dizendo:{' '}
          <span className="font-medium text-foreground">“abri uma conta no BB com 5.000”</span>
        </p>
      </div>
      <Button onClick={() => chat.openChat({ text: 'abri uma conta no BB com 5.000' })} className="shrink-0">
        Abrir o chat
      </Button>
    </div>
  );
}

export function DashboardPage() {
  const me = useMe();
  const summary = useSummary();
  const s = summary.data;
  const first = me.data?.user.name.split(' ')[0];
  const isEmpty =
    s &&
    s.netWorthCents === 0 &&
    s.accountsBalanceCents === 0 &&
    s.openBillsCents === 0 &&
    s.lastUpdate === null;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2 sm:mb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Quanto você tem, quanto deve e quanto sobra nos próximos 24 meses.
          </p>
        </div>
      </div>

      {isEmpty ? <OnboardingHint /> : null}

      {s?.alert ? (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2.5 rounded-xl border border-negative/25 bg-negative-soft px-4 py-3 text-[13.5px]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-negative" aria-hidden />
          <p>
            <span className="font-semibold text-negative">Alerta de saldo:</span> em{' '}
            {monthLabel(s.alert.month, true)} o saldo projetado fica em{' '}
            <Money cents={s.alert.cents} className="font-semibold" />, abaixo do seu piso.
          </p>
        </div>
      ) : null}

      {/* Grade por largura do conteúdo (container query): 1 → 2 colunas → 12 colunas quando o chat está recolhido */}
      <div className="grid grid-flow-row-dense grid-cols-1 gap-4 @min-[620px]:grid-cols-2 @min-[1120px]:grid-cols-12 @min-[1120px]:gap-5">
        <div className="@min-[620px]:col-span-2 @min-[1120px]:col-span-12">
          <KpiRow />
        </div>
        {isEmpty ? null : <SafeToSpendPanel className="@min-[620px]:col-span-2 @min-[1120px]:col-span-12" />}
        <ProjectionPanel className="@min-[620px]:col-span-2 @min-[1120px]:col-span-12" />
        <InsightsPanel className="@min-[620px]:order-1 @min-[1120px]:col-span-4" />
        <FlowsPanel className="@min-[620px]:order-2 @min-[620px]:col-span-2 @min-[1120px]:col-span-7" />
        <CategoriesPanel className="@min-[620px]:order-2 @min-[1120px]:col-span-5" />
        <AllocationPanel className="@min-[620px]:order-3 @min-[1120px]:col-span-4" />
        <UsdPanel className="@min-[620px]:order-3 @min-[1120px]:col-span-4" />
        <PerformancePanel className="@min-[620px]:order-3 @min-[1120px]:col-span-4" />
        <UpcomingPanel className="@min-[620px]:order-1 @min-[1120px]:col-span-4" />
        <EmergencyReservePanel className="@min-[620px]:order-1 @min-[1120px]:col-span-4" />
        <CardsPanel className="@min-[620px]:order-2 @min-[1120px]:order-1 @min-[1120px]:col-span-4" />
        <PensionPanel className="@min-[620px]:order-4 @min-[1120px]:col-span-6" />
        <AccountsPanel className="@min-[620px]:order-4 @min-[1120px]:col-span-6" />
      </div>
    </div>
  );
}
