import { sql, type Tx } from '@sf/db';
import { addDays, goalPlan, type DraftDTO, type NudgeAnswerDTO, type NudgeDTO } from '@sf/shared';
import type { Actor } from '../../context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { listMemories, rememberFact } from '../../agent/memory.js';
import { computeCommitment } from '../commitment.js';
import { categorySpend } from '../dashboard.js';
import { createDraft, toDraftDTO, type DraftKind } from '../drafts.js';
import { emergencyReserve } from '../forecast.js';
import { workspaceToday } from '../ledger.js';
import { getProfile, upsertProfile } from '../profile.js';
import { computeProjection } from '../projection.js';
import { seasonalCalendar } from '../seasonal.js';
import { detectAll } from './detectors.js';
import type { PlannerHistory, PlannerNudge } from './planner.js';
import type { Candidate, DraftSpec, NudgeCtx, NudgeOption } from './types.js';

type Who = Pick<Actor, 'userId' | 'workspaceId'>;
const OPEN = ['candidate', 'scheduled', 'delivered', 'snoozed'] as const;
const DAY = 86_400_000;

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Carrega de uma vez o que os detectores leem (cada parte pode faltar sem derrubar as outras). */
export async function loadNudgeCtx(tx: Tx, actor: Actor, today?: string): Promise<NudgeCtx> {
  const ws = actor.workspaceId;
  const day = today ?? (await workspaceToday(tx, ws));
  const goals = await tx
    .selectFrom('goals')
    .select([
      'id',
      'name',
      'kind',
      'targetCents',
      'savedCents',
      'monthlyContributionCents',
      'startMonth',
      'targetDate',
    ])
    .where('workspaceId', '=', ws)
    .where('status', '=', 'active')
    .execute();
  const settings = await tx
    .selectFrom('workspaceSettings')
    .select('emergencyMonthsTarget')
    .where('workspaceId', '=', ws)
    .executeTakeFirst();
  const insights = await tx
    .selectFrom('insights')
    .select(['id', 'title', 'message', 'severity', 'rule'])
    .where('workspaceId', '=', ws)
    .where('dismissedAt', 'is', null)
    .where('resolvedAt', 'is', null)
    .where('createdAt', '>', new Date(Date.now() - 3 * DAY))
    .execute();
  return {
    today: day,
    role: actor.role,
    profile: await getProfile(tx, actor),
    memories: (await listMemories(tx, actor, ['active'])).filter((m) => m.mine),
    goals: goals.map((g) => ({
      ...g,
      kind: g.kind as NudgeCtx['goals'][number]['kind'],
      plan: goalPlan(g, day),
    })),
    emergencyMonthsTarget: Number(settings?.emergencyMonthsTarget ?? 6),
    projection: await safe(() => computeProjection(tx, ws)),
    reserve: await safe(() => emergencyReserve(tx, ws, day)),
    commitment: await safe(() => computeCommitment(tx, ws, { months: 6, today: day })),
    categories: (await safe(() => categorySpend(tx, ws, day))) ?? [],
    calendar: await safe(() => seasonalCalendar(tx, ws, day, 6)),
    insights,
  };
}

/**
 * Atualiza os candidatos do usuário: grava os novos (sem repetir o que ele já respondeu ou dispensou
 * nos últimos 45 dias), marca como superados os que perderam o sentido e expira os vencidos.
 */
