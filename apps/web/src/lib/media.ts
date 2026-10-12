import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

export function useBreakpoint(): Breakpoint {
  const desktop = useMediaQuery('(min-width: 1024px)');
  const tablet = useMediaQuery('(min-width: 768px)');
  return desktop ? 'desktop' : tablet ? 'tablet' : 'phone';
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
