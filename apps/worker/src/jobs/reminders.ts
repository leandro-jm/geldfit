import { sql, withUserContext, type Db } from '@sf/db';
import {
  addDays,
  addMonths,
  diffDays,
  formatBRL,
  formatDateBR,
  monthLabel,
  startOfMonth,
  type SeasonalItemDTO,
  type SeasonalOccurrenceDTO,
} from '@sf/shared';
import type { Actor } from '@sf/api/context';
import { createDraft } from '@sf/api/domain/drafts';
import { categorySpend } from '@sf/api/domain/dashboard';
import { accountShortfalls, safeToSpendFrom, shortfallSentence } from '@sf/api/domain/forecast';
import { computeProjection } from '@sf/api/domain/projection';
import { upcoming } from '@sf/api/domain/queries';
import { describeEvidence, describeSchedule, seasonalCalendar } from '@sf/api/domain/seasonal';
import type { WorkerContext } from '../context.js';
import { pushText } from '@sf/api/lib/push';
import {
  activeWorkspaces,
  membersOf,
  notifyPush,
  postAssistantMessage,
  whatsappConversation,
} from './util.js';
import { deliverNudge } from './nudges.js';

type Kind =
  | 'due_bill'
  | 'statement_closed'
  | 'statement_due'
  | 'balance_alert'
  | 'weekly_summary'
  | 'monthly_summary'
  | 'import_reminder'
  | 'budget_alert'
  | 'seasonal'
  | 'nudge'
  | 'question';

export async function enqueue(
  sys: Db,
  r: {
    workspaceId: string;
    userId: string;
    kind: Kind;
    fireAtLocal: { date: string; time: string; tz: string } | Date;
    targetType?: string;
    targetId?: string;
    payload?: unknown;
    dedupeKey: string;
  },
) {
  const fireAt =
    r.fireAtLocal instanceof Date
      ? sql`${r.fireAtLocal}::timestamptz`
      : sql`(${r.fireAtLocal.date}::date + ${r.fireAtLocal.time}::time) at time zone ${r.fireAtLocal.tz}`;
  await sql`
    insert into reminders (workspace_id, user_id, kind, target_type, target_id, fire_at, payload, dedupe_key)
    values (${r.workspaceId}::uuid, ${r.userId}, ${r.kind}, ${r.targetType ?? null}, ${r.targetId ?? null}::uuid, ${fireAt}, ${JSON.stringify(r.payload ?? {})}::jsonb, ${r.dedupeKey})
    on conflict (dedupe_key) do nothing`.execute(sys);
}

/**
 * Agenda os lembretes dos próximos dias (idempotente via dedupe_key). Roda a cada hora.
 *   vencimentos D-3, D-1 e D0; fatura fechou (dia do fechamento); fatura a vencer D-2;
 *   resumo semanal (domingo 19:00); resumo mensal (dia 1); lembrete de importação (dia 2);
 *   orçamento estourado; calendário anual (lead_days antes da 1ª parcela da temporada).
 */
