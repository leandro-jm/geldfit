import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@sf/shared';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { inActor } from '../lib/http.js';
import { usageSummary } from '../lib/llm-budget.js';
import { listMemories, rememberFact, toMemoryDTO } from '../agent/memory.js';
import { getProfile, PROFILE_PATCH_SCHEMA, upsertProfile } from '../domain/profile.js';
import {
  answerNudge,
  dismissNudge,
  listMutes,
  listNudges,
  muteKind,
  nudgeSuggestions,
  prepareNudge,
  refreshNudges,
  snoozeNudge,
  unmuteKind,
} from '../domain/nudges/service.js';

const CONSENT_VERSION = '2026-10';

/** Memória do agente ("O que sei sobre você"), perfil financeiro e uso de LLM em segundo plano. */
export async function agentRoutes(f: FastifyInstance, app: AppContext, guards: { user: any; ws: any }) {
  const pre = { preHandler: [guards.user, guards.ws] };
  const idParam = z.object({ id: z.string().uuid() });

  f.get('/api/memories', pre, async (req) => {
    const { status } = z
      .object({ status: z.enum(['open', 'archived', 'all']).default('open') })
      .parse(req.query);
    const statuses =
      status === 'open'
        ? ['active', 'pending']
        : status === 'archived'
          ? ['archived']
          : ['active', 'pending', 'archived'];
    return inActor(app, req, (tx, a) => listMemories(tx, a, statuses));
  });

  f.post('/api/memories', pre, async (req) => {
    const body = z
      .object({
        content: z.string().min(2).max(300),
        category: z.enum(MEMORY_CATEGORIES),
        shared: z.boolean().default(false),
        sensitive: z.boolean().default(false),
        expiresAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullish(),
      })
      .parse(req.body);
    return inActor(app, req, (tx, a) =>
      rememberFact(tx, a, {
        content: body.content,
        category: body.category,
        scope: body.shared ? 'household' : 'personal',
        sensitive: body.sensitive,
        expiresAt: body.expiresAt ?? null,
        importance: 4,
        source: 'manual',
      }),
    );
  });

  f.patch('/api/memories/:id', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        content: z.string().min(2).max(300).optional(),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        pinned: z.boolean().optional(),
        shared: z.boolean().optional(),
        expiresAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        // confirm: pendente vira ativa; archive/restore: tira ou devolve ao contexto do agente
        action: z.enum(['confirm', 'reject', 'archive', 'restore']).optional(),
      })
      .parse(req.body);
    return inActor(app, req, async (tx, a) => {
      const cur = await tx
        .selectFrom('agentMemories')
        .select(['id', 'sensitive'])
        .where('id', '=', id)
        .where('userId', '=', a.userId)
        .executeTakeFirst();
      if (!cur) throw notFound('Memória');
      const status =
        body.action === 'confirm' || body.action === 'restore'
          ? 'active'
          : body.action === 'reject'
            ? 'rejected'
            : body.action === 'archive'
              ? 'archived'
              : undefined;
      const row = await tx
        .updateTable('agentMemories')
        .set({
          ...(body.content !== undefined ? { content: body.content.trim() } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          ...(body.shared !== undefined && !cur.sensitive
            ? { scope: body.shared ? 'household' : 'personal' }
            : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
          ...(status ? { status } : {}),
          // qualquer edição ou confirmação do usuário vale como revalidação
          confirmedAt: new Date(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toMemoryDTO(row, a.userId);
    });
  });

  f.delete('/api/memories/:id', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    return inActor(app, req, async (tx, a) => {
      const r = await tx
        .deleteFrom('agentMemories')
        .where('id', '=', id)
        .where('userId', '=', a.userId)
        .executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw notFound('Memória');
      return { ok: true };
    });
  });

  // "Esquecer tudo": apaga de verdade a memória do usuário neste workspace
  f.delete('/api/memories', pre, async (req) =>
    inActor(app, req, async (tx, a) => {
      const r = await tx
        .deleteFrom('agentMemories')
        .where('workspaceId', '=', a.workspaceId)
        .where('userId', '=', a.userId)
        .executeTakeFirst();
      return { ok: true, deleted: Number(r.numDeletedRows) };
    }),
  );

  f.get('/api/profile', pre, async (req) => inActor(app, req, (tx, a) => getProfile(tx, a)));

  // Formulário da tela: ação explícita do usuário, grava direto (sem prévia)
  f.put('/api/profile', pre, async (req) => {
    const patch = PROFILE_PATCH_SCHEMA.parse(req.body);
    return inActor(app, req, async (tx, a) => {
      const before = await getProfile(tx, a);
      const after = await upsertProfile(tx, a, patch);
      const consents: Array<'agent_memory' | 'proactive_whatsapp'> = [];
      if (patch.memoryAuto && !before.memoryAuto) consents.push('agent_memory');
      if (patch.nudgeChannels?.includes('whatsapp') && !before.nudgeChannels.includes('whatsapp'))
        consents.push('proactive_whatsapp');
      for (const kind of consents)
        await tx
          .insertInto('consents')
          .values({ userId: a.userId, kind, version: CONSENT_VERSION, ip: req.ip })
          .execute();
      return after;
    });
  });

  // Caixa do assistente: sugestões e perguntas proativas
  f.get('/api/nudges', pre, async (req) => {
    const { scope } = z.object({ scope: z.enum(['open', 'history']).default('open') }).parse(req.query);
    return inActor(app, req, (tx, a) => listNudges(tx, a, scope));
  });
  // Roda os detectores agora (a caixa não precisa esperar o job diário)
  f.post('/api/nudges/refresh', pre, async (req) =>
    inActor(app, req, async (tx, a) => {
      const profile = await getProfile(tx, a);
      if (profile.nudgeFrequency === 'off' || app.config.AGENT_PROACTIVE === 'off') return { created: 0 };
      const r = await refreshNudges(tx, a, {
        onError: (kind, err) => app.log.warn({ err, kind }, 'detector falhou'),
      });
      return { created: r.created };
    }),
  );
  f.get('/api/nudges/suggestions', pre, async (req) => inActor(app, req, (tx, a) => nudgeSuggestions(tx, a)));
  f.post('/api/nudges/:id/prepare', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    return inActor(app, req, (tx, a) => prepareNudge(tx, a, id));
  });
  f.post('/api/nudges/:id/answer', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const { optionId } = z.object({ optionId: z.string().min(1).max(40) }).parse(req.body);
    return inActor(app, req, (tx, a) => answerNudge(tx, a, id, optionId));
  });
  f.post('/api/nudges/:id/snooze', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const { days } = z.object({ days: z.number().int().min(1).max(90).default(7) }).parse(req.body ?? {});
    return inActor(app, req, async (tx, a) => {
      await snoozeNudge(tx, a, id, days);
      return { ok: true };
    });
  });
  f.post('/api/nudges/:id/dismiss', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const { mute } = z.object({ mute: z.boolean().default(false) }).parse(req.body ?? {});
    return inActor(app, req, async (tx, a) => {
      await dismissNudge(tx, a, id, mute);
      return { ok: true };
    });
  });
  f.get('/api/nudges/mutes', pre, async (req) => inActor(app, req, (tx, a) => listMutes(tx, a)));
  f.post('/api/nudges/mute', pre, async (req) => {
    const { kind, muted } = z
      .object({ kind: z.string().regex(/^(cat:)?[a-z_]{3,40}$/), muted: z.boolean() })
      .parse(req.body);
    return inActor(app, req, async (tx, a) => {
      if (muted) await muteKind(tx, a, kind);
      else await unmuteKind(tx, a, kind);
      return { ok: true };
    });
  });

  f.get('/api/agent/usage', pre, async (req) => {
    const a = req.actor!;
    return usageSummary(app, a);
  });
}
