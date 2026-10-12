import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import {
  formatBRL,
  monthLabel,
  MONTHS_SHORT,
  parseISO,
  type MonthlyFlow,
  type PortfolioDTO,
  type ProjectionDTO,
} from '@sf/shared';
import { useBreakpoint } from '@/lib/media';
import {
  baseOption,
  categoryAxis,
  EChart,
  moneyAxis,
  tooltipRow,
  tooltipTitle,
  useChartTheme,
} from './echart';

export function shortMonth(iso: string): string {
  const { y, m } = parseISO(iso);
  return `${MONTHS_SHORT[m - 1]}/${String(y).slice(2)}`;
}

/** Projeção 24 meses: linha base + faixa otimista/pessimista + linha de piso; meses abaixo do piso destacados. */
export function ProjectionChart({
  data,
  height = 300,
  onSelectMonth,
  selected,
}: {
  data: ProjectionDTO;
  height?: number;
  onSelectMonth?: (month: string) => void;
  selected?: string | null;
}) {
  const t = useChartTheme();
  const narrow = useBreakpoint() === 'phone';
  const option = useMemo<EChartsCoreOption>(() => {
    const months = data.months;
    const labels = months.map((m) => shortMonth(m.month));
    const below = months.filter((m) => m.belowFloor);
    const accent = t.series[0]!;
    return {
      ...baseOption(t, narrow),
      tooltip: {
        ...(baseOption(t, narrow).tooltip as object),
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const m = months[ps[0]?.dataIndex ?? 0];
          if (!m) return '';
          return (
            tooltipTitle(monthLabel(m.month, true)) +
            tooltipRow(accent, 'Saldo base', m.closingCents) +
            tooltipRow(accent, 'Otimista', m.closingOptimisticCents, true) +
            tooltipRow(accent, 'Pessimista', m.closingPessimisticCents, true) +
            tooltipRow(t.floor, 'Piso', data.floorCents, true) +
            (m.belowFloor
              ? `<div style="margin-top:4px;color:${t.floor};font-weight:600">Abaixo do piso</div>`
              : '')
          );
        },
      },
      xAxis: categoryAxis(t, labels, {
        boundaryGap: false,
        axisLabel: { color: t.label, fontSize: 11, hideOverlap: true, interval: narrow ? 5 : 2 },
      }),
      yAxis: moneyAxis(t),
      series: [
        {
          name: 'Pessimista',
          type: 'line',
          stack: 'band',
          stackStrategy: 'all',
          data: months.map((m) => m.closingPessimisticCents),
          lineStyle: { opacity: 0 },
          symbol: 'none',
          silent: true,
        },
        {
          name: 'Faixa otimista–pessimista',
          type: 'line',
          stack: 'band',
          stackStrategy: 'all',
          data: months.map((m) => m.closingOptimisticCents - m.closingPessimisticCents),
          lineStyle: { opacity: 0 },
          areaStyle: { color: accent, opacity: 0.12 },
          symbol: 'none',
          silent: true,
        },
        {
          name: 'Saldo base',
          type: 'line',
          data: months.map((m) => ({
            value: m.closingCents,
            itemStyle: m.belowFloor ? { color: t.floor } : undefined,
            symbolSize: m.belowFloor || m.month === selected ? 8 : 0,
          })),
          lineStyle: { width: 2, color: accent, cap: 'round', join: 'round' },
          itemStyle: { color: accent, borderColor: t.surface, borderWidth: 2 },
          symbol: 'circle',
          showSymbol: true,
          emphasis: { scale: 1.4 },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: t.floor, width: 1.5, type: [6, 4] },
            label: {
              show: !narrow,
              position: 'insideEndTop',
              color: t.label,
              fontSize: 11,
              formatter: `Piso ${formatBRL(data.floorCents)}`,
            },
            data: [{ yAxis: data.floorCents }],
          },
          markArea: below.length
            ? {
                silent: true,
                itemStyle: { color: t.floor, opacity: 0.07 },
                data: below.map((m) => [{ xAxis: shortMonth(m.month) }, { xAxis: shortMonth(m.month) }]),
              }
            : undefined,
        },
      ],
    };
  }, [data, t, narrow, selected]);
  return (
    <EChart
      option={option}
      height={height}
      ariaLabel={`Projeção de saldo para ${data.months.length} meses. Menor saldo: ${data.minClosing ? `${formatBRL(data.minClosing.cents)} em ${monthLabel(data.minClosing.month, true)}` : 'sem dados'}.`}
      onClick={(p) => {
        const m = data.months[p.dataIndex];
        if (m) onSelectMonth?.(m.month);
      }}
    />
  );
}

