import { NUDGES_PER_WEEK, type NudgeFrequency } from '@sf/shared';

export interface PlannerNudge {
  id: string;
  kind: string;
  type: 'nudge' | 'question';
  category: string;
  priority: number;
  status: string;
  snoozeUntil: Date | null;
}

export interface PlannerHistory {
  /** Entregas (qualquer canal) nos últimos 7 dias. */
  delivered: Array<{ type: 'nudge' | 'question'; at: Date }>;
  /** Dispensas nos últimos 90 dias, por tipo de detector. */
  dismissed: Array<{ kind: string; at: Date }>;
  /** Tipos (kind) ou categorias (`cat:<categoria>`) silenciados agora. */
  mutes: string[];
  /** Lembretes de conta/fatura/resumo já enviados hoje. */
  remindersToday: number;
  /** Algum aviso já agendado para hoje e ainda não entregue. */
  scheduledToday: boolean;
}

export interface PlannerPrefs {
  frequency: NudgeFrequency;
  questionsEnabled: boolean;
}

const DAY = 86_400_000;

/**
 * Escolhe o que empurrar (WhatsApp/notificação) hoje. A caixa da web mostra tudo que está aberto;
 * aqui o objetivo é não cansar: no máximo 1 por dia, teto semanal pela frequência escolhida,
 * 1 pergunta a cada 3 dias, nada em dia cheio de lembretes, 14 dias de pausa depois de uma dispensa
 * e silêncio total para o que o usuário pediu para parar.
 */
export function planDeliveries(
  open: PlannerNudge[],
  h: PlannerHistory,
  prefs: PlannerPrefs,
  now: Date,
): PlannerNudge[] {
  const weekly = NUDGES_PER_WEEK[prefs.frequency];
  if (!weekly) return [];
  if (h.scheduledToday) return [];
  if (h.remindersToday >= 3) return [];
  const t = now.getTime();
  const deliveredToday = h.delivered.filter((d) => t - d.at.getTime() < DAY).length;
  if (deliveredToday >= 1 || h.delivered.length >= weekly) return [];
  const recentQuestion = h.delivered.some((d) => d.type === 'question' && t - d.at.getTime() < 3 * DAY);
  const cooling = new Set(h.dismissed.filter((d) => t - d.at.getTime() < 14 * DAY).map((d) => d.kind));
  const muted = new Set(h.mutes);

  const eligible = open
    .filter(
      (n) =>
        n.status === 'candidate' ||
        (n.status === 'snoozed' && n.snoozeUntil !== null && n.snoozeUntil.getTime() <= t),
    )
    .filter((n) => !muted.has(n.kind) && !muted.has(`cat:${n.category}`))
    .filter((n) => !cooling.has(n.kind))
    .filter((n) => n.type !== 'question' || (prefs.questionsEnabled && !recentQuestion))
    .sort((a, b) => b.priority - a.priority);
  return eligible.slice(0, 1);
}

/** Depois de 2 dispensas do mesmo tipo em 90 dias, a próxima resposta sugere silenciar. */
export function shouldSuggestMute(kind: string, h: Pick<PlannerHistory, 'dismissed'>): boolean {
  return h.dismissed.filter((d) => d.kind === kind).length >= 2;
}
