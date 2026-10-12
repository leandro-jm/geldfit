import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-2xl border bg-card text-card-foreground shadow-soft', className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  titleId,
  as: As = 'h2',
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
  as?: 'h2' | 'h3';
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5', className)}>
      <div className="min-w-0">
        <As id={titleId} className="text-[15px] font-semibold leading-6 tracking-tight">
          {title}
        </As>
        {description ? <div className="mt-0.5 text-[13px] text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4 pt-3 sm:px-5 sm:pb-5', className)} {...props} />;
}
