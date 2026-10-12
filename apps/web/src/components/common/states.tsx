import type { ReactNode } from 'react';
import { AlertTriangle, MessageCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChat } from '@/components/chat/chat-context';
import { cn } from '@/lib/utils';

/** Estado vazio que guia o usuário para o chat. */
export function EmptyState({
  title,
  hint,
  prompt,
  icon,
  className,
  compact,
  children,
}: {
  title: string;
  hint?: ReactNode;
  prompt?: string;
  icon?: ReactNode;
  className?: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  const chat = useChat();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed bg-subtle/60 px-4 text-center',
        compact ? 'py-6' : 'py-10',
        className,
      )}
    >
      <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
        {icon ?? <Sparkles className="size-5" aria-hidden />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{hint}</p> : null}
      {prompt ? (
        <Button
          variant="soft"
          size="sm"
          className="mt-3 h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
          onClick={() => chat.openChat({ text: prompt })}
        >
          <MessageCircle aria-hidden />
          <span>“{prompt}”</span>
        </Button>
      ) : null}
      {children}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const msg = error instanceof Error ? error.message : 'Não foi possível carregar.';
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl bg-negative-soft/60 px-4 py-6 text-center text-sm',
        className,
      )}
    >
      <AlertTriangle className="size-5 text-negative" aria-hidden />
      <p>{msg}</p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden /> Tentar de novo
        </Button>
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
