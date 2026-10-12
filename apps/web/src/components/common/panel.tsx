import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Clock } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useReducedMotion } from '@/lib/media';
import { cn, formatDateTimeBR } from '@/lib/utils';
import { formatDateBR } from '@sf/shared';
import { AskButton } from './ask';
import { ErrorState } from './states';

export function UpdatedAt({
  at,
  label = 'atualizado em',
}: {
  at: string | null | undefined;
  label?: string;
}) {
  if (!at) return null;
  const text = at.length === 10 ? formatDateBR(at) : formatDateTimeBR(at);
  return (
    <p className="mt-3 flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <Clock className="size-3" aria-hidden />
      {label} <span className="tnum">{text}</span>
    </p>
  );
}

/** Painel do dashboard: título, ação "Perguntar sobre isto", estados de carregamento/erro. */
export function Panel({
  id,
  title,
  description,
  ask,
  actions,
  className,
  children,
  loading,
  error,
  onRetry,
  skeletonHeight = 180,
  fetching,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  ask?: { question: string; detail?: string };
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  skeletonHeight?: number;
  fetching?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.section
      aria-labelledby={`${id}-title`}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn('min-w-0', className)}
      data-panel={id}
    >
      <Card className="flex h-full flex-col">
        <CardHeader
          titleId={`${id}-title`}
          title={title}
          description={description}
          actions={
            <>
              {actions}
              {ask ? <AskButton panel={title} detail={ask.detail} question={ask.question} /> : null}
            </>
          }
        />
        <CardBody className={cn('flex-1 transition-opacity', fetching && 'opacity-70')}>
          {loading ? (
            <div className="space-y-2" aria-busy="true" aria-label={`Carregando ${title}`}>
              <Skeleton className="h-4 w-1/3" />
              <div className="skeleton rounded-lg" style={{ height: skeletonHeight }} aria-hidden />
            </div>
          ) : error ? (
            <ErrorState error={error} onRetry={onRetry} />
          ) : (
            children
          )}
        </CardBody>
      </Card>
    </motion.section>
  );
}
