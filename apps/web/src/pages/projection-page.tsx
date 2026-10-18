import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { monthLabel, type SeasonalOccurrenceDTO } from '@sf/shared';
import { useFilters } from '@/lib/filters';
import { useAccounts, useProjection } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Money } from '@/components/common/money';
import { Panel, UpdatedAt } from '@/components/common/panel';
import { EmptyState, PageHeader } from '@/components/common/states';
import { ProjectionChart } from '@/components/charts/charts';
import { MonthDetail, ProjectionLegend } from './dashboard/panels';

/** Marca o mês com itens do calendário anual (âmbar quando há item ainda fora da projeção). */
function SeasonalMark({ items }: { items?: SeasonalOccurrenceDTO[] }) {
  const list = (items ?? []).filter((o) => !o.paid && o.kind !== 'info');
  if (!list.length) return null;
  const pending = list.some((o) => !o.inProjection);
  const label = `Calendário anual: ${list.map((o) => o.label).join(', ')}${pending ? ' (há item a confirmar)' : ''}`;
  return (
    <span role="img" aria-label={label} title={label} className="ml-1.5 inline-flex align-[-2px]">
      <CalendarDays
        className={cn('size-3.5', pending ? 'text-warning' : 'text-muted-foreground')}
        aria-hidden
      />
    </span>
  );
}

