import { sql } from '@sf/db';
import type { WorkerContext } from '../context.js';

/** LGPD: expurgo real de workspaces excluídos (dados + anexos) e de logins anonimizados. */
export async function purgeDeleted(ctx: WorkerContext) {
  const due = await ctx.sys
    .selectFrom('workspaces')
    .select('id')
    .where('deletedAt', 'is not', null)
    .where('purgeAfter', '<=', new Date())
    .execute();
  for (const w of due) {
    await ctx.app.storage.deletePrefix(w.id);
    await ctx.sys.deleteFrom('workspaces').where('id', '=', w.id).execute();
    ctx.app.log.info({ ws: w.id }, 'workspace expurgado');
  }
  const r = await sql`
    delete from auth_user u where u.email like 'removido-%@invalid.local'
      and not exists (select 1 from memberships m where m.user_id = u.id)
      and not exists (select 1 from workspaces w where w.created_by = u.id)`.execute(ctx.sys);
  return { workspaces: due.length, users: Number(r.numAffectedRows ?? 0) };
}