export async function scheduleReminders(ctx: WorkerContext) {
  const { sys } = ctx;
  for (const ws of await activeWorkspaces(sys)) {
    const settings = await sys
      .selectFrom('workspaceSettings')
      .select(['reminderTime', 'timezone'])
      .where('workspaceId', '=', ws.id)
      .executeTakeFirstOrThrow();
    const at = (date: string, time = String(settings.reminderTime).slice(0, 5)) => ({
      date,
      time,
      tz: settings.timezone,
    });
    for (const m of await membersOf(sys, ws.id)) {
      if (m.role === 'viewer') continue; // leitores não recebem cobrança de contas
      // Visão do próprio usuário (respeita contas privadas)
      const items = await withUserContext(ctx.app.db, m.userId, (tx) => upcoming(tx, ws.id, ws.today, 4));
      for (const it of items) {
        if (it.direction !== 'out') continue;
        if (it.kind === 'statement') {
          const due2 = addDays(it.date, -2);
          if (due2 >= ws.today)
            await enqueue(sys, {
              workspaceId: ws.id,
              userId: m.userId,
              kind: 'statement_due',
              fireAtLocal: at(due2),
              targetType: 'statement',
              targetId: it.id,
              payload: it,
              dedupeKey: `statement_due:${it.id}:${m.userId}`,
            });
          continue;
        }
        for (const d of [3, 1, 0]) {
          const when = addDays(it.date, -d);
          if (when < ws.today) continue;
          await enqueue(sys, {
            workspaceId: ws.id,
            userId: m.userId,
            kind: 'due_bill',
            fireAtLocal: at(when),
            targetType: 'transaction',
            targetId: it.id,
            payload: { ...it, daysBefore: d },
            dedupeKey: `due_bill:${it.id}:${m.userId}:D-${d}`,
          });
        }
      }
      // Fatura fecha hoje
      const closing = await withUserContext(ctx.app.db, m.userId, (tx) =>
        tx
          .selectFrom('cardStatementTotals as s')
          .innerJoin('cards as c', 'c.id', 's.cardId')
          .select(['s.id', 'c.name', 's.totalCents', 's.dueDate', 's.closingDate'])
          .where('s.workspaceId', '=', ws.id)
          .where('s.closingDate', '=', ws.today)
          .execute(),
      );
      for (const s of closing) {
        await enqueue(sys, {
          workspaceId: ws.id,
          userId: m.userId,
          kind: 'statement_closed',
          fireAtLocal: at(ws.today),
          targetType: 'statement',
          targetId: s.id!,
          payload: s,
          dedupeKey: `statement_closed:${s.id}:${m.userId}`,
        });
      }
      const dow = new Date(`${ws.today}T12:00:00Z`).getUTCDay();
      if (dow === 0)
        await enqueue(sys, {
          workspaceId: ws.id,
          userId: m.userId,
          kind: 'weekly_summary',
          fireAtLocal: at(ws.today, '19:00'),
          dedupeKey: `weekly_summary:${ws.id}:${m.userId}:${ws.today}`,
        });
      const day = Number(ws.today.slice(8, 10));
      if (day === 1)
        await enqueue(sys, {
          workspaceId: ws.id,
          userId: m.userId,
          kind: 'monthly_summary',
          fireAtLocal: at(ws.today),
          dedupeKey: `monthly_summary:${ws.id}:${m.userId}:${ws.today}`,
        });
      if (day === 2)
        await enqueue(sys, {
          workspaceId: ws.id,
          userId: m.userId,
          kind: 'import_reminder',
          fireAtLocal: at(ws.today),
          dedupeKey: `import_reminder:${ws.id}:${m.userId}:${ws.today}`,
        });

      // Orçamentos: alerta quando o gasto do mês passa do percentual definido (1x por mês por categoria)
      const spend = await withUserContext(ctx.app.db, m.userId, (tx) => categorySpend(tx, ws.id, ws.today));
      const budgets = await sys
        .selectFrom('budgets')
        .select(['categoryId', 'amountCents', 'alertPct'])
        .where('workspaceId', '=', ws.id)
        .execute();
      for (const b of budgets) {
        const s = spend.find((x) => x.categoryId === b.categoryId);
        if (s && s.currentCents >= (b.amountCents * b.alertPct) / 100) {
          await enqueue(sys, {
            workspaceId: ws.id,
            userId: m.userId,
            kind: 'budget_alert',
            fireAtLocal: new Date(),
            payload: { name: s.name, spent: s.currentCents, budget: b.amountCents },
            dedupeKey: `budget_alert:${b.categoryId}:${m.userId}:${ws.today.slice(0, 7)}`,
          });
        }
      }

      // Calendário anual: um aviso por item e temporada, lead_days (30–60) antes da 1ª parcela não paga
      const cal = await withUserContext(ctx.app.db, m.userId, (tx) =>
        seasonalCalendar(tx, ws.id, ws.today, 5),
      );
      const lead = new Map(cal.items.map((i) => [i.id, i.leadDays]));
      const seen = new Set<string>();
      for (const o of cal.occurrences) {
        if (o.paid || o.kind === 'info' || o.date <= ws.today) continue;
        const season = o.season;
        if (seen.has(`${o.itemId}:${season}`)) continue;
        seen.add(`${o.itemId}:${season}`);
        if (addDays(o.date, -(lead.get(o.itemId) ?? 30)) > ws.today) continue;
        await enqueue(sys, {
          workspaceId: ws.id,
          userId: m.userId,
          kind: 'seasonal',
          fireAtLocal: at(ws.today),
          targetType: 'seasonal_item',
          targetId: o.itemId,
          payload: { season, date: o.date },
          dedupeKey: `seasonal:${o.itemId}:${season}:${m.userId}`,
        });
      }
    }
  }
}

