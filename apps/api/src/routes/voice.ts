import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUserContext } from '@sf/db';
import { maskSensitive } from '@sf/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { actorOf } from '../lib/http.js';
import { looksLikeRecommendation, SAFE_INVESTMENT_REPLY } from '../agent/compliance.js';
import { assertConversation, createVoiceSession, endVoiceSession, runVoiceTool } from '../voice/realtime.js';

/** Conversa por voz em tempo real: o áudio vai direto do navegador à OpenAI (WebRTC); aqui ficam sessão, ferramentas e histórico. */
export async function voiceRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, guards.ws] };

  f.post('/api/voice/session', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        conversationId: z.string().uuid().nullish(),
        pageContext: z
          .object({ panel: z.string().max(60), detail: z.string().max(300).optional() })
          .nullish(),
        /** Oferta SDP do navegador (obrigatória no GPT-Live, em que o servidor cria a sessão). */
        sdp: z.string().max(50_000).nullish(),
      })
      .parse(req.body ?? {});
    return createVoiceSession(app, actorOf(req), body);
  });

  f.post('/api/voice/tool', pre, async (req) => {
    const body = z
      .object({
        conversationId: z.string().uuid(),
        name: z.string().min(1).max(80),
        arguments: z.string().max(20_000).default('{}'),
      })
      .parse(req.body);
    return runVoiceTool(app, actorOf(req), body);
  });

  /** Grava um turno falado (já transcrito) no histórico do chat. */
  f.post('/api/voice/transcript', pre, async (req) => {
    const body = z
      .object({
        conversationId: z.string().uuid(),
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(8000),
        draftIds: z.array(z.string().uuid()).max(20).default([]),
        visuals: z.array(z.object({ type: z.string() }).passthrough()).max(6).default([]),
      })
      .parse(req.body);
    if (JSON.stringify(body.visuals).length > 200_000) throw new AppError(413, 'Gráfico grande demais.');
    const actor = actorOf(req);
    let text = maskSensitive(body.text);
    let replaced: string | null = null;
    // a fala já saiu, mas o histórico segue o mesmo filtro do chat escrito (CVM 19)
    if (body.role === 'assistant' && looksLikeRecommendation(text)) {
      app.log.warn({ workspaceId: actor.workspaceId }, 'fala bloqueada pelo filtro de recomendação');
      text = replaced = SAFE_INVESTMENT_REPLY;
    }
    const id = await withUserContext(app.db, actor.userId, async (tx) => {
      await assertConversation(tx, actor, body.conversationId);
      const drafts = body.draftIds.length
        ? await tx
            .selectFrom('drafts')
            .select('id')
            .where('id', 'in', body.draftIds)
            .where('conversationId', '=', body.conversationId)
            .execute()
        : [];
      const row = await tx
        .insertInto('messages')
        .values({
          workspaceId: actor.workspaceId,
          conversationId: body.conversationId,
          userId: body.role === 'user' ? actor.userId : null,
          role: body.role,
          content: text,
          parts: JSON.stringify([
            { type: 'voice' },
            ...drafts.map((d) => ({ type: 'draft', draftId: d.id })),
            ...body.visuals.map((v) => ({ type: 'visual', visual: v })),
          ]),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('conversations')
        .set({ lastMessageAt: new Date() })
        .where('id', '=', body.conversationId)
        .execute();
      return row.id;
    });
    return { id, replaced };
  });

  f.post('/api/voice/end', pre, async (req) => {
    const { seconds } = z.object({ seconds: z.number().min(0).max(7200) }).parse(req.body);
    await endVoiceSession(app, actorOf(req), seconds);
    return { ok: true };
  });
}