export async function refreshNudges(
  tx: Tx,
  actor: Actor,
  opts: { today?: string; onError?: (kind: string, err: unknown) => void } = {},
): Promise<{ created: number; superseded: number; expired: number; candidates: Candidate[] }> {
  const ctx = await loadNudgeCtx(tx, actor, opts.today);
  const muted = new Set(await listMutes(tx, actor));
  // o que o usuário pediu para parar não aparece nem na caixa
  const cands = detectAll(ctx, opts.onError).filter(
    (c) => !muted.has(c.kind) && !muted.has(`cat:${c.category}`),
  );
  const now = new Date();
  const fps = cands.map((c) => c.fingerprint);
  const recent = fps.length
    ? await tx
        .selectFrom('agentNudges')
        .select(['fingerprint', 'status'])
        .where('workspaceId', '=', actor.workspaceId)
        .where('userId', '=', actor.userId)
        .where('fingerprint', 'in', fps)
        .where((eb) =>
          eb.or([
            eb('status', 'in', [...OPEN]),
            eb.and([
              eb('status', 'not in', ['superseded', 'expired']),
              eb('createdAt', '>', new Date(now.getTime() - 45 * DAY)),
            ]),
          ]),
        )
        .execute()
    : [];
  const seen = new Set(recent.map((r) => r.fingerprint));
  let created = 0;
  for (const c of cands) {
    if (seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    await tx
      .insertInto('agentNudges')
      .values({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        kind: c.kind,
        type: c.type,
        category: c.category,
        fingerprint: c.fingerprint,
        priority: Math.max(0, Math.min(100, Math.round(c.priority))),
        title: c.title.slice(0, 120),
        message: c.message.slice(0, 1200),
        facts: JSON.stringify(c.facts),
        options: JSON.stringify(c.options ?? []),
        draftKind: c.draft?.kind ?? null,
        draftPayload: c.draft ? JSON.stringify(c.draft.payload) : null,
        draftPreview: c.draft ? JSON.stringify(c.draft.preview) : null,
        expiresAt: new Date(now.getTime() + (c.ttlDays ?? 14) * DAY),
      })
      .execute();
    created++;
  }
  // o que deixou de valer some da caixa (o que já foi entregue espera a resposta até expirar)
  const sup = await tx
    .updateTable('agentNudges')
    .set({ status: 'superseded' })
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('status', 'in', ['candidate', 'scheduled', 'snoozed'])
    .where('fingerprint', 'not in', fps.length ? fps : ['-'])
    .executeTakeFirst();
  const exp = await tx
    .updateTable('agentNudges')
    .set({ status: 'expired' })
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('status', 'in', [...OPEN])
    .where('expiresAt', '<', now)
    .executeTakeFirst();
  return {
    created,
    superseded: Number(sup.numUpdatedRows),
    expired: Number(exp.numUpdatedRows),
    candidates: cands,
  };
}

type NudgeRow = {
  id: string;
  kind: string;
  type: string;
  category: string;
  title: string;
  message: string;
  priority: number;
  options: unknown;
  draftKind: string | null;
  draftId: string | null;
  status: string;
  deliveredAt: Date | null;
  deliveredChannel: string | null;
  respondedAt: Date | null;
  response: unknown;
  createdAt: Date;
};

export const optionsOf = (row: { options: unknown }) =>
  Array.isArray(row.options) ? (row.options as NudgeOption[]) : [];

export function toNudgeDTO(r: NudgeRow): NudgeDTO {
  const resp = (r.response ?? null) as { label?: string; text?: string } | null;
  return {
    id: r.id,
    kind: r.kind,
    type: r.type as NudgeDTO['type'],
    category: r.category,
    title: r.title,
    message: r.message,
    priority: r.priority,
    options: optionsOf(r).map((o) => ({ id: o.id, label: o.label })),
    hasDraft: Boolean(r.draftKind),
    draftId: r.draftId,
    status: r.status as NudgeDTO['status'],
    deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
    deliveredChannel: r.deliveredChannel as NudgeDTO['deliveredChannel'],
    respondedAt: r.respondedAt ? new Date(r.respondedAt).toISOString() : null,
    responseLabel: resp?.label ?? resp?.text ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

const COLS = [
  'id',
  'kind',
  'type',
  'category',
  'title',
  'message',
  'priority',
  'options',
  'draftKind',
  'draftId',
  'status',
  'deliveredAt',
  'deliveredChannel',
  'respondedAt',
  'response',
  'createdAt',
] as const;

/** Caixa do assistente: abertos por prioridade (adiados só quando vence o adiamento) ou histórico. */
export async function listNudges(
  tx: Tx,
  actor: Who,
  scope: 'open' | 'history' = 'open',
): Promise<NudgeDTO[]> {
  let q = tx
    .selectFrom('agentNudges')
    .select(COLS)
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId);
  if (scope === 'open')
    q = q
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['candidate', 'scheduled', 'delivered']),
          eb.and([eb('status', '=', 'snoozed'), eb('snoozeUntil', '<=', new Date())]),
        ]),
      )
      .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', new Date())]))
      .orderBy('priority', 'desc')
      .orderBy('createdAt', 'desc');
  else
    q = q
      .where('status', 'in', ['accepted', 'dismissed', 'answered', 'expired', 'snoozed'])
      .orderBy('updatedAt', 'desc')
      .limit(30);
  return (await q.execute()).map(toNudgeDTO);
}

