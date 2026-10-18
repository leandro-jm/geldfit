import { sql, withUserContext } from '@sf/db';
import type { AgentUsageDTO } from '@sf/shared';
import type { Actor, AppContext } from '../context.js';

/** Finalidades de LLM em segundo plano (prefixo `bg:` em llm_usage.purpose). */
export type BgPurpose = 'bg:memory' | 'bg:phrase' | 'bg:web_price' | 'bg:web_rules';

/**
 * Pode gastar LLM em segundo plano com este usuário agora? Soma llm_usage do próprio usuário: teto
 * semanal em US$ para tudo que é `bg:` e limites de chamadas por finalidade. O chat continua com o
 * limite diário de mensagens do plano; isto só governa o que o agente faz sozinho.
 */
export async function checkBudget(
  app: AppContext,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
  purpose: BgPurpose,
): Promise<{ ok: boolean; reason?: string }> {
  const cfg = app.config;
  if (cfg.AGENT_PROACTIVE !== 'full') return { ok: false, reason: 'proactive_llm_off' };
  if (purpose.startsWith('bg:web') && !cfg.AGENT_WEB_TOOLS) return { ok: false, reason: 'web_tools_off' };
  const u = await withUserContext(app.db, actor.userId, async (tx) => {
    const r = await sql<{ dayCalls: number; webCalls: number; micro: number }>`
      select
        count(*) filter (where purpose = ${purpose} and at > now() - interval '1 day')::int as "dayCalls",
        count(*) filter (where purpose like 'bg:web%')::int as "webCalls",
        coalesce(sum(cost_micro_usd), 0)::bigint as micro
      from llm_usage
      where user_id = ${actor.userId} and purpose like 'bg:%' and at > now() - interval '7 days'`.execute(tx);
    const row = r.rows[0]!;
    return { dayCalls: Number(row.dayCalls), webCalls: Number(row.webCalls), micro: Number(row.micro) };
  });
  if (u.micro >= cfg.AGENT_BG_WEEKLY_USD * 1_000_000) return { ok: false, reason: 'weekly_usd' };
  if (purpose === 'bg:memory' && u.dayCalls >= cfg.AGENT_MEMORY_DAILY)
    return { ok: false, reason: 'daily_calls' };
  if (purpose === 'bg:phrase' && u.dayCalls >= cfg.AGENT_PHRASE_DAILY)
    return { ok: false, reason: 'daily_calls' };
  if (purpose.startsWith('bg:web') && u.webCalls >= cfg.AGENT_WEB_WEEKLY)
    return { ok: false, reason: 'weekly_calls' };
  return { ok: true };
}

/** Gasto da semana em segundo plano, por finalidade (tela de proatividade). */
export async function usageSummary(
  app: AppContext,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
): Promise<AgentUsageDTO> {
  const rows = await withUserContext(app.db, actor.userId, async (tx) => {
    const r = await sql<{ purpose: string; calls: number; micro: number }>`
      select purpose, count(*)::int as calls, coalesce(sum(cost_micro_usd), 0)::bigint as micro
      from llm_usage
      where user_id = ${actor.userId} and purpose like 'bg:%' and at > now() - interval '7 days'
      group by purpose order by purpose`.execute(tx);
    return r.rows;
  });
  const byPurpose = rows.map((r) => ({
    purpose: r.purpose,
    calls: Number(r.calls),
    usd: Number(r.micro) / 1_000_000,
  }));
  return {
    proactive: app.config.AGENT_PROACTIVE,
    weekUsd: byPurpose.reduce((s, p) => s + p.usd, 0),
    weekLimitUsd: app.config.AGENT_BG_WEEKLY_USD,
    byPurpose,
  };
}
