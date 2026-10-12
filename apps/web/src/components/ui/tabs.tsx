import type { ComponentProps } from 'react';
import { Tabs as T } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsContent = T.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn(
        'inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-muted p-1 no-scrollbar',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-soft',
        className,
      )}
      {...props}
    />
  );
}

/** Controle segmentado simples (botões com aria-pressed). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-xl bg-muted p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className="h-8 rounded-lg px-3 text-[13px] font-medium text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-soft"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
