import { conversationsPendingMemory, extractConversationMemories } from '@sf/api/agent/memory';
import type { WorkerContext } from '../context.js';

/**
 * Extrai memória das conversas paradas há alguns minutos (a conversa "assentou"). Só chama o LLM
 * quando há fala do usuário com sinal pessoal e orçamento; o resto apenas avança o cursor.
 */
export async function memoryExtraction(ctx: WorkerContext, opts: { idleMinutes?: number } = {}) {
  if (ctx.app.config.AGENT_PROACTIVE !== 'full') return { processed: 0, extracted: 0 };
  const convs = await conversationsPendingMemory(ctx.sys, opts.idleMinutes ?? 3);
  let extracted = 0;
  for (const c of convs) {
    try {
      const r = await extractConversationMemories(ctx.app, c, c.id);
      if (r.status === 'done') extracted += r.result.created + r.result.updated + r.result.archived;
    } catch (err) {
      ctx.app.log.error({ err, conversation: c.id }, 'falha na extração de memória');
    }
  }
  if (extracted) ctx.app.log.info({ conversations: convs.length, extracted }, 'memória atualizada');
  return { processed: convs.length, extracted };
}
