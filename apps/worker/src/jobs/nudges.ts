import { withUserContext } from '@sf/db';
import type { Actor } from '@sf/api/context';
import { getProfile } from '@sf/api/domain/profile';
import { planDeliveries } from '@sf/api/domain/nudges/planner';
import { footer, phrase } from '@sf/api/domain/nudges/render';
import { plannerState, prepareNudge, refreshNudges } from '@sf/api/domain/nudges/service';
import type { NudgeOption } from '@sf/api/domain/nudges/types';
import { pushText } from '@sf/api/lib/push';
import type { WorkerContext } from '../context.js';
import { enqueue } from './reminders.js';
import { activeWorkspaces, membersOf, notifyPush, postAssistantMessage } from './util.js';

/**
 * Agente proativo (diário): roda os detectores de cada membro, grava os candidatos na caixa do
 * assistente e agenda no máximo um envio pela fila de lembretes, respeitando frequência, silêncio
 * e pausas. Tudo determinístico; o LLM só redige o texto na entrega (quando há orçamento).
 */
export async function nudgesDaily(ctx: WorkerContext, opts: { jitter?: boolean } = {}) {
  const { app, sys } = ctx;
  if (app.config.AGENT_PROACTIVE === 'off') return { created: 0, scheduled: 0 };
  let created = 0;
  let scheduled = 0;
  for (const ws of await activeWorkspaces(sys)) {
    const settings = await sys
      .selectFrom('workspaceSettings')
      .select(['reminderTime', 'timezone'])
      .where('workspaceId', '=', ws.id)
      .executeTakeFirstOrThrow();
    for (const m of await membersOf(sys, ws.id)) {
      const actor: Actor = {
        userId: m.userId,
        workspaceId: ws.id,
        role: m.role as Actor['role'],
        channel: 'whatsapp',
      };
      try {
        const chosen = await withUserContext(app.db, m.userId, async (tx) => {
          const profile = await getProfile(tx, actor);
          if (profile.nudgeFrequency === 'off') return [];
          const r = await refreshNudges(tx, actor, {
            today: ws.today,
            onError: (kind, err) => app.log.warn({ err, kind, ws: ws.id }, 'detector falhou'),
          });
          created += r.created;
          const st = await plannerState(tx, actor, settings.timezone);
          const pick = planDeliveries(
            st.open,
            st.history,
            { frequency: profile.nudgeFrequency, questionsEnabled: profile.questionsEnabled },
            new Date(),
          );
          for (const n of pick)
            await tx
              .updateTable('agentNudges')
              .set({ status: 'scheduled', scheduledFor: new Date() })
              .where('id', '=', n.id)
              .execute();
          return pick;
        });
        for (const n of chosen) {
          // horário dos lembretes + até 20 min (envios não saem todos no mesmo minuto)
          const [hh, mm] = String(settings.reminderTime).slice(0, 5).split(':').map(Number) as [
            number,
            number,
          ];
          const minutes = hh * 60 + mm + (opts.jitter === false ? 0 : Math.floor(Math.random() * 21));
          const time = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          await enqueue(sys, {
            workspaceId: ws.id,
            userId: m.userId,
            kind: n.type,
            fireAtLocal: { date: ws.today, time, tz: settings.timezone },
            targetType: 'nudge',
            targetId: n.id,
            dedupeKey: `nudge:${n.id}`,
          });
          scheduled++;
        }
      } catch (err) {
        app.log.error({ err, ws: ws.id, user: m.userId }, 'falha nos avisos proativos');
      }
    }
  }
  if (created || scheduled) app.log.info({ created, scheduled }, 'avisos proativos atualizados');
  return { created, scheduled };
}

/**
 * Entrega de uma sugestão ou pergunta (chamada pela fila de lembretes, depois de checar opt-out e
 * horário silencioso). Confere se ainda vale; no WhatsApp vai com a prévia pronta (o "sim" confirma)
 * ou com as opções numeradas; sem WhatsApp, fica só na caixa da web (sem e-mail).
 */
export async function deliverNudge(
  ctx: WorkerContext,
  r: { id: string; workspaceId: string; userId: string; targetId: string },
  actor: Actor,
  conversationId: string,
  whatsappAddress: string | null,
): Promise<{ status: 'sent' | 'skipped'; channel?: string; reason?: string }> {
  const { app } = ctx;
  if (app.config.AGENT_PROACTIVE === 'off') return { status: 'skipped', reason: 'agente proativo desligado' };
  const prep = await withUserContext(app.db, r.userId, async (tx) => {
    const n = await tx.selectFrom('agentNudges').selectAll().where('id', '=', r.targetId).executeTakeFirst();
    if (!n || n.status !== 'scheduled') return { skip: 'sugestão já tratada' as const };
    // a situação pode ter mudado desde o agendamento (meta ajustada, conta paga...)
    const fresh = await refreshNudges(tx, actor);
    if (!fresh.candidates.some((c) => c.fingerprint === n.fingerprint))
      return { skip: 'não vale mais' as const };
    const profile = await getProfile(tx, actor);
    return { n, profile };
  });
  if ('skip' in prep) return { status: 'skipped', reason: prep.skip };
  const { n, profile } = prep;
  const options = (Array.isArray(n.options) ? n.options : []) as unknown as NudgeOption[];
  const useWhatsApp = Boolean(whatsappAddress && app.whatsapp && profile.nudgeChannels.includes('whatsapp'));

  const markDelivered = (channel: 'whatsapp' | 'web') =>
    withUserContext(app.db, r.userId, (tx) =>
      tx
        .updateTable('agentNudges')
        .set({
          status: 'delivered',
          deliveredAt: new Date(),
          deliveredChannel: channel,
          conversationId: channel === 'whatsapp' ? conversationId : null,
          reminderId: r.id,
        })
        .where('id', '=', n.id)
        .execute(),
    );
  // sem WhatsApp a sugestão fica na caixa da web; o push só avisa que ela chegou
  const pushInbox = () =>
    notifyPush(app, r.userId, { title: n.title, body: pushText(n.message), url: '/assistente', tag: n.id });
  if (!useWhatsApp) {
    await markDelivered('web');
    await pushInbox();
    return { status: 'sent', channel: 'web' };
  }

  const drafts =
    n.draftKind && actor.role !== 'viewer'
      ? [await withUserContext(app.db, r.userId, (tx) => prepareNudge(tx, actor, n.id, conversationId))]
      : [];
  const body = app.config.AGENT_PROACTIVE === 'full' ? (await phrase(app, actor, n)).text : n.message;
  const tail = footer({ type: n.type, hasDraft: drafts.length > 0, options });
  const listed = options.map((o, i) => `${i + 1} - ${o.label}`).join('\n');
  // a conversa guarda o texto completo (com as opções) para o "1"/"sim" seguinte ter contexto
  const stored = [body, listed, tail].filter(Boolean).join('\n\n');
  await postAssistantMessage(app, actor, conversationId, stored, drafts, [{ type: 'nudge', nudgeId: n.id }]);
  try {
    if (options.length)
      await app.whatsapp!.sendOptions(
        whatsappAddress!,
        `${body}\n\n${tail}`,
        options.map((o) => o.label),
      );
    else await app.whatsapp!.sendText(whatsappAddress!, `${body}\n\n${tail}`);
    await markDelivered('whatsapp');
    return { status: 'sent', channel: 'whatsapp' };
  } catch (err) {
    app.log.warn({ err }, 'WhatsApp falhou; sugestão fica na caixa da web');
    await markDelivered('web');
    await pushInbox();
    return { status: 'sent', channel: 'web' };
  }
}