/** Receitas x despesas: 12 meses realizados + 3 projetados (barras agrupadas; projetados esmaecidos). */
export function FlowsChart({ data, height = 260 }: { data: MonthlyFlow[]; height?: number }) {
  const t = useChartTheme();
  const narrow = useBreakpoint() === 'phone';
  const option = useMemo<EChartsCoreOption>(() => {
    const labels = data.map((d) => shortMonth(d.month));
    const firstProjected = data.findIndex((d) => d.projected);
    const bar = (key: 'incomeCents' | 'expenseCents', color: string) =>
      data.map((d) => ({
        value: d[key],
        itemStyle: d.projected
          ? { color, opacity: 0.38, borderRadius: [4, 4, 0, 0] }
          : { color, borderRadius: [4, 4, 0, 0] },
      }));
    return {
      ...baseOption(t, narrow),
      legend: { show: false },
      tooltip: {
        ...(baseOption(t, narrow).tooltip as object),
        axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.5 } },
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const d = data[ps[0]?.dataIndex ?? 0];
          if (!d) return '';
          return (
            tooltipTitle(`${monthLabel(d.month, true)}${d.projected ? ' (projetado)' : ''}`) +
            tooltipRow(t.inColor, 'Receitas', d.incomeCents) +
            tooltipRow(t.outColor, 'Despesas', d.expenseCents) +
            tooltipRow(t.label, 'Saldo do mês', d.incomeCents - d.expenseCents)
          );
        },
      },
      xAxis: categoryAxis(t, labels, {
        axisLabel: { color: t.label, fontSize: 11, hideOverlap: true, interval: narrow ? 2 : 0 },
      }),
      yAxis: moneyAxis(t),
      series: [
        {
          name: 'Receitas',
          type: 'bar',
          data: bar('incomeCents', t.inColor),
          barMaxWidth: 14,
          barGap: '15%',
          markArea:
            firstProjected >= 0
              ? {
                  silent: true,
                  itemStyle: { color: t.grid, opacity: 0.45 },
                  label: {
                    show: true,
                    position: 'insideTop',
                    color: t.label,
                    fontSize: 10,
                    formatter: 'Projetado',
                  },
                  data: [[{ xAxis: labels[firstProjected] }, { xAxis: labels.at(-1) }]],
                }
              : undefined,
        },
        { name: 'Despesas', type: 'bar', data: bar('expenseCents', t.outColor), barMaxWidth: 14 },
      ],
    };
  }, [data, t, narrow]);
  return (
    <EChart
      option={option}
      height={height}
      ariaLabel="Receitas e despesas por mês: 12 meses realizados e 3 projetados."
    />
  );
}

export const CLASS_LABEL: Record<string, string> = {
  fixed_income: 'Renda fixa',
  equities: 'Ações',
  funds: 'Fundos',
  usd: 'Dólar',
  pension: 'Previdência',
  cash: 'Caixa',
  crypto: 'Cripto',
};

const CLASS_ORDER = ['fixed_income', 'equities', 'funds', 'usd', 'pension', 'cash', 'crypto'];
export function classColor(t: { series: string[] }, cls: string): string {
  const i = CLASS_ORDER.indexOf(cls);
  return t.series[i >= 0 ? i : 7]!;
}

