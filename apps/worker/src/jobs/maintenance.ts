import { sql } from '@sf/db';
import { withUserContext } from '@sf/db';
import { autoPostDue, materializeRecurrence } from '@sf/api/domain/ledger';
import type { WorkerContext } from '../context.js';
import { activeWorkspaces } from './util.js';

/**
 * Manutenção diária (05:00): posta recorrências automáticas vencidas, estende o horizonte das
 * recorrências, atualiza status das faturas e expira drafts. Usa o pool de sistema.
 */
export async function dailyMaintenance(ctx: WorkerContext) {
  const { sys, app } = ctx;
  let materialized = 0;
  let posted = 0;
  for (const ws of await activeWorkspaces(sys)) {
    await sys.transaction().execute(async (tx) => {
      posted += await autoPostDue(tx, ws.id, ws.today);
      const recs = await tx
        .selectFrom('recurrences')
        .select('id')
        .where('workspaceId', '=', ws.id)
        .where('pausedAt', 'is', null)
        .execute();
      for (const r of recs) materialized += await materializeRecurrence(tx, r.id, ws.today);
      // fatura fechada / paga
      await sql`
        update card_statements cs set status = case
          when t.total_cents > 0 and t.paid_cents >= t.total_cents then 'paid'
          when cs.closing_date <= ${ws.today}::date then 'closed' else 'open' end
        from card_statement_totals t where t.id = cs.id and cs.workspace_id = ${ws.id}::uuid and cs.status <> 'paid'`.execute(
        tx,
      );
    });
  }
  const expired = await sys
    .updateTable('drafts')
    .set({ status: 'expired', decidedAt: new Date() })
    .where('status', '=', 'pending')
    .where('expiresAt', '<', new Date())
    .executeTakeFirst();
  app.log.info(
    { materialized, posted, expiredDrafts: Number(expired.numUpdatedRows) },
    'manutenção diária concluída',
  );
  void withUserContext;
}
