import { withUserContext } from '@sf/db';
import type { Usage } from '@sf/llm';
import type { Actor, AppContext } from '../context.js';

/** Registra tokens e custo por workspace (observabilidade e margem por plano). */
export async function recordUsage(
  app: AppContext,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
  provider: string,
  model: string,
  purpose: string,
  u: Usage,
  latencyMs?: number,
) {
  try {
    await withUserContext(app.db, actor.userId, (tx) =>
      tx
        .insertInto('llmUsage')
        .values({
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          provider,
          model,
          purpose,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          costMicroUsd: u.costMicroUsd,
          latencyMs: latencyMs ?? null,
        })
        .execute(),
    );
  } catch (err) {
    app.log.warn({ err }, 'falha ao registrar uso de LLM');
  }
}