export async function getNudge(tx: Tx, actor: Who, id: string) {
  const n = await tx
    .selectFrom('agentNudges')
    .selectAll()
    .where('id', '=', id)
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .executeTakeFirst();
  if (!n) throw notFound('Sugestão');
  return n;
}

export const isOpen = (status: string) => (OPEN as readonly string[]).includes(status);

async function draftFromSpec(tx: Tx, actor: Actor, spec: DraftSpec, conversationId: string | null) {
  return createDraft(
    tx,
    actor,
    spec.kind as DraftKind,
    spec.payload as never,
    { ...spec.preview, lines: [...spec.preview.lines], warnings: [...spec.preview.warnings] },
    conversationId,
  );
}

/**
 * Prévia da ação de um toque da sugestão (reaproveita a pendente se ainda vale). A confirmação usa o
 * fluxo normal de drafts; confirmar aceita a sugestão, cancelar dispensa.
 */
export async function prepareNudge(
  tx: Tx,
  actor: Actor,
  id: string,
  conversationId: string | null = null,
): Promise<DraftDTO> {
  const n = await getNudge(tx, actor, id);
  if (!isOpen(n.status)) throw new AppError(409, 'Esta sugestão já foi respondida.', 'nudge_closed');
  if (!n.draftKind) throw new AppError(422, 'Esta sugestão não tem ação para confirmar.');
  if (n.draftId) {
    const d = await tx
      .selectFrom('drafts')
      .selectAll()
      .where('id', '=', n.draftId)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (d && (conversationId === null || d.conversationId === conversationId)) return toDraftDTO(d);
  }
  const draft = await draftFromSpec(
    tx,
    actor,
    {
      kind: n.draftKind,
      payload: n.draftPayload,
      preview: n.draftPreview as unknown as DraftSpec['preview'],
    },
    conversationId,
  );
  await tx.updateTable('agentNudges').set({ draftId: draft.id }).where('id', '=', id).execute();
  return draft;
}

/** Aplica a opção escolhida numa pergunta (perfil, memória, prévia, adiar, dispensar ou conversar). */
export async function answerNudge(
  tx: Tx,
  actor: Actor,
  id: string,
  optionId: string,
  conversationId: string | null = null,
): Promise<NudgeAnswerDTO> {
  const n = await getNudge(tx, actor, id);
  if (!isOpen(n.status)) throw new AppError(409, 'Esta sugestão já foi respondida.', 'nudge_closed');
  const opt = optionsOf(n).find((o) => o.id === optionId);
  if (!opt) throw new AppError(422, 'Opção inválida.');
  const a = opt.action;
  const response = JSON.stringify({ optionId: opt.id, label: opt.label });
  const close = (status: string, extra: Record<string, unknown> = {}) =>
    tx
      .updateTable('agentNudges')
      .set({ status, response, respondedAt: new Date(), ...extra })
      .where('id', '=', id)
      .execute();
  const mine = (memoryId: string) =>
    tx
      .updateTable('agentMemories')
      .where('id', '=', memoryId)
      .where('userId', '=', actor.userId)
      .where('workspaceId', '=', actor.workspaceId);
  const out: NudgeAnswerDTO = { reply: '', draft: null, chatPrompt: null };
  switch (a.type) {
    case 'draft': {
      if (actor.role === 'viewer') throw new AppError(403, 'Seu papel neste workspace é só leitura.');
      out.draft = await draftFromSpec(tx, actor, a.draft, conversationId);
      // continua aberta até a prévia ser confirmada (aceita) ou cancelada (dispensada)
      await tx
        .updateTable('agentNudges')
        .set({ draftId: out.draft.id, response })
        .where('id', '=', id)
        .execute();
      out.reply = a.reply ?? 'Preparei a prévia. Confira e confirme para gravar.';
      return out;
    }
    case 'profile':
      await upsertProfile(tx, actor, a.patch);
      break;
    case 'memory_create':
      await rememberFact(tx, actor, {
        content: a.content,
        category: a.category as Parameters<typeof rememberFact>[2]['category'],
        expiresAt: a.expiresAt ?? null,
        importance: 4,
        source: 'question',
      });
      break;
    case 'memory_archive':
      await mine(a.memoryId).set({ status: 'archived', confirmedAt: new Date() }).execute();
      break;
    case 'memory_touch':
      await mine(a.memoryId).set({ confirmedAt: new Date() }).execute();
      break;
    case 'memory_extend': {
      const today = await workspaceToday(tx, actor.workspaceId);
      await mine(a.memoryId)
        .set({ expiresAt: addDays(today, a.days), confirmedAt: new Date() })
        .execute();
      break;
    }
    case 'chat':
      out.chatPrompt = a.prompt;
      break;
    case 'snooze':
      await close('snoozed', { snoozeUntil: new Date(Date.now() + a.days * DAY) });
      out.reply = a.reply;
      return out;
    case 'dismiss':
      await close('dismissed');
      out.reply = a.reply;
      return out;
    case 'mute':
      await muteKind(tx, actor, n.kind);
      await close('dismissed');
      out.reply = a.reply;
      return out;
  }
  await close('answered');
  out.reply = a.reply;
  return out;
}

