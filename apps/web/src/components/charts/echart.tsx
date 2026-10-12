import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  AriaComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { formatBRL, formatBRLCompact } from '@sf/shared';
import { usePrefs } from '@/lib/prefs';
import { useReducedMotion } from '@/lib/media';
import { cn } from '@/lib/utils';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  AriaComponent,
  SVGRenderer,
]);

/** Tokens de gráfico lidos das variáveis CSS do tema atual (claro/escuro). */
export interface ChartTheme {
  surface: string;
  grid: string;
  axis: string;
  label: string;
  text: string;
  muted: string;
  series: string[];
  inColor: string;
  outColor: string;
  floor: string;
  popover: string;
  border: string;
}

export function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    surface: v('--chart-surface'),
    grid: v('--chart-grid'),
    axis: v('--chart-axis'),
    label: v('--chart-label'),
    text: v('--foreground'),
    muted: v('--muted-foreground'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--chart-${i}`)),
    inColor: v('--chart-in'),
    outColor: v('--chart-out'),
    floor: v('--chart-floor'),
    popover: v('--popover'),
    border: v('--border'),
  };
}

export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = usePrefs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readChartTheme(), [resolvedTheme]);
}

/** Eixo/tooltip comuns: grade em linha fina sólida, rótulos BRL compactos. */
export function baseOption(t: ChartTheme, narrow: boolean): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif', color: t.label },
    animationDuration: 400,
    grid: { left: 8, right: narrow ? 8 : 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: t.popover,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: t.text, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px -8px rgba(0,0,0,.25);',
      axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 } },
    },
  };
}

export const moneyAxis = (t: ChartTheme) => ({
  type: 'value' as const,
  axisLabel: { color: t.label, fontSize: 11, formatter: (v: number) => formatBRLCompact(v) },
  splitLine: { lineStyle: { color: t.grid, width: 1, type: 'solid' as const } },
  axisLine: { show: false },
  axisTick: { show: false },
});

export const categoryAxis = (t: ChartTheme, data: string[], extra: Record<string, unknown> = {}) => ({
  type: 'category' as const,
  data,
  axisLine: { lineStyle: { color: t.axis } },
  axisTick: { show: false },
  axisLabel: { color: t.label, fontSize: 11, hideOverlap: true },
  ...extra,
});

/** Linha de tooltip: traço curto na cor da série, valor em destaque, nome secundário. Texto escapado. */
export function tooltipRow(color: string, name: string, cents: number, dashed = false): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<div style="display:flex;align-items:center;gap:8px;margin-top:3px"><span style="display:inline-block;width:12px;height:0;border-top:2px ${dashed ? 'dashed' : 'solid'} ${color}"></span><b style="font-variant-numeric:tabular-nums">${esc(formatBRL(cents))}</b><span style="opacity:.75">${esc(name)}</span></div>`;
}

export function tooltipTitle(s: string): string {
  return `<div style="font-weight:600;margin-bottom:2px">${s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</div>`;
}

export function EChart({
  option,
  height,
  className,
  ariaLabel,
  onClick,
}: {
  option: EChartsCoreOption;
  height: number;
  className?: string;
  ariaLabel: string;
  onClick?: (p: { dataIndex: number; seriesName?: string; name?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const reduced = useReducedMotion();
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    inst.current = chart;
    chart.on('click', (p) =>
      clickRef.current?.(p as unknown as { dataIndex: number; seriesName?: string; name?: string }),
    );
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    inst.current?.setOption(
      { ...option, animation: !reduced && (option as { animation?: boolean }).animation !== false },
      { notMerge: true },
    );
  }, [option, reduced]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={cn('sensitive w-full min-w-0', className)}
      style={{ height }}
    />
  );
}
