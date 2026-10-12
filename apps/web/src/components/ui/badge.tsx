import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badge = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4 whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        accent: 'bg-primary-soft text-primary-soft-foreground',
        positive: 'bg-positive-soft text-positive',
        negative: 'bg-negative-soft text-negative',
        warning: 'bg-warning-soft text-warning',
        outline: 'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