/** Descarta a prévia pendente da sugestão sem dispensá-la (adiar ou silenciar decidem o status). */
async function releaseDraft(tx: Tx, draftId: string | null) {
  if (!draftId) return;
  await tx
    .updateTable('drafts')
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where('id', '=', draftId)
    .where('status', '=', 'pending')
    .execute();
}

export async function snoozeNudge(tx: Tx, actor: Who, id: string, days = 7) {
  const n = await getNudge(tx, actor, id);
  if (!isOpen(n.status)) throw new AppError(409, 'Esta sugestão já foi respondida.', 'nudge_closed');
  await releaseDraft(tx, n.draftId);
  await tx
    .updateTable('agentNudges')
    .set({ status: 'snoozed', snoozeUntil: new Date(Date.now() + days * DAY) })
    .where('id', '=', id)
    .execute();
}

/** Dispensa; com `mute`, também silencia o tipo (o detector deixa de ser entregue). */
export async function dismissNudge(tx: Tx, actor: Who, id: string, mute = false) {
  const n = await getNudge(tx, actor, id);
  await releaseDraft(tx, n.draftId);
  if (isOpen(n.status))
    await tx
      .updateTable('agentNudges')
      .set({ status: 'dismissed', respondedAt: new Date() })
      .where('id', '=', id)
      .execute();
  if (mute) await muteKind(tx, actor, n.kind);
  return n;
}

export async function muteKind(tx: Tx, actor: Who, kind: string, until: Date | null = null) {
  await tx
    .insertInto('agentNudgeMutes')
    .values({ workspaceId: actor.workspaceId, userId: actor.userId, kind, until })
    .onConflict((oc) => oc.columns(['workspaceId', 'userId', 'kind']).doUpdateSet({ until }))
    .execute();
  // o que já está na fila desse tipo sai também
  await tx
    .updateTable('agentNudges')
    .set({ status: 'dismissed', respondedAt: new Date() })
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('status', 'in', ['candidate', 'scheduled', 'snoozed'])
    .where((eb) => (kind.startsWith('cat:') ? eb('category', '=', kind.slice(4)) : eb('kind', '=', kind)))
    .execute();
}

export async function unmuteKind(tx: Tx, actor: Who, kind: string) {
  await tx
    .deleteFrom('agentNudgeMutes')
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('kind', '=', kind)
    .execute();
}

export async function listMutes(tx: Tx, actor: Who): Promise<string[]> {
  const rows = await tx
    .selectFrom('agentNudgeMutes')
    .select('kind')
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where((eb) => eb.or([eb('until', 'is', null), eb('until', '>', new Date())]))
    .execute();
  return rows.map((r) => r.kind);
}