function inQuietHours(nowLocal: string, start: string, end: string): boolean {
  return start <= end ? nowLocal >= start && nowLocal < end : nowLocal >= start || nowLocal < end;
}

/** Envia os lembretes vencidos (a cada minuto). Horário silencioso adia; opt-out pula. */
export async function dispatchReminders(ctx: WorkerContext) {
  const { app, sys } = ctx;
  const due = await sys.transaction().execute(async (tx) => {
    const rows = await sql<{ id: string }>`
      select id from reminders where status = 'pending' and fire_at <= now() and attempts < 5
      order by fire_at limit 50 for update skip locked`.execute(tx);
    if (rows.rows.length)
      await sql`update reminders set attempts = attempts + 1 where id = any(${rows.rows.map((r) => r.id)}::uuid[])`.execute(
        tx,
      );
    return rows.rows.map((r) => r.id);
  });
  for (const id of due) {
    const r = await sys.selectFrom('reminders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    try {
      const outcome = await deliver(ctx, r);
      if (outcome.postponeTo)
        await sys
          .updateTable('reminders')
          .set({ fireAt: outcome.postponeTo, attempts: 0 })
          .where('id', '=', id)
          .execute();
      else
        await sys
          .updateTable('reminders')
          .set({
            status: outcome.status,
            sentAt: outcome.status === 'sent' ? new Date() : null,
            channel: outcome.channel ?? null,
            lastError: outcome.reason ?? null,
          })
          .where('id', '=', id)
          .execute();
    } catch (err) {
      app.log.error({ err, reminder: id }, 'falha ao enviar lembrete');
      await sys
        .updateTable('reminders')
        .set({
          lastError: String(err).slice(0, 500),
          fireAt: new Date(Date.now() + 5 * 60_000),
          status: r.attempts >= 4 ? 'failed' : 'pending',
        })
        .where('id', '=', id)
        .execute();
    }
  }
  return due.length;
}

interface DeliveryOutcome {
  status: 'sent' | 'skipped' | 'failed';
  channel?: string;
  reason?: string;
  postponeTo?: Date;
}

