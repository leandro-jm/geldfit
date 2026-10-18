import { sql, withUserContext } from '@sf/db';
import { formatDateBR, formatMoney, visualToText, type DraftDTO } from '@sf/shared';
import type { Actor, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { handleMessage } from '../agent/orchestrator.js';
import { transcribeAudio } from '../import/audio.js';
import { saveAttachment } from '../import/service.js';
import type { InboundMessage } from './types.js';

const seen = new Map<string, number>(); // dedupe de reentregas do webhook
const invited = new Map<string, number>(); // convite no máximo 1x/dia por número
const queues = new Map<string, Promise<void>>(); // processa em ordem por número

/** Formata a prévia de um draft para texto de WhatsApp. */
export function draftToWhatsApp(d: DraftDTO): string {
  const p = d.preview;
  const lines = [`*${p.title}*`, p.summary];
  if (p.items && p.items.length > 1) {
    for (const it of p.items.slice(0, 8))
      lines.push(
        `• ${formatDateBR(it.date)} ${it.description} ${formatMoney(it.amountCents, it.currency)}${it.duplicate ? ' (duplicata)' : ''}${it.lowConfidence ? ' (?)' : ''}`,
      );
    if (p.items.length > 8) lines.push(`… e mais ${p.items.length - 8}. Revise todos na web.`);
  }
  for (const l of p.lines) lines.push(`${l.label}: ${l.value}`);
  for (const w of p.warnings) lines.push(`⚠️ ${w}`);
  if (p.projectionImpact) lines.push(`📈 ${p.projectionImpact}`);
  return lines.join('\n');
}

export function enqueueInbound(app: AppContext, msg: InboundMessage): void {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3_600_000) seen.delete(k);
  if (seen.has(msg.messageId)) return;
  seen.set(msg.messageId, now);
  const prev = queues.get(msg.from) ?? Promise.resolve();
  const next = prev
    .then(() => handleInbound(app, msg))
    .catch((err) => app.log.error({ err }, 'falha ao processar mensagem do WhatsApp'))
    .finally(() => {
      if (queues.get(msg.from) === next) queues.delete(msg.from);
    });
  queues.set(msg.from, next);
}

export async function handleInbound(app: AppContext, msg: InboundMessage): Promise<void> {
  const wa = app.whatsapp;
  if (!wa) return;
  const linked = await sql<{
    userId: string;
    defaultWorkspaceId: string | null;
  }>`select user_id as "userId", default_workspace_id as "defaultWorkspaceId" from resolve_whatsapp_user(${msg.from})`.execute(
    app.db,
  );
  const link = linked.rows[0];
  if (!link) {
    const last = invited.get(msg.from) ?? 0;
    if (Date.now() - last > 86_400_000) {
      invited.set(msg.from, Date.now());
      await wa.sendText(
        msg.from,
        `Olá! Este número ainda não está vinculado. Crie sua conta em ${app.config.PUBLIC_WEB_URL} e vincule o WhatsApp em Configurações.`,
      );
    }
    return;
  }

  const memberships = await withUserContext(app.db, link.userId, (tx) =>
    tx
      .selectFrom('memberships as m')
      .innerJoin('workspaces as w', 'w.id', 'm.workspaceId')
      .select(['m.workspaceId', 'm.role', 'w.name'])
      .where('m.userId', '=', link.userId)
      .where('w.deletedAt', 'is', null)
      .orderBy('m.createdAt')
      .execute(),
  );
  if (!memberships.length) {
    await wa.sendText(msg.from, 'Você não participa de nenhum workspace ativo. Acesse o app pela web.');
    return;
  }

  // "usar workspace Família"
  const switchTo = msg.text?.match(/^usar (?:o )?(?:workspace|espa[cç]o)\s+(.+)$/i);
  if (switchTo) {
    const target = memberships.find((m) => m.name.toLowerCase() === switchTo[1]!.trim().toLowerCase());
    if (!target) {
      await wa.sendText(msg.from, `Workspaces disponíveis: ${memberships.map((m) => m.name).join(', ')}.`);
      return;
    }
    await withUserContext(app.db, link.userId, (tx) =>
      tx
        .updateTable('userChannels')
        .set({ defaultWorkspaceId: target.workspaceId })
        .where('kind', '=', 'whatsapp')
        .where('address', '=', msg.from)
        .execute(),
    );
    await wa.sendText(msg.from, `Pronto, agora estou usando o workspace *${target.name}*.`);
    return;
  }

  const current = memberships.find((m) => m.workspaceId === link.defaultWorkspaceId) ?? memberships[0]!;
  const actor: Actor = {
    userId: link.userId,
    workspaceId: current.workspaceId,
    role: current.role as Actor['role'],
    channel: 'whatsapp',
  };

  if (msg.kind === 'other') return;

  // Áudio vira texto e segue o mesmo fluxo; a resposta repete o que foi entendido para conferência
  let text = msg.text ?? '';
  let heard: string | null = null;
  if (msg.kind === 'audio') {
    if (!app.transcriber) {
      await wa.sendText(msg.from, 'Ainda não entendo áudio. Pode mandar por texto?');
      return;
    }
    try {
      const file = await wa.downloadMedia(msg);
      heard = await transcribeAudio(app, actor, { data: file.data, mime: file.mime });
      text = heard;
    } catch (err) {
      await wa.sendText(
        msg.from,
        err instanceof AppError ? err.message : 'Não consegui ouvir o áudio. Pode mandar por texto?',
      );
      if (!(err instanceof AppError)) app.log.error({ err }, 'falha no áudio do WhatsApp');
      return;
    }
  }

  const attachmentIds: string[] = [];
  if (msg.kind === 'image' || msg.kind === 'document') {
    try {
      const file = await wa.downloadMedia(msg);
      const att = await saveAttachment(app, actor, file);
      attachmentIds.push(att.id);
    } catch (err) {
      await wa.sendText(
        msg.from,
        err instanceof AppError ? err.message : 'Não consegui baixar o arquivo. Tente enviar de novo.',
      );
      return;
    }
  }

  try {
    const res = await handleMessage(app, actor, { text, attachmentIds });
    const parts = [heard ? `🎤 _"${heard}"_` : '', res.text, ...res.visuals.map((v) => visualToText(v))];
    const pending = res.drafts.filter((d) => d.status === 'pending');
    for (const d of pending) parts.push(draftToWhatsApp(d));
    if (pending.length) {
      await wa.sendOptions(msg.from, parts.filter(Boolean).join('\n\n'), ['Confirmar', 'Editar', 'Cancelar']);
    } else if (res.text) {
      await wa.sendText(msg.from, parts.filter(Boolean).join('\n\n'));
    }
  } catch (err) {
    await wa.sendText(
      msg.from,
      err instanceof AppError ? err.message : 'Tive um problema agora. Tente de novo em instantes.',
    );
    if (!(err instanceof AppError)) throw err;
  }
}