/** Alocação atual por classe (rosca). A cor segue a classe, nunca a posição. */
export function AllocationDonut({ data, height = 200 }: { data: PortfolioDTO['byClass']; height?: number }) {
  const t = useChartTheme();
  const option = useMemo<EChartsCoreOption>(
    () => ({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: t.popover,
        borderColor: t.border,
        textStyle: { color: t.text, fontSize: 12 },
        extraCssText: 'border-radius:10px;',
        formatter: (p: { name: string; value: number; percent: number; color: string }) =>
          tooltipTitle(p.name) +
          tooltipRow(p.color, `${p.percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`, p.value),
      },
      series: [
        {
          type: 'pie',
          radius: ['58%', '86%'],
          padAngle: 1.5,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          data: data
            .filter((c) => c.valueCents > 0)
            .map((c) => ({
              name: CLASS_LABEL[c.assetClass] ?? c.assetClass,
              value: c.valueCents,
              itemStyle: { color: classColor(t, c.assetClass) },
            })),
        },
      ],
    }),
    [data, t],
  );
  return <EChart option={option} height={height} ariaLabel="Alocação da carteira por classe de ativo." />;
}

/** Desempenho: carteira vs CDI, IBOV e IPCA por período (barras agrupadas, um eixo em %). */
export function PerformanceChart({
  data,
  height = 220,
}: {
  data: PortfolioDTO['performance'];
  height?: number;
}) {
  const t = useChartTheme();
  const narrow = useBreakpoint() === 'phone';
  const option = useMemo<EChartsCoreOption>(() => {
    const periods = { month: 'Mês', '12m': '12 meses', inception: 'Desde o início' } as const;
    const series = [
      { key: 'portfolioPct', name: 'Carteira', color: t.series[0]! },
      { key: 'cdiPct', name: 'CDI', color: t.series[1]! },
      { key: 'ibovPct', name: 'IBOV', color: t.series[2]! },
      { key: 'ipcaPct', name: 'IPCA', color: t.series[6]! },
    ] as const;
    const fmt = (v: number | null) =>
      v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    return {
      ...baseOption(t, narrow),
      grid: { left: 8, right: 8, top: 36, bottom: 4, containLabel: true },
      legend: {
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: t.label, fontSize: 11 },
      },
      tooltip: {
        ...(baseOption(t, narrow).tooltip as object),
        axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.5 } },
        valueFormatter: (v: number | null) => fmt(v),
      },
      xAxis: categoryAxis(
        t,
        data.map((d) => periods[d.period]),
      ),
      yAxis: {
        type: 'value',
        axisLabel: { color: t.label, fontSize: 11, formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: t.grid } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'bar',
        barMaxWidth: 16,
        barGap: '20%',
        itemStyle: { color: s.color, borderRadius: 4 },
        data: data.map((d) => d[s.key]),
      })),
    };
  }, [data, t, narrow]);
  return (
    <EChart
      option={option}
      height={height}
      ariaLabel="Desempenho da carteira comparado a CDI, IBOV e IPCA."
    />
  );
}

/** Previdência: saldo mensal (linha). */
export function PensionChart({
  entries,
  height = 200,
}: {
  entries: Array<{ refMonth: string; balanceCents: number }>;
  height?: number;
}) {
  const t = useChartTheme();
  const narrow = useBreakpoint() === 'phone';
  const option = useMemo<EChartsCoreOption>(() => {
    const accent = t.series[6]!;
    return {
      ...baseOption(t, narrow),
      tooltip: {
        ...(baseOption(t, narrow).tooltip as object),
        formatter: (ps: Array<{ dataIndex: number }>) => {
          const e = entries[ps[0]?.dataIndex ?? 0];
          return e
            ? tooltipTitle(monthLabel(e.refMonth, true)) + tooltipRow(accent, 'Saldo', e.balanceCents)
            : '';
        },
      },
      xAxis: categoryAxis(
        t,
        entries.map((e) => shortMonth(e.refMonth)),
        { boundaryGap: false },
      ),
      yAxis: moneyAxis(t),
      series: [
        {
          type: 'line',
          name: 'Saldo',
          data: entries.map((e) => e.balanceCents),
          lineStyle: { width: 2, color: accent },
          itemStyle: { color: accent, borderColor: t.surface, borderWidth: 2 },
          symbolSize: 8,
          areaStyle: { color: accent, opacity: 0.1 },
        },
      ],
    };
  }, [entries, t, narrow]);
  return <EChart option={option} height={height} ariaLabel="Saldo mensal da previdência." />;
}