async function deliver(
  ctx: WorkerContext,
  r: {
    id: string;
    workspaceId: string;
    userId: string;
    kind: string;
    targetId: string | null;
    payload: unknown;
    fireAt: Date;
  },
): Promise<DeliveryOutcome> {
  const { app, sys } = ctx;
  const ws = await sys
    .selectFrom('workspaces')
    .innerJoin('workspaceSettings as s', 's.workspaceId', 'workspaces.id')
    .select(['workspaces.deletedAt', 's.timezone', 's.quietStart', 's.quietEnd', 's.balanceFloorCents'])
    .where('workspaces.id', '=', r.workspaceId)
    .executeTakeFirst();
  if (!ws || ws.deletedAt) return { status: 'skipped', reason: 'workspace removido' };
  const member = await sys
    .selectFrom('memberships')
    .select('role')
    .where('workspaceId', '=', r.workspaceId)
    .where('userId', '=', r.userId)
    .executeTakeFirst();
  if (!member) return { status: 'skipped', reason: 'não é mais membro' };
  const pref = await sys
    .selectFrom('reminderPrefs')
    .select('enabled')
    .where('workspaceId', '=', r.workspaceId)
    .where('userId', '=', r.userId)
    .where('kind', '=', r.kind)
    .executeTakeFirst();
  if (pref && !pref.enabled) return { status: 'skipped', reason: 'opt-out' };

  // horário silencioso (fuso do workspace)
  const local = await sql<{
    t: string;
    d: string;
  }>`select to_char(now() at time zone ${ws.timezone}, 'HH24:MI') as t, (now() at time zone ${ws.timezone})::date::text as d`.execute(
    sys,
  );
  const { t: nowLocal, d: todayLocal } = local.rows[0]!;
  const qs = String(ws.quietStart).slice(0, 5);
  const qe = String(ws.quietEnd).slice(0, 5);
  if (inQuietHours(nowLocal, qs, qe)) {
    const date = nowLocal >= qs && qs > qe ? addDays(todayLocal, 1) : todayLocal;
    const next = await sql<{
      at: Date;
    }>`select (${date}::date + ${qe}::time) at time zone ${ws.timezone} as at`.execute(sys);
    return { status: 'skipped', postponeTo: next.rows[0]!.at };
  }

  const actor: Actor = {
    userId: r.userId,
    workspaceId: r.workspaceId,
    role: member.role as Actor['role'],
    channel: 'whatsapp',
  };
  const p = (r.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const channel = await sys
    .selectFrom('userChannels')
    .select('address')
    .where('userId', '=', r.userId)
    .where('kind', '=', 'whatsapp')
    .where('verifiedAt', 'is not', null)
    .executeTakeFirst();
  const conversationId = await whatsappConversation(app, actor);
  if (r.kind === 'nudge' || r.kind === 'question')
    return deliverNudge(
      ctx,
      { ...r, targetId: r.targetId! },
      actor,
      conversationId,
      channel?.address ?? null,
    );
  let text = '';
  const drafts = [];

  switch (r.kind) {
    case 'due_bill': {
      // a conta pode ter sido paga ou removida desde o agendamento
      const tx = await withUserContext(app.db, r.userId, (t) =>
        t
          .selectFrom('transactions')
          .select(['status', 'amountCents', 'description', 'date'])
          .where('id', '=', r.targetId!)
          .executeTakeFirst(),
      );
      if (!tx || tx.status !== 'scheduled') return { status: 'skipped', reason: 'já paga ou removida' };
      const when =
        p.daysBefore === 0
          ? 'vence hoje'
          : p.daysBefore === 1
            ? 'vence amanhã'
            : `vence em ${formatDateBR(tx.date)}`;
      if (p.daysBefore <= 1 && member.role !== 'viewer') {
        const d = await withUserContext(app.db, r.userId, (t) =>
          createDraft(
            t,
            actor,
            'mark_paid',
            { transactionId: r.targetId!, date: todayLocal, amountCents: tx.amountCents },
            {
              title: `Pago: ${tx.description}`,
              summary: `${formatBRL(tx.amountCents)} em ${formatDateBR(todayLocal)}`,
              lines: [],
              warnings: [],
            },
            conversationId,
            { computeImpact: false },
          ),
        );
        drafts.push(d);
        text = `${tx.description} de ${formatBRL(tx.amountCents)} ${when}. Já pagou? Responda *sim* para registrar o pagamento.`;
      } else {
        text = `Lembrete: ${tx.description} de ${formatBRL(tx.amountCents)} ${when}${p.accountName ? ` (${p.accountName})` : ''}.`;
      }
      break;
    }
    case 'statement_closed':
      text = `A fatura do cartão ${p.name} fechou hoje: ${formatBRL(Number(p.totalCents ?? 0))}. Vence em ${formatDateBR(p.dueDate)}.`;
      break;
    case 'statement_due': {
      const st = await withUserContext(app.db, r.userId, (t) =>
        t
          .selectFrom('cardStatementTotals as s')
          .innerJoin('cards as c', 'c.id', 's.cardId')
          .select(['s.totalCents', 's.paidCents', 's.dueDate', 'c.name', 'c.accountId'])
          .where('s.id', '=', r.targetId!)
          .executeTakeFirst(),
      );
      if (!st || Number(st.paidCents) >= Number(st.totalCents))
        return { status: 'skipped', reason: 'fatura paga' };
      const remaining = Number(st.totalCents) - Number(st.paidCents);
      if (st.accountId && member.role !== 'viewer') {
        const d = await withUserContext(app.db, r.userId, (t) =>
          createDraft(
            t,
            actor,
            'card_payment',
            { statementId: r.targetId!, accountId: st.accountId!, amountCents: remaining, date: st.dueDate! },
            {
              title: `Pagar fatura ${st.name}`,
              summary: `${formatBRL(remaining)} em ${formatDateBR(st.dueDate!)}`,
              lines: [],
              warnings: [],
            },
            conversationId,
            { computeImpact: false },
          ),
        );
        drafts.push(d);
      }
      text = `A fatura do ${st.name} de ${formatBRL(remaining)} vence em ${formatDateBR(st.dueDate!)}.${drafts.length ? ' Já pagou? Responda *sim* para registrar.' : ''}`;
      break;
    }
    case 'balance_alert': {
      if (p.type !== 'account_shortfall') {
        text = `⚠️ Sua projeção indica saldo de ${formatBRL(p.closingCents)} em ${monthLabel(p.month, true)}, abaixo do piso de ${formatBRL(p.floorCents)}. Quer que eu mostre o que pesa nesse mês?`;
        break;
      }
      // os dados podem ter mudado desde o agendamento: só avisa se a conta ainda fica negativa
      const current = (
        await withUserContext(app.db, r.userId, (t) => accountShortfalls(t, r.workspaceId, todayLocal, 35))
      ).find((f) => f.accountId === p.accountId);
      if (!current) return { status: 'skipped', reason: 'conta não fica mais negativa' };
      const s = current.suggestion;
      if (s && member.role !== 'viewer') {
        const d = await withUserContext(app.db, r.userId, (t) =>
          createDraft(
            t,
            actor,
            'transfer',
            {
              fromAccountId: s.fromAccountId,
              toAccountId: current.accountId,
              amountCents: s.amountCents,
              toAmountCents: null,
              date: s.date,
              description: `Cobrir saldo da ${current.accountName}`,
              status: s.date > todayLocal ? 'scheduled' : 'posted',
            },
            {
              title: `Transferência ${s.fromAccountName} → ${current.accountName}`,
              summary: `${formatBRL(s.amountCents)} em ${formatDateBR(s.date)}`,
              lines: [],
              warnings: [],
            },
            conversationId,
            { computeImpact: false },
          ),
        );
        drafts.push(d);
      }
      text = `⚠️ ${shortfallSentence(current)}${
        drafts.length
          ? ` Quer que eu registre essa transferência? Responda *sim*. (Eu só anoto; a transferência você faz no banco.)`
          : ''
      }`;
      break;
    }
    case 'weekly_summary':
      text = await weeklySummary(ctx, actor, todayLocal);
      break;
    case 'monthly_summary':
      text = await monthlySummary(ctx, actor, todayLocal);
      break;
    case 'import_reminder':
      text =
        'Dia de atualizar! Envie aqui o extrato ou a fatura do mês (PDF, foto, CSV ou OFX) e eu importo para você.';
      break;
    case 'seasonal': {
      const cal = await withUserContext(app.db, r.userId, (t) =>
        seasonalCalendar(t, r.workspaceId, todayLocal, 6),
      );
      const item = cal.items.find((i) => i.id === r.targetId);
      const occ = cal.occurrences.filter((o) => o.itemId === r.targetId && !o.paid && o.season === p.season);
      if (!item || item.status === 'dismissed' || !occ.length)
        return { status: 'skipped', reason: 'item ignorado ou já pago' };
      if (item.status === 'suggested' && member.role !== 'viewer') {
        const d = await withUserContext(app.db, r.userId, (t) =>
          createDraft(
            t,
            actor,
            'seasonal',
            { mode: 'confirm', id: item.id, fields: {} },
            {
              title: `Confirmar no calendário: ${item.label}`,
              summary: 'Entra na projeção',
              lines: [],
              warnings: [],
            },
            conversationId,
            { computeImpact: false },
          ),
        );
        drafts.push(d);
      }
      let closing: { month: string; cents: number } | null = null;
      if (item.status === 'confirmed') {
        const proj = await withUserContext(app.db, r.userId, (t) => computeProjection(t, r.workspaceId));
        const m = proj.months.find((x) => x.month === startOfMonth(occ[0]!.date));
        if (m) closing = { month: m.month, cents: m.closingCents };
      }
      text = seasonalText(item, occ[0]!, todayLocal, drafts.length > 0, closing);
      break;
    }
    case 'budget_alert':
      text = `Orçamento de ${p.name}: ${formatBRL(p.spent)} de ${formatBRL(p.budget)} (${Math.round((p.spent / p.budget) * 100)}%) neste mês.`;
      break;
    default:
      return { status: 'skipped', reason: `tipo desconhecido ${r.kind}` };
  }

  await postAssistantMessage(app, actor, conversationId, text, drafts);
  if (channel && app.whatsapp) {
    try {
      await app.whatsapp.sendText(channel.address, text);
      return { status: 'sent', channel: 'whatsapp' };
    } catch (err) {
      app.log.warn({ err }, 'WhatsApp falhou; tentando push/e-mail');
    }
  }
  const pushed = await notifyPush(app, r.userId, {
    title: subjectFor(r.kind),
    body: pushText(text),
    url: urlFor(r.kind),
    tag: r.id,
  });
  if (pushed > 0) return { status: 'sent', channel: 'push' };
  const user = await sys.selectFrom('authUser').select('email').where('id', '=', r.userId).executeTakeFirst();
  if (user && !user.email.endsWith('@invalid.local')) {
    await app.mailer.send(
      user.email,
      subjectFor(r.kind),
      `${text.replace(/\*/g, '')}\n\nResponda pelo app: ${app.config.PUBLIC_WEB_URL}`,
    );
    return { status: 'sent', channel: 'email' };
  }
  return { status: 'failed', reason: 'sem canal disponível' };
}

/** Página do app aberta ao tocar na notificação. */
function urlFor(kind: string) {
  return (
    (
      {
        statement_closed: '/contas',
        statement_due: '/contas',
        balance_alert: '/projecao',
        import_reminder: '/importacoes',
        budget_alert: '/metas',
        seasonal: '/calendario',
      } as Record<string, string>
    )[kind] ?? '/'
  );
}

function subjectFor(kind: string) {
  return (
    (
      {
        due_bill: 'Conta a vencer',
        statement_closed: 'Fatura fechada',
        statement_due: 'Fatura a vencer',
        balance_alert: 'Alerta de saldo projetado',
        weekly_summary: 'Seu resumo semanal',
        monthly_summary: 'Seu resumo do mês',
        import_reminder: 'Hora de importar o extrato',
        budget_alert: 'Orçamento',
        seasonal: 'Calendário financeiro',
        nudge: 'Sugestão do assistente',
        question: 'Pergunta do assistente',
      } as Record<string, string>
    )[kind] ?? 'Saúde Financeira'
  );
}

async function weeklySummary(ctx: WorkerContext, actor: Actor, today: string): Promise<string> {
  return withUserContext(ctx.app.db, actor.userId, async (tx) => {
    const from = addDays(today, -7);
    const spent = await sql<{ cents: number; top: string | null }>`
      select coalesce(sum(t.amount_brl_cents), 0)::bigint as cents,
        (select c.name from transactions x join categories c on c.id = x.category_id
          where x.workspace_id = ${actor.workspaceId}::uuid and x.direction = 'out' and x.kind = 'regular' and x.status = 'posted' and x.date > ${from}::date
          group by c.name order by sum(x.amount_brl_cents) desc limit 1) as top
      from transactions t where t.workspace_id = ${actor.workspaceId}::uuid and t.direction = 'out' and t.kind = 'regular' and t.status = 'posted' and t.date > ${from}::date`.execute(
      tx,
    );
    const next = await upcoming(tx, actor.workspaceId, today, 7);
    const proj = await computeProjection(tx, actor.workspaceId);
    const insights = await tx
      .selectFrom('insights')
      .select('message')
      .where('workspaceId', '=', actor.workspaceId)
      .where('resolvedAt', 'is', null)
      .where('dismissedAt', 'is', null)
      .where('createdAt', '>', new Date(Date.now() - 7 * 86_400_000))
      .limit(2)
      .execute();
    const s = spent.rows[0]!;
    const lines = [
      '*Resumo da semana*',
      `Gastos: ${formatBRL(Number(s.cents))}${s.top ? ` (mais em ${s.top})` : ''}.`,
      next.length
        ? `Próximos 7 dias: ${next
            .slice(0, 4)
            .map((n) => `${n.description} ${formatBRL(n.amountCents)} em ${formatDateBR(n.date)}`)
            .join('; ')}.`
        : 'Nenhum vencimento nos próximos 7 dias.',
      proj.minClosing
        ? `Menor saldo projetado: ${formatBRL(proj.minClosing.cents)} em ${monthLabel(proj.minClosing.month, true)}.`
        : '',
      ((f) =>
        f.status === 'over'
          ? ''
          : `Folga para gastos extras: ${formatBRL(f.extraCents)} sem furar o piso. Dia a dia: ≈ ${formatBRL(f.dailyCents)} por dia até o fim do mês.`)(
        safeToSpendFrom(proj, today),
      ),
      ...insights.map((i) => `💡 ${i.message}`),
      'Para não receber mais este resumo, responda "para de mandar resumo".',
    ];
    return lines.filter(Boolean).join('\n');
  });
}

async function monthlySummary(ctx: WorkerContext, actor: Actor, today: string): Promise<string> {
  return withUserContext(ctx.app.db, actor.userId, async (tx) => {
    const m = addMonths(startOfMonth(today), -1);
    const r = await sql<{ inc: number; exp: number }>`
      select coalesce(sum(case when direction = 'in' then amount_brl_cents end), 0)::bigint as inc, coalesce(sum(case when direction = 'out' then amount_brl_cents end), 0)::bigint as exp
      from transactions where workspace_id = ${actor.workspaceId}::uuid and kind = 'regular' and status = 'posted' and date >= ${m}::date and date < ${startOfMonth(today)}::date`.execute(
      tx,
    );
    const proj = await computeProjection(tx, actor.workspaceId);
    const row = r.rows[0]!;
    return [
      `*Resumo de ${monthLabel(m, true)}*`,
      `Entradas: ${formatBRL(Number(row.inc))} · Saídas: ${formatBRL(Number(row.exp))} · Saldo do mês: ${formatBRL(Number(row.inc) - Number(row.exp))}.`,
      proj.months[0] ? `Projeção para o fim deste mês: ${formatBRL(proj.months[0].closingCents)}.` : '',
      proj.firstBelowFloor ? `⚠️ ${monthLabel(proj.firstBelowFloor, true)} fica abaixo do piso.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
}

export { inQuietHours };

/** Texto do aviso do calendário anual (sugerido pede confirmação; confirmado mostra o saldo do mês). */
export function seasonalText(
  item: SeasonalItemDTO,
  next: SeasonalOccurrenceDTO,
  today: string,
  canConfirm: boolean,
  closing: { month: string; cents: number } | null,
): string {
  const days = diffDays(next.date, today);
  const when =
    days <= 0 ? 'hoje' : days === 1 ? 'amanhã' : `daqui a ${days} dias (${formatDateBR(next.date)})`;
  const total = item.schedule.reduce((a, e) => a + e.amountCents, 0);
  const history = item.evidence.length ? ` Histórico: ${describeEvidence(item)}.` : '';
  const ask = canConfirm ? ' Quer que eu coloque na projeção? Responda *sim* (ou me diga o valor novo).' : '';
  if (item.status === 'confirmed') {
    const part = next.installment ? ` (${next.installment.n}/${next.installment.total})` : '';
    const value =
      item.kind === 'adjustment' ? `+${formatBRL(next.amountCents)}/mês` : formatBRL(next.amountCents);
    return `📅 Lembrete: ${item.label}${part} de ${value} ${when}.${
      closing
        ? ` Já está na projeção: ${monthLabel(closing.month, true)} fecha em ${formatBRL(closing.cents)}.`
        : ''
    }`;
  }
  if (item.kind === 'adjustment')
    return `📅 ${item.label}: o valor costuma subir nesta época (+${item.adjustmentPct}%). O próximo reajuste deve vir ${when}, cerca de +${formatBRL(next.amountCents)}/mês.${history}${ask}`;
  if (item.kind === 'income')
    return `📅 ${cap(when)} deve entrar o ${item.label}: ${formatBRL(total)} ${describeSchedule(item.schedule)}.${
      item.confidence === 'estimado' ? ' Estimei pelo seu salário.' : history
    }${ask}`;
  return `📅 ${cap(when)} vem o ${item.label}: pelo último ano, ${formatBRL(total)} ${describeSchedule(item.schedule)}.${history}${ask}`;
}

function cap(s: string) {
  return s[0]!.toUpperCase() + s.slice(1);
}
