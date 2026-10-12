import { cn } from '@/lib/utils';

/** Barra de uso. A trilha é um degrau mais claro do mesmo tom; o preenchimento indica a severidade. */
export function Meter({
  value,
  max = 100,
  tone = 'accent',
  label,
  className,
  marker,
}: {
  value: number;
  max?: number;
  tone?: 'accent' | 'warning' | 'negative' | 'positive';
  label: string;
  className?: string;
  marker?: number | null;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill = {
    accent: 'bg-primary',
    warning: 'bg-[#e0a100]',
    negative: 'bg-negative',
    positive: 'bg-positive',
  }[tone];
  const track = {
    accent: 'bg-primary-soft',
    warning: 'bg-warning-soft',
    negative: 'bg-negative-soft',
    positive: 'bg-positive-soft',
  }[tone];
  const markerPct =
    marker !== null && marker !== undefined && max > 0
      ? Math.max(0, Math.min(100, (marker / max) * 100))
      : null;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('relative h-2 w-full rounded-full', track, className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', fill)}
        style={{ width: `${pct}%` }}
      />
      {markerPct !== null ? (
        <div
          aria-hidden
          className="absolute -top-1 h-4 w-0.5 rounded bg-foreground/70"
          style={{ left: `calc(${markerPct}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}