/** Abertos e histórico recente para o planejador de entregas. */
export async function plannerState(
  tx: Tx,
  actor: Who,
  timezone: string,
  now = new Date(),
): Promise<{ open: PlannerNudge[]; history: PlannerHistory }> {
  const open = await tx
    .selectFrom('agentNudges')
    .select(['id', 'kind', 'type', 'category', 'priority', 'status', 'snoozeUntil'])
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('status', 'in', ['candidate', 'snoozed', 'scheduled'])
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]))
    .execute();
  const delivered = await tx
    .selectFrom('agentNudges')
    .select(['type', 'deliveredAt'])
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('deliveredAt', '>', new Date(now.getTime() - 7 * DAY))
    .execute();
  const dismissed = await tx
    .selectFrom('agentNudges')
    .select(['kind', 'respondedAt'])
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('status', '=', 'dismissed')
    .where('respondedAt', '>', new Date(now.getTime() - 90 * DAY))
    .execute();
  const reminders = await sql<{ n: number }>`
    select count(*)::int as n from reminders
    where workspace_id = ${actor.workspaceId}::uuid and user_id = ${actor.userId} and status = 'sent'
      and kind not in ('nudge', 'question')
      and (sent_at at time zone ${timezone})::date = (now() at time zone ${timezone})::date`.execute(tx);
  return {
    open: open.map((o) => ({ ...o, type: o.type as PlannerNudge['type'] })),
    history: {
      delivered: delivered.map((d) => ({
        type: d.type as 'nudge' | 'question',
        at: new Date(d.deliveredAt!),
      })),
      dismissed: dismissed.map((d) => ({ kind: d.kind, at: new Date(d.respondedAt!) })),
      mutes: await listMutes(tx, actor),
      remindersToday: Number(reminders.rows[0]?.n ?? 0),
      scheduledToday: open.some((o) => o.status === 'scheduled'),
    },
  };
}

const STATUS_LABEL: Record<string, string> = {
  delivered: 'sem resposta',
  accepted: 'aceita',
  answered: 'respondida',
  dismissed: 'dispensada',
  snoozed: 'adiada',
  expired: 'expirou',
};

/** Avisos dos últimos 3 dias (todos os canais) para o contexto do agente. */
export async function recentNudgeLines(tx: Tx, actor: Who): Promise<string[]> {
  const rows = await tx
    .selectFrom('agentNudges')
    .select(['title', 'message', 'type', 'status', 'options', 'deliveredChannel', 'response'])
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .where('deliveredAt', '>', new Date(Date.now() - 3 * DAY))
    .orderBy('deliveredAt', 'desc')
    .limit(3)
    .execute();
  return rows.map((r) => {
    const opts = optionsOf(r)
      .map((o) => o.label)
      .join(' / ');
    const resp = (r.response ?? null) as { label?: string } | null;
    if (r.type === 'question' && r.status === 'delivered')
      return `- Pergunta pendente (${r.deliveredChannel}): ${r.message}${opts ? ` [opções: ${opts}]` : ''}`;
    return `- ${r.title} (${STATUS_LABEL[r.status] ?? r.status}${resp?.label ? `: ${resp.label}` : ''})`;
  });
}

/** Chips de sugestão do chat a partir do que está aberto na caixa. */
export async function nudgeSuggestions(tx: Tx, actor: Who): Promise<string[]> {
  const open = await listNudges(tx, actor, 'open');
  const rows = await tx
    .selectFrom('agentNudges')
    .select(['id', 'facts'])
    .where(
      'id',
      'in',
      open.length ? open.slice(0, 3).map((n) => n.id) : ['00000000-0000-0000-0000-000000000000'],
    )
    .execute();
  const facts = new Map(rows.map((r) => [r.id, (r.facts ?? {}) as Record<string, unknown>]));
  return open.slice(0, 3).map((n) => {
    const f = facts.get(n.id) ?? {};
    switch (n.kind) {
      case 'goal_behind':
        return `Como colocar a meta ${String(f.goal)} em dia?`;
      case 'seasonal_prep':
        return `Criar meta para o ${String(f.label)} ${String(f.season)}`;
      case 'budget_trend':
        return `Por que gastei mais em ${String(f.category)}?`;
      case 'emergency_gap':
        return 'Como completar minha reserva de emergência?';
      case 'no_goal_surplus':
        return 'O que fazer com o que sobra todo mês?';
      case 'commitment_high':
        return 'Quanto da minha renda está comprometida?';
      default:
        return n.title;
    }
  });
}
