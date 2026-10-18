import { withUserContext } from '@sf/db';
import { detectSeasonal, syncSeasonalPlanned } from '@sf/api/domain/seasonal';
import type { WorkerContext } from '../context.js';
import { activeWorkspaces } from './util.js';

/** Aprende o calendário anual do histórico de cada workspace (roda como o dono, como os insights). */
export async function seasonalDaily(ctx: WorkerContext) {
  let created = 0;
  for (const ws of await activeWorkspaces(ctx.sys)) {
    try {
      const r = await withUserContext(ctx.app.db, ws.ownerId, (tx) => detectSeasonal(tx, ws.id, ws.today));
      created += r.created;
    } catch (err) {
      ctx.app.log.error({ err, ws: ws.id }, 'falha ao detectar o calendário anual');
    }
  }
  ctx.app.log.info({ created }, 'calendário anual atualizado');
}

/**
 * Lançamento novo pode pagar uma parcela do calendário: refaz os fluxos planejados (com debounce)
 * para a parcela paga sair da projeção na hora, sem esperar a detecção diária.
 */
export function createDebouncedSeasonalSync(ctx: WorkerContext, delayMs = 2000) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (workspaceId: string) => {
    clearTimeout(timers.get(workspaceId));
    timers.set(
      workspaceId,
      setTimeout(async () => {
        timers.delete(workspaceId);
        try {
          const ws = (await activeWorkspaces(ctx.sys)).find((w) => w.id === workspaceId);
          if (!ws) return;
          const hasItems = await ctx.sys
            .selectFrom('seasonalItems')
            .select('id')
            .where('workspaceId', '=', ws.id)
            .where('status', '=', 'confirmed')
            .executeTakeFirst();
          if (hasItems)
            await withUserContext(ctx.app.db, ws.ownerId, (tx) => syncSeasonalPlanned(tx, ws.id, ws.today));
        } catch (err) {
          ctx.app.log.error({ err, ws: workspaceId }, 'falha ao sincronizar o calendário anual');
        }
      }, delayMs),
    );
  };
}
