import type { ComponentProps, ReactNode } from 'react';
import { DropdownMenu as M, Tooltip as T } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, align = 'end', ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-48 rounded-xl border bg-popover p-1 text-sm shadow-pop outline-none',
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return (
    <M.Item
      className={cn(
        'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <M.Label className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </M.Label>
  );
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />;
}

export const MenuRadioGroup = M.RadioGroup;
export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem
      className={cn(
        'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[highlighted]:bg-muted data-[state=checked]:font-medium',
        className,
      )}
      {...props}
    >
      <span className="flex size-4 items-center justify-center">
        <M.ItemIndicator>
          <span className="block size-2 rounded-full bg-primary" />
        </M.ItemIndicator>
      </span>
      {children}
    </M.RadioItem>
  );
}

export const TooltipProvider = T.Provider;

export function Tip({
  label,
  children,
  side = 'bottom',
}: {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] rounded-lg bg-foreground px-2 py-1 text-xs text-background shadow-pop"
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
