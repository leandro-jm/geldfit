import { sql, type Db, withUserContext } from '@sf/db';
import type { DraftDTO } from '@sf/shared';
import type { Actor, AppContext } from '@sf/api/context';

export interface WorkspaceRow {
  id: string;
  timezone: string;
  today: string;
  ownerId: string;
}

/** Workspaces ativos com fuso e "hoje" local (varredura com BYPASSRLS). */
export async function activeWorkspaces(sys: Db): Promise<WorkspaceRow[]> {
  const r = await sql<WorkspaceRow>`
    select w.id, s.timezone, (now() at time zone s.timezone)::date::text as today,
      (select m.user_id from memberships m where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1) as "ownerId"
    from workspaces w join workspace_settings s on s.workspace_id = w.id
    where w.deleted_at is null`.execute(sys);
  return r.rows.filter((w) => w.ownerId);
}

export async function membersOf(sys: Db, ws: string) {
  return sys.selectFrom('memberships').select(['userId', 'role']).where('workspaceId', '=', ws).execute();
}

/** Conversa de WhatsApp do usuário no workspace (cria se preciso). */
export async function whatsappConversation(app: AppContext, actor: Actor): Promise<string> {
  return withUserContext(app.db, actor.userId, async (tx) => {
    const c = await tx
      .selectFrom('conversations')
      .select('id')
      .where('workspaceId', '=', actor.workspaceId)
      .where('userId', '=', actor.userId)
      .where('channel', '=', 'whatsapp')
      .orderBy('lastMessageAt', 'desc')
      .executeTakeFirst();
    if (c) return c.id;
    return (
      await tx
        .insertInto('conversations')
        .values({ workspaceId: actor.workspaceId, userId: actor.userId, channel: 'whatsapp' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
}

/** Registra a mensagem proativa como fala do assistente (para "sim" confirmar o draft ligado a ela). */
export async function postAssistantMessage(
  app: AppContext,
  actor: Actor,
  conversationId: string,
  text: string,
  drafts: DraftDTO[] = [],
) {
  await withUserContext(app.db, actor.userId, async (tx) => {
    await tx
      .insertInto('messages')
      .values({
        workspaceId: actor.workspaceId,
        conversationId,
        role: 'assistant',
        content: text,
        parts: JSON.stringify(drafts.map((d) => ({ type: 'draft', draftId: d.id }))),
      })
      .execute();
    await tx
      .updateTable('conversations')
      .set({ lastMessageAt: new Date() })
      .where('id', '=', conversationId)
      .execute();
  });
}
