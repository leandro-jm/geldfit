import type { ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { Drawer } from 'vaul';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/lib/media';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Diálogo centrado no desktop/tablet; bottom sheet (vaul) no celular. */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: SheetProps) {
  const bp = useBreakpoint();
  if (bp === 'phone') {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Drawer.Content
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border-t bg-card outline-none"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
          >
            <div aria-hidden className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-muted" />
            <div className="px-4 pb-2 pt-3">
              <Drawer.Title className="text-base font-semibold">{title}</Drawer.Title>
              {description ? (
                <Drawer.Description className="mt-0.5 text-[13px] text-muted-foreground">
                  {description}
                </Drawer.Description>
              ) : (
                <Drawer.Description className="sr-only">
                  {typeof title === 'string' ? title : ''}
                </Drawer.Description>
              )}
            </div>
            <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-4', className)}>{children}</div>
            {footer ? <div className="flex gap-2 border-t px-4 py-3 [&>*]:flex-1">{footer}</div> : null}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in" />
        <D.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88dvh] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border bg-card shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-5">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-[13px] text-muted-foreground">
                  {description}
                </D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === 'string' ? title : ''}</D.Description>
              )}
            </div>
            <D.Close
              className="-mr-2 -mt-1 rounded-lg p-2 text-muted-foreground hover:bg-muted"
              aria-label="Fechar"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2', className)}>{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Painel lateral (drawer) à direita — usado pelo chat no tablet. */
export function SideSheet({
  open,
  onOpenChange,
  title,
  children,
  width = 420,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content
          className="fixed inset-y-0 right-0 z-50 flex max-w-[100vw] flex-col border-l bg-card shadow-pop outline-none"
          style={{ width }}
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirmar',
  danger,
  onConfirm,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <button
            type="button"
            className="h-10 rounded-[10px] border border-input bg-card px-4 text-sm font-medium hover:bg-subtle"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            className={cn(
              'h-10 rounded-[10px] px-4 text-sm font-medium disabled:opacity-50',
              danger ? 'bg-negative text-white dark:text-[#1a0807]' : 'bg-primary text-primary-foreground',
            )}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </ResponsiveDialog>
  );
}
