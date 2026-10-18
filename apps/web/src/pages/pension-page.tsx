import { PiggyBank } from 'lucide-react';
import { monthLabel } from '@sf/shared';
import { usePension } from '@/lib/queries';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { PensionChart } from '@/components/charts/charts';
import { RetirementSection } from './retirement-section';

export function PensionPage() {
  const q = usePension();
  const plans = q.data?.plans ?? [];
  return (
    <div>
      <PageHeader
        title="Previdência"
        description="Histórico de saldo e contribuições a partir dos extratos importados, e o cenário de aposentadoria. O saldo fica fora da projeção de caixa."
      />
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      <div className="space-y-4">
        {q.isPending ? (
          <Skeleton className="h-64" />
        ) : plans.length === 0 ? (
          <EmptyState
            title="Nenhum plano de previdência"
            icon={<PiggyBank className="size-5" />}
            hint="Anexe o extrato da sua previdência no chat e confirme a prévia."
          />
        ) : (
          <div className="space-y-4">
            {plans.map((p) => {
              const last = p.entries.at(-1);
              const totalPart = p.entries.reduce((s, e) => s + e.participantCents, 0);
              const totalSpon = p.entries.reduce((s, e) => s + e.sponsorCents, 0);
              return (
                <Card key={p.id}>
                  <CardHeader title={p.name} description={p.provider} />
                  <CardBody>
                    <div className="grid grid-cols-1 gap-3 @min-[620px]:grid-cols-3">
                      <div className="rounded-xl bg-subtle p-3">
                        <p className="text-[12px] text-muted-foreground">
                          Saldo{last ? ` em ${monthLabel(last.refMonth)}` : ''}
                        </p>
                        <Money cents={last?.balanceCents ?? 0} className="text-lg font-semibold" />
                      </div>
                      <div className="rounded-xl bg-subtle p-3">
                        <p className="text-[12px] text-muted-foreground">Contribuições do participante</p>
                        <Money cents={totalPart} className="text-lg font-semibold" />
                      </div>
                      <div className="rounded-xl bg-subtle p-3">
                        <p className="text-[12px] text-muted-foreground">Contribuições da patrocinadora</p>
                        <Money cents={totalSpon} className="text-lg font-semibold" />
                      </div>
                    </div>
                    {p.entries.length > 1 ? (
                      <div className="mt-4">
                        <PensionChart entries={p.entries} height={240} />
                      </div>
                    ) : null}
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <caption className="sr-only">Extratos de {p.name}</caption>
                        <thead className="text-[12px] text-muted-foreground">
                          <tr className="border-b">
                            <th className="py-2 text-left font-medium">Mês</th>
                            <th className="py-2 text-right font-medium">Saldo</th>
                            <th className="py-2 text-right font-medium">Participante</th>
                            <th className="py-2 text-right font-medium">Patrocinadora</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...p.entries].reverse().map((e) => (
                            <tr key={e.refMonth} className="border-b last:border-0">
                              <td className="py-2 capitalize">{monthLabel(e.refMonth)}</td>
                              <td className="text-right font-medium">
                                <Money cents={e.balanceCents} />
                              </td>
                              <td className="text-right">
                                <Money cents={e.participantCents} />
                              </td>
                              <td className="text-right">
                                <Money cents={e.sponsorCents} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
        {q.isPending ? null : <RetirementSection />}
      </div>
    </div>
  );
}
