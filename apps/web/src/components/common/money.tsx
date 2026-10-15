import { formatBRL, formatBRLCompact, formatUSD, type Currency } from '@sf/shared';
import { cn } from '@/lib/utils';

/** Valor monetário (BRL por padrão) com algarismos tabulares; borra no modo privacidade. */
export function Money({
  cents,
  currency = 'BRL',
  compact,
  signed,
  tone,
  className,
  direction,
}: {
  cents: number;
  currency?: Currency;
  compact?: boolean;
  signed?: boolean;
  tone?: 'auto' | 'positive' | 'negative' | 'muted';
  className?: string;
  direction?: 'in' | 'out';
}) {
  const value = direction === 'out' ? -Math.abs(cents) : direction === 'in' ? Math.abs(cents) : cents;
  let text = currency === 'USD' ? formatUSD(value) : compact ? formatBRLCompact(value) : formatBRL(value);
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
