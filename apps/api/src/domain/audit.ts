import type { Tx } from '@sf/db';
import type { Actor } from '../context.js';

export async function audit(
  tx: Tx,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
  e: {
    action: string;
    entity: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    draftId?: string | null;
  },
) {
  await tx
    .insertInto('auditLog')
    .values({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId ?? null,
      before: e.before === undefined ? null : JSON.stringify(e.before),
      after: e.after === undefined ? null : JSON.stringify(e.after),
      draftId: e.draftId ?? null,
    })
    .execute();
}
