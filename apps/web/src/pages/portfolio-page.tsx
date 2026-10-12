import { useEffect, useState } from 'react';
import { Bell, Target } from 'lucide-react';
import { toast } from 'sonner';
import { formatDateBR, type AssetClass } from '@sf/shared';
import { api } from '@/lib/api';
import {
  useAction,
  useAllocationTargets,
  useInsightMutes,
  useInsights,
  useInvalidateWorkspace,
  usePortfolio,
  useTrades,
} from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Money } from '@/components/common/money';
import { EmptyState, PageHeader } from '@/components/common/states';
import { CLASS_LABEL } from '@/components/charts/charts';
import { AllocationPanel, InsightItem, PerformancePanel, UsdPanel } from './dashboard/panels';

const CLASSES: AssetClass[] = ['fixed_income', 'equities', 'funds', 'usd', 'pension', 'cash', 'crypto'];
const TRADE_KIND: Record<string, string> = {
  buy: 'Compra',
  sell: 'Venda',
  dividend: 'Dividendo',
  jcp: 'JCP',
  contribution: 'Aporte',
  redemption: 'Resgate',
  split: 'Desdobramento',
  valuation: 'Avaliação',
};

function TargetsForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useAllocationTargets();
  const action = useAction();
  const [rows, setRows] = useState<Record<string, { target: string; min: string; max: string }>>({});
  useEffect(() => {
    if (!open) return;
    const r: Record<string, { target: string; min: string; max: string }> = {};
    for (const c of CLASSES) {
      const t = q.data?.find((x) => x.assetClass === c);
      r[c] = {
        target: t ? String(t.targetPct) : '',
        min: t?.minPct != null ? String(t.minPct) : '',
        max: t?.maxPct != null ? String(t.maxPct) : '',
      };
    }
    setRows(r);
  }, [open, q.data]);
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));
  const total = CLASSES.reduce((s, c) => s + (num(rows[c]?.target ?? '') ?? 0), 0);
  const submit = async () => {
    const targets = CLASSES.filter((c) => num(rows[c]?.target ?? '') !== null).map((c) => ({
      assetClass: c,
      targetPct: num(rows[c]!.target)!,
      minPct: num(rows[c]!.min),
      maxPct: num(rows[c]!.max),
    }));
    try {
      const r = await action.mutateAsync({ kind: 'allocation_targets', payload: { targets } });
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
      title="Alocação-alvo"
      description="Defina a % alvo de cada classe e, se quiser, uma faixa aceitável. É a sua meta — o app só compara."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={action.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <table className="w-full text-[13px]">
        <thead className="text-[12px] text-muted-foreground">
          <tr>
            <th className="pb-2 text-left font-medium">Classe</th>
            <th className="pb-2 font-medium">Alvo %</th>
            <th className="pb-2 font-medium">Mín %</th>
            <th className="pb-2 font-medium">Máx %</th>
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((c) => (
            <tr key={c}>
              <th scope="row" className="py-1 pr-2 text-left font-medium">
                {CLASS_LABEL[c]}
              </th>
              {(['target', 'min', 'max'] as const).map((k) => (
                <td key={k} className="px-1 py-1">
                  <Input
                    aria-label={`${CLASS_LABEL[c]} ${k === 'target' ? 'alvo' : k === 'min' ? 'mínimo' : 'máximo'}`}
                    inputMode="decimal"
                    className="h-9 px-2 text-center tnum"
                    value={rows[c]?.[k] ?? ''}
                    onChange={(e) => setRows({ ...rows, [c]: { ...rows[c]!, [k]: e.target.value } })}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p
        className={cn(
          'mt-3 text-[12.5px]',
          Math.abs(total - 100) > 0.01 && total > 0 ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        Soma dos alvos: {total.toLocaleString('pt-BR')}%
      </p>
    </ResponsiveDialog>
  );
}

export function PortfolioPage() {
  const p = usePortfolio();
  const trades = useTrades();
  const insights = useInsights();
  const mutes = useInsightMutes();
  const invalidate = useInvalidateWorkspace();
  const { canWrite } = useWorkspace();
  const [targets, setTargets] = useState(false);
  const positions = p.data?.positions ?? [];

  const unmute = async (rule: string) => {
    try {
      await api('/api/insights/mute', { method: 'POST', body: { rule, muted: false } });
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };

  return (
    <div>
      <PageHeader
        title="Carteira"
        description="Posições, alocação e desempenho a partir das operações que você informou. O app compara com suas metas e não recomenda compra ou venda."
        actions={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setTargets(true)}>
              <Target aria-hidden /> Alocação-alvo
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4 @min-[620px]:grid-cols-2 @min-[1100px]:grid-cols-3">
        <AllocationPanel />
        <UsdPanel />
        <PerformancePanel className="@min-[620px]:col-span-2 @min-[1100px]:col-span-1" />
      </div>

      <Card className="mt-5">
        <CardHeader title="Posições" description={p.data ? <Money cents={p.data.totalCents} /> : undefined} />
        <CardBody>
          {p.isPending ? (
            <Skeleton className="h-40" />
          ) : positions.length === 0 ? (
            <EmptyState
              compact
              title="Nenhuma posição"
              hint="Informe operações pelo chat ou anexe uma nota de corretagem."
              prompt="comprei 100 ITUB4 a 32,50 na XP"
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto @min-[700px]:block">
                <table className="w-full text-[13px]">
                  <caption className="sr-only">Posições</caption>
                  <thead className="text-[12px] text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 text-left font-medium">Ativo</th>
                      <th className="py-2 text-left font-medium">Classe</th>
                      <th className="py-2 text-right font-medium">Qtd.</th>
                      <th className="py-2 text-right font-medium">Preço médio</th>
                      <th className="py-2 text-right font-medium">Valor</th>
                      <th className="py-2 text-right font-medium">Resultado</th>
                      <th className="py-2 text-right font-medium">Peso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((x) => (
                      <tr key={x.assetId} className="border-b last:border-0">
                        <td className="py-2">
                          <span className="font-medium">{x.ticker ?? x.name}</span>
                          {x.ticker ? (
                            <span className="block max-w-[220px] truncate text-[12px] text-muted-foreground">
                              {x.name}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-muted-foreground">{CLASS_LABEL[x.assetClass] ?? x.assetClass}</td>
                        <td className="tnum text-right">
                          {x.qty.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}
                        </td>
                        <td className="text-right">
                          <Money cents={x.avgPriceCents} />
                        </td>
                        <td className="text-right font-medium">
                          <Money cents={x.marketValueCents} />
                          {x.priceDate ? (
                            <span className="block text-[11px] font-normal text-muted-foreground">
                              cotação {formatDateBR(x.priceDate)}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-right">
                          <Money cents={x.pnlCents} tone="auto" signed />
                        </td>
                        <td className="tnum text-right">
                          {x.weightPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y @min-[700px]:hidden">
                {positions.map((x) => (
                  <li key={x.assetId} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{x.ticker ?? x.name}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {CLASS_LABEL[x.assetClass]} ·{' '}
                        {x.weightPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
                      </p>
                    </div>
                    <div className="text-right">
                      <Money cents={x.marketValueCents} className="block text-[14px] font-semibold" />
                      <Money cents={x.pnlCents} tone="auto" signed className="text-[12px]" />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 grid grid-cols-1 gap-4 @min-[900px]:grid-cols-2">
        <Card>
          <CardHeader title="Insights" description="Ativos, por severidade" />
          <CardBody>
            {insights.isPending ? (
              <Skeleton className="h-24" />
            ) : (insights.data ?? []).length === 0 ? (
              <EmptyState compact title="Nenhum insight ativo" />
            ) : (
              <ul className="space-y-2">
                {[...(insights.data ?? [])]
                  .sort(
                    (a, b) =>
                      ({ critical: 0, warning: 1, info: 2 })[a.severity] -
                      { critical: 0, warning: 1, info: 2 }[b.severity],
                  )
                  .map((i) => (
                    <InsightItem key={i.id} ins={i} />
                  ))}
              </ul>
            )}
            {(mutes.data ?? []).length ? (
              <div className="mt-4 border-t pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground">
                  <Bell className="size-3.5" aria-hidden /> Tipos silenciados
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(mutes.data ?? []).map((m) => (
                    <button
                      key={m.rule}
                      type="button"
                      onClick={() => void unmute(m.rule)}
                      className="h-8 rounded-full border px-3 text-[12px] hover:bg-muted"
                      disabled={!canWrite}
                    >
                      {m.rule} · reativar
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Operações" description="Últimas 500" />
          <CardBody>
            {trades.isPending ? (
              <Skeleton className="h-24" />
            ) : (trades.data ?? []).length === 0 ? (
              <EmptyState compact title="Nenhuma operação" prompt="comprei 2.000 dólares a 5,42" />
            ) : (
              <ul className="max-h-[420px] divide-y overflow-y-auto scrollbar-thin">
                {(trades.data ?? []).map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-[13px]">
                    <span className="tnum w-[76px] shrink-0 text-muted-foreground">
                      {formatDateBR(t.date)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.ticker ?? t.name}</p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        <Badge
                          tone={t.kind === 'sell' || t.kind === 'redemption' ? 'warning' : 'neutral'}
                          className="mr-1"
                        >
                          {TRADE_KIND[t.kind] ?? t.kind}
                        </Badge>
                        {t.qty ? `${t.qty.toLocaleString('pt-BR', { maximumFractionDigits: 4 })} × ` : ''}
                        {t.broker ?? ''}
                        {t.fxRate
                          ? ` · câmbio ${t.fxRate.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}`
                          : ''}
                      </p>
                    </div>
                    <Money cents={t.totalCents} className="shrink-0 font-medium" />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
      <TargetsForm open={targets} onClose={() => setTargets(false)} />
    </div>
  );
}
