import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withUserContext } from '@sf/db';
import type { ChatMessageDTO, ChatStreamEvent, ChatVisual } from '@sf/shared';
import type { AppContext } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import { actorOf, inActor, openSSE } from '../lib/http.js';
import { handleMessage } from '../agent/orchestrator.js';
import { cancelDraft, confirmDraft, DRAFT_SCHEMAS, toDraftDTO, type DraftKind } from '../domain/drafts.js';
import { MAX_AUDIO_BYTES, transcribeAudio } from '../import/audio.js';
import { MAX_UPLOAD_BYTES, saveAttachment } from '../import/service.js';
import type { DataChangeNotifier } from '../realtime/notifier.js';

export async function chatRoutes(
  f: FastifyInstance,
  app: AppContext,
  guards: { user: any; ws: any },
  notifier: DataChangeNotifier,
) {
  const pre = { preHandler: [guards.user, guards.ws] };

  /** Chat com streaming (SSE): text_delta, tool, draft, confirmed, message_end. */
  f.post('/api/chat', pre, async (req, reply) => {
    const body = z
      .object({
        text: z.string().max(4000).default(''),
        conversationId: z.string().uuid().nullish(),
        attachmentIds: z.array(z.string().uuid()).max(5).default([]),
        pageContext: z
          .object({ panel: z.string().max(60), detail: z.string().max(300).optional() })
          .nullish(),
        voice: z.boolean().optional(),
      })
      .parse(req.body);
    const actor = actorOf(req);
    const stream = openSSE(req, reply, app.config.PUBLIC_WEB_URL);
    const emit = (e: ChatStreamEvent) => stream.send(e);
    try {
      const res = await handleMessage(app, actor, body, emit);
      stream.send({ type: 'done', conversationId: res.conversationId, messageId: res.messageId });
    } catch (err) {
      stream.send({
        type: 'error',
        message: err instanceof AppError ? err.message : 'Erro ao processar a mensagem.',
      } satisfies ChatStreamEvent);
      if (!(err instanceof AppError)) app.log.error({ err }, 'erro no chat');
    } finally {
      stream.end();
    }
  });

  /** Ditado: transcreve o áudio gravado no navegador; o texto volta para a caixa de mensagem. */
  f.post('/api/chat/transcribe', pre, async (req) => {
    const actor = actorOf(req);
    const file = await req.file({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });
    if (!file) throw new AppError(400, 'Nenhum áudio enviado.');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'Áudio longo demais.');
    return { text: await transcribeAudio(app, actor, { data, mime: file.mimetype }) };
  });

  f.get('/api/chat/history', pre, async (req) => {
    const q = z
      .object({
        conversationId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        // all: junta a conversa do WhatsApp (lembretes, sugestões e respostas) ao histórico da web
        scope: z.enum(['web', 'all']).default('web'),
      })
      .parse(req.query);
    return inActor(app, req, async (tx, a) => {
      const conv = q.conversationId
        ? { id: q.conversationId }
        : await tx
            .selectFrom('conversations')
            .select('id')
            .where('workspaceId', '=', a.workspaceId)
            .where('userId', '=', a.userId)
            .where('channel', '=', 'web')
            .orderBy('lastMessageAt', 'desc')
            .executeTakeFirst();
      const wa =
        q.scope === 'all' && !q.conversationId
          ? await tx
              .selectFrom('conversations')
              .select('id')
              .where('workspaceId', '=', a.workspaceId)
              .where('userId', '=', a.userId)
              .where('channel', '=', 'whatsapp')
              .orderBy('lastMessageAt', 'desc')
              .executeTakeFirst()
          : null;
      const convIds = [conv?.id, wa?.id].filter((x): x is string => Boolean(x));
      if (!convIds.length) return { conversationId: null, messages: [] };
      const rows = await tx
        .selectFrom('messages')
        .select(['id', 'role', 'content', 'parts', 'createdAt', 'conversationId'])
        .where('conversationId', 'in', convIds)
        .where('role', 'in', ['user', 'assistant'])
        .orderBy('createdAt', 'desc')
        .limit(q.limit)
        .execute();
      const draftIds = rows.flatMap((r) =>
        ((r.parts as Array<{ type: string; draftId?: string }>) ?? [])
          .filter((p) => p.type === 'draft')
          .map((p) => p.draftId!),
      );
      const drafts = draftIds.length
        ? await tx
            .selectFrom('drafts')
            .select(['id', 'kind', 'status', 'preview', 'expiresAt'])
            .where('id', 'in', draftIds)
            .execute()
        : [];
      const messages: ChatMessageDTO[] = rows.reverse().map((r) => {
        const parts =
          (r.parts as Array<{
            type: string;
            draftId?: string;
            id?: string;
            filename?: string;
            mime?: string;
            visual?: ChatVisual;
          }>) ?? [];
        return {
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          createdAt: new Date(r.createdAt).toISOString(),
          attachments: parts
            .filter((p) => p.type === 'attachment')
            .map((p) => ({ id: p.id!, filename: p.filename!, mime: p.mime! })),
          drafts: parts
            .filter((p) => p.type === 'draft')
            .map((p) => drafts.find((d) => d.id === p.draftId))
            .filter(Boolean)
            .map((d) => toDraftDTO(d!)),
          visuals: parts.filter((p) => p.type === 'visual' && p.visual).map((p) => p.visual!),
          ...(parts.some((p) => p.type === 'voice') ? { voice: true } : {}),
          ...(wa ? { channel: r.conversationId === wa.id ? ('whatsapp' as const) : ('web' as const) } : {}),
          ...(parts.some((p) => p.type === 'proactive' || p.type === 'nudge') ? { proactive: true } : {}),
        };
      });
      return { conversationId: conv?.id ?? null, messages };
    });
  });

  f.post('/api/chat/new', pre, async (req) =>
    inActor(app, req, async (tx, a) =>
      tx
        .insertInto('conversations')
        .values({ workspaceId: a.workspaceId, userId: a.userId, channel: 'web' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ),
  );

  // --- Drafts -------------------------------------------------------------------------------
  f.get('/api/drafts', pre, async (req) => {
    const q = z
      .object({
        status: z.enum(['pending', 'confirmed', 'cancelled', 'expired']).default('pending'),
        kind: z.string().max(40).optional(),
      })
      .parse(req.query);
    return inActor(app, req, async (tx, a) => {
      let qb = tx
        .selectFrom('drafts')
        .select(['id', 'kind', 'status', 'preview', 'expiresAt', 'createdAt', 'conversationId'])
        .where('workspaceId', '=', a.workspaceId)
        .where('status', '=', q.status)
        .orderBy('createdAt', 'desc')
        .limit(100);
      if (q.status === 'pending') qb = qb.where('expiresAt', '>', new Date());
      if (q.kind) qb = qb.where('kind', '=', q.kind);
      return (await qb.execute()).map((d) => ({
        ...toDraftDTO(d),
        createdAt: new Date(d.createdAt).toISOString(),
        conversationId: d.conversationId,
      }));
    });
  });

  f.get('/api/drafts/:id', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx) => {
      const d = await tx.selectFrom('drafts').selectAll().where('id', '=', id).executeTakeFirst();
      if (!d) throw notFound('Rascunho');
      return { ...toDraftDTO(d), payload: d.payload };
    });
  });

  f.post('/api/drafts/:id/confirm', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const actor = actorOf(req);
    const result = await withUserContext(app.db, actor.userId, (tx) => confirmDraft(tx, actor, id));
    // registra a confirmação na conversa para manter o histórico coerente
    await withUserContext(app.db, actor.userId, async (tx) => {
      const d = await tx
        .selectFrom('drafts')
        .select('conversationId')
        .where('id', '=', id)
        .executeTakeFirst();
      if (d?.conversationId) {
        await tx
          .insertInto('messages')
          .values({
            workspaceId: actor.workspaceId,
            conversationId: d.conversationId,
            role: 'assistant',
            content: [result.summary, result.impact].filter(Boolean).join(' '),
            parts: '[]',
          })
          .execute();
      }
    });
    return result;
  });

  f.post('/api/drafts/:id/cancel', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const actor = actorOf(req);
    await withUserContext(app.db, actor.userId, (tx) => cancelDraft(tx, actor, id));
    return { ok: true };
  });

  /** Revisão na web: ajusta itens de uma importação (incluir duplicatas, remover itens, mudar categoria). */
  f.patch('/api/drafts/:id', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ payload: z.unknown() }).parse(req.body);
    return inActor(app, req, async (tx, a) => {
      const d = await tx
        .selectFrom('drafts')
        .selectAll()
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (!d || d.createdBy !== a.userId) throw notFound('Rascunho');
      const payload = DRAFT_SCHEMAS[d.kind as DraftKind].parse(body.payload);
      const preview = d.preview as {
        totals?: { count: number; amountCents: number; duplicates: number; lowConfidence: number };
        summary: string;
      };
      if (d.kind === 'import') {
        const p = payload as {
          items: Array<{ amountCents: number; direction: string; duplicate?: boolean }>;
          skipDuplicates: boolean;
        };
        const chosen = p.items.filter((i) => !(p.skipDuplicates && i.duplicate));
        const net = chosen.reduce((s, i) => s + (i.direction === 'out' ? i.amountCents : -i.amountCents), 0);
        preview.totals = {
          count: chosen.length,
          amountCents: Math.abs(net),
          duplicates: p.items.length - chosen.length,
          lowConfidence: preview.totals?.lowConfidence ?? 0,
        };
      }
      const row = await tx
        .updateTable('drafts')
        .set({ payload: JSON.stringify(payload), preview: JSON.stringify(preview) })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ...toDraftDTO(row), payload: row.payload };
    });
  });

  // --- Anexos e arquivos ------------------------------------------------------------------------
  f.post('/api/attachments', pre, async (req) => {
    const actor = actorOf(req);
    if (actor.role === 'viewer') throw new AppError(403, 'Seu papel é só leitura.');
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw new AppError(400, 'Nenhum arquivo enviado.');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'Arquivo maior que 20 MB.');
    const att = await saveAttachment(app, actor, { data, filename: file.filename, mime: file.mimetype });
    return {
      id: att.id,
      filename: att.filename,
      mime: att.mime,
      sizeBytes: att.sizeBytes,
      duplicate: att.duplicate,
      status: att.status,
    };
  });

  f.get('/api/attachments', pre, async (req) =>
    inActor(app, req, (tx, a) =>
      tx
        .selectFrom('attachments')
        .select(['id', 'filename', 'mime', 'sizeBytes', 'docType', 'status', 'error', 'createdAt'])
        .where('workspaceId', '=', a.workspaceId)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .execute(),
    ),
  );

  f.get('/api/attachments/:id/url', pre, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inActor(app, req, async (tx) => {
      const att = await tx.selectFrom('attachments').select('id').where('id', '=', id).executeTakeFirst();
      if (!att) throw notFound('Anexo');
      return { url: app.storage.signedUrl(id, 300) };
    });
  });

  /** Download por URL assinada (curta duração). Não exige sessão; a assinatura é a autorização. */
  f.get('/api/files/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ exp: z.coerce.number(), sig: z.string() }).parse(req.query);
    if (!app.storage.verifySignature(id, q.exp, q.sig)) throw new AppError(403, 'Link expirado ou inválido.');
    // a assinatura HMAC autoriza; a busca usa função security definer que só devolve este anexo
    const att = await lookupAttachment(app, id);
    if (!att) throw notFound('Arquivo');
    const data = await app.storage.get(att.storageKey);
    reply
      .header('content-type', att.mime)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff');
    return reply.send(data);
  });

  // --- Eventos em tempo real (SSE) ----------------------------------------------------------
  f.get('/api/events', pre, async (req, reply) => {
    const actor = actorOf(req);
    const stream = openSSE(req, reply, app.config.PUBLIC_WEB_URL);
    const handler = (table: string) =>
      stream.send({ type: 'data_changed', workspaceId: actor.workspaceId, table });
    notifier.on(`ws:${actor.workspaceId}`, handler);
    const ping = setInterval(() => stream.send({ type: 'ping' }), 25_000);
    stream.send({ type: 'ping' });
    stream.onClose(() => {
      clearInterval(ping);
      notifier.off(`ws:${actor.workspaceId}`, handler);
    });
  });
}

/** Lookup do anexo para download assinado (sem contexto de usuário). */
async function lookupAttachment(app: AppContext, id: string) {
  const { sql } = await import('@sf/db');
  const r = await sql<{
    storageKey: string;
    filename: string;
    mime: string;
  }>`select storage_key as "storageKey", filename, mime from attachment_for_download(${id}::uuid)`.execute(
    app.db,
  );
  return r.rows[0];
}
