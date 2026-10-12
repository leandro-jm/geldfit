import { withUserContext } from '@sf/db';
import { computeProjection } from '@sf/api/domain/projection';
import type { WorkerContext } from '../context.js';
import { activeWorkspaces, membersOf } from './util.js';

/**
 * Recalcula o cache da projeção de cada membro (cada um vê suas contas privadas) e agenda o
 * alerta de saldo abaixo do piso — no máximo 1 por dia por usuário.
 */
export async function refreshWorkspace(ctx: WorkerContext, workspaceId: string) {
  const { app, sys } = ctx;
  const ws = (await activeWorkspaces(sys)).find((w) => w.id === workspaceId);
  if (!ws) return;
  for (const m of await membersOf(sys, workspaceId)) {
    await withUserContext(app.db, m.userId, async (tx) => {
      const proj = await computeProjection(tx, workspaceId);
      const prev = await tx
        .selectFrom('projectionSnapshots')
        .select('firstBelowFloor')
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', m.userId)
        .executeTakeFirst();
      await tx
        .insertInto('projectionSnapshots')
        .values({
          workspaceId,
          userId: m.userId,
          months: JSON.stringify(proj.months),
          firstBelowFloor: proj.firstBelowFloor,
          minClosingCents: proj.minClosing?.cents ?? null,
          computedAt: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(['workspaceId', 'userId']).doUpdateSet({
            months: JSON.stringify(proj.months),
            firstBelowFloor: proj.firstBelowFloor,
            minClosingCents: proj.minClosing?.cents ?? null,
            computedAt: new Date(),
          }),
        )
        .execute();
      if (proj.firstBelowFloor && proj.firstBelowFloor !== prev?.firstBelowFloor) {
        const month = proj.months.find((x) => x.month === proj.firstBelowFloor)!;
        await tx
          .insertInto('reminders')
          .values({
            workspaceId,
            userId: m.userId,
            kind: 'balance_alert',
            fireAt: new Date(),
            payload: JSON.stringify({
              month: month.month,
              closingCents: month.closingCents,
              floorCents: proj.floorCents,
            }),
            dedupeKey: `balance_alert:${workspaceId}:${m.userId}:${ws.today}`,
          })
          .onConflict((oc) => oc.column('dedupeKey').doNothing())
          .execute();
      }
    });
  }
}

export async function refreshAll(ctx: WorkerContext) {
  for (const ws of await activeWorkspaces(ctx.sys)) {
    try {
      await refreshWorkspace(ctx, ws.id);
    } catch (err) {
      ctx.app.log.error({ err, ws: ws.id }, 'falha ao recalcular projeção');
    }
  }
}

/** Recalcula com debounce quando o banco notifica mudanças (trigger + LISTEN). */
export function createDebouncedRefresher(ctx: WorkerContext, delayMs = 1000) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (workspaceId: string) => {
    clearTimeout(timers.get(workspaceId));
    timers.set(
      workspaceId,
      setTimeout(() => {
        timers.delete(workspaceId);
        refreshWorkspace(ctx, workspaceId).catch((err) => ctx.app.log.error({ err }, 'falha no recálculo'));
      }, delayMs),
    );
  };
}
