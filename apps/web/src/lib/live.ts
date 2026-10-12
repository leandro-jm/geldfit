import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '@sf/shared';
import { apiHeaders, readSSE } from './api';

/**
 * Atualizações em tempo real: GET /api/events (SSE). Usa fetch + stream em vez de EventSource
 * para poder enviar o cabeçalho x-workspace-id (EventSource não aceita cabeçalhos).
 * Cada `data_changed` invalida as queries do workspace (com debounce curto).
 */
export function useLiveUpdates(workspaceId: string | null): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ['ws', workspaceId] }), 250);
    };

    async function connect(): Promise<void> {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch('/api/events', {
            headers: apiHeaders({ accept: 'text/event-stream' }),
            credentials: 'include',
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`events ${res.status}`);
          if (attempt > 0) invalidate(); // reconectou: pode ter perdido eventos
          attempt = 0;
          await readSSE<LiveEvent>(
            res,
            (e) => {
              if (e.type === 'data_changed' && e.workspaceId === workspaceId) invalidate();
            },
            ctrl.signal,
          );
        } catch {
          if (ctrl.signal.aborted) return;
        }
        attempt++;
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    void connect();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, qc]);
}
