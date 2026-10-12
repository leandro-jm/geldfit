import { withUserContext } from '@sf/db';
import { refreshInsights } from '@sf/api/domain/insights';
import type { WorkerContext } from '../context.js';
import { activeWorkspaces } from './util.js';

export async function insightsDaily(ctx: WorkerContext) {
  let created = 0;
  for (const ws of await activeWorkspaces(ctx.sys)) {
    try {
      const r = await withUserContext(ctx.app.db, ws.ownerId, (tx) => refreshInsights(tx, ws.id, ws.today));
      created += r.created;
    } catch (err) {
      ctx.app.log.error({ err, ws: ws.id }, 'falha ao calcular insights');
    }
  }
  ctx.app.log.info({ created }, 'insights atualizados');
}