export function ProjectionPage() {
  const { accountId, setAccountId } = useFilters();
  const accounts = useAccounts();
  const q = useProjection(accountId);
  const [month, setMonth] = useState<string | null>(null);
  const data = q.data;

  return (
    <div>
      <PageHeader
        title="Projeção"
        description="Saldo mês a mês pelos próximos 24 meses: entradas, saídas, faturas e gasto variável estimado."
        actions={
          <div className="w-full sm:w-56">
            <label htmlFor="proj-account" className="sr-only">
              Conta
            </label>
            <Select
              id="proj-account"
              value={accountId ?? ''}
              onChange={(e) => setAccountId(e.target.value || null)}
            >
              <option value="">Todas as contas (consolidado)</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {data ? (
        <div className="mb-4 grid grid-cols-2 gap-3 @min-[880px]:grid-cols-4">
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Saldo em 24 meses</p>
            <Money
              cents={data.months.at(-1)?.closingCents ?? 0}
              className="mt-1 block text-lg font-semibold"
            />
          </Card>
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Menor saldo</p>
            <Money
              cents={data.minClosing?.cents ?? 0}
              className="mt-1 block text-lg font-semibold"
              tone={(data.minClosing?.cents ?? 0) < 0 ? 'negative' : undefined}
            />
            <p className="text-[12px] text-muted-foreground">
              {data.minClosing ? monthLabel(data.minClosing.month, true) : '—'}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Piso de saldo</p>
            <Money cents={data.floorCents} className="mt-1 block text-lg font-semibold" />
          </Card>
          <Card className="p-4">
            <p className="text-[12.5px] text-muted-foreground">Meses abaixo do piso</p>
            <p
              className={cn(
                'tnum mt-1 text-lg font-semibold',
                data.months.some((m) => m.belowFloor) && 'text-negative',
              )}
            >
              {data.months.filter((m) => m.belowFloor).length}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {data.firstBelowFloor ? `a partir de ${monthLabel(data.firstBelowFloor)}` : 'nenhum'}
            </p>
          </Card>
        </div>
      ) : null}

      <Panel
        id="projection-chart"
        title="Saldo projetado"
        ask={{ question: 'Como melhorar minha projeção nos próximos meses?' }}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonHeight={320}
        fetching={q.isFetching && !q.isPending}
      >
        {data ? (
          <>
            <ProjectionLegend floorCents={data.floorCents} />
            <div className="mt-2">
              <ProjectionChart data={data} height={340} onSelectMonth={setMonth} selected={month} />
            </div>
            {month ? <MonthDetail data={data} month={month} /> : null}
            <UpdatedAt at={data.computedAt} label="calculado em" />
          </>
        ) : null}
      </Panel>

      <section aria-labelledby="month-table" className="mt-5">
        <h2 id="month-table" className="mb-3 text-[15px] font-semibold">
          Mês a mês
        </h2>
        {data && data.months.length === 0 ? (
          <EmptyState title="Sem meses para mostrar" prompt="abri uma conta no BB com 5.000" />
        ) : null}
        {/* Desktop/tablet: tabela densa */}
        <Card className="hidden overflow-hidden @min-[700px]:block">
          <div className="max-h-[560px] overflow-auto scrollbar-thin">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Projeção mês a mês</caption>
              <thead className="sticky top-0 z-10 bg-subtle text-[12px] text-muted-foreground">
                <tr>
                  {[
                    'Mês',
                    'Entradas',
                    'Saídas',
                    'Faturas',
                    'Variável',
                    'Metas',
                    'Saldo base',
                    'Otimista',
                    'Pessimista',
                  ].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={cn(
                        'whitespace-nowrap px-3 py-2.5 font-medium',
                        i === 0 ? 'text-left' : 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.months ?? []).map((m) => (
                  <tr
                    key={m.month}
                    onClick={() => setMonth(m.month)}
                    className={cn(
                      'cursor-pointer border-t hover:bg-subtle',
                      m.belowFloor && 'bg-negative-soft/50',
                      month === m.month && 'bg-primary-soft/60',
                    )}
                  >
                    <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium capitalize">
                      {monthLabel(m.month)}
                      <SeasonalMark items={m.seasonal} />
                      {m.belowFloor ? (
                        <Badge tone="negative" className="ml-2">
                          piso
                        </Badge>
                      ) : null}
                    </th>
                    <td className="px-3 text-right">
                      <Money cents={m.incomeCents} tone={m.incomeCents ? 'positive' : 'muted'} />
                    </td>
                    <td className="px-3 text-right">
                      <Money cents={m.expenseCents} tone={m.expenseCents ? undefined : 'muted'} />
                    </td>
                    <td className="px-3 text-right">
                      <Money cents={m.cardBillsCents} tone={m.cardBillsCents ? undefined : 'muted'} />
                    </td>
                    <td className="px-3 text-right">
                      <Money cents={m.variableCents} tone={m.variableCents ? undefined : 'muted'} />
                    </td>
                    <td className="px-3 text-right">
                      <Money cents={m.goalsCents} tone={m.goalsCents ? undefined : 'muted'} />
                    </td>
                    <td className="px-3 text-right font-semibold">
                      <Money cents={m.closingCents} tone={m.closingCents < 0 ? 'negative' : undefined} />
                    </td>
                    <td className="px-3 text-right text-muted-foreground">
                      <Money cents={m.closingOptimisticCents} />
                    </td>
                    <td className="px-3 text-right text-muted-foreground">
                      <Money cents={m.closingPessimisticCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        {/* Celular: lista de cards */}
        <ul className="space-y-2 @min-[700px]:hidden">
          {(data?.months ?? []).map((m) => (
            <li key={m.month}>
              <Card className={cn('p-3.5', m.belowFloor && 'border-negative/40')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[14px] font-semibold capitalize">
                    {monthLabel(m.month, true)}
                    <SeasonalMark items={m.seasonal} />
                  </span>
                  <Money
                    cents={m.closingCents}
                    tone={m.closingCents < 0 ? 'negative' : undefined}
                    className="text-[15px] font-semibold"
                  />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Entradas</dt>
                    <dd>
                      <Money cents={m.incomeCents} tone="positive" />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Saídas</dt>
                    <dd>
                      <Money cents={m.expenseCents} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Faturas</dt>
                    <dd>
                      <Money cents={m.cardBillsCents} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Variável</dt>
                    <dd>
                      <Money cents={m.variableCents} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Otimista</dt>
                    <dd>
                      <Money cents={m.closingOptimisticCents} compact />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Pessimista</dt>
                    <dd>
                      <Money cents={m.closingPessimisticCents} compact />
                    </dd>
                  </div>
                </dl>
                {m.belowFloor ? (
                  <Badge tone="negative" className="mt-2">
                    abaixo do piso
                  </Badge>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
