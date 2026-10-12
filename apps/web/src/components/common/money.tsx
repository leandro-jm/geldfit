import { formatBRL, formatBRLCompact } from '@sf/shared';
import { cn } from '@/lib/utils';

/** Valor em BRL com algarismos tabulares; borra no modo privacidade. */
export function Money({
  cents,
  compact,
  signed,
  tone,
  className,
  direction,
}: {
  cents: number;
  compact?: boolean;
  signed?: boolean;
  tone?: 'auto' | 'positive' | 'negative' | 'muted';
  className?: string;
  direction?: 'in' | 'out';
}) {
  const value = direction === 'out' ? -Math.abs(cents) : direction === 'in' ? Math.abs(cents) : cents;
  let text = compact ? formatBRLCompact(value) : formatBRL(value);
  if (signed && value > 0) text = `+${text}`;
  const t = tone === 'auto' ? (value > 0 ? 'positive' : value < 0 ? 'negative' : undefined) : tone;
  return (
    <span
      className={cn(
        'money whitespace-nowrap',
        t === 'positive' && 'text-positive',
        t === 'negative' && 'text-negative',
        t === 'muted' && 'text-muted-foreground',
        className,
      )}
    >
      {text}
    </span>
  );
}
