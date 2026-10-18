import {
  addDays,
  addMonths,
  diffDays,
  fold,
  formatBRL,
  formatDateBR,
  monthLabel,
  OBJECTIVES,
  startOfMonth,
  INCOME_STABILITY,
} from '@sf/shared';
import type { Candidate, GoalWithPlan, NudgeCtx, NudgeOption } from './types.js';

/**
 * Detectores proativos: funções puras sobre o NudgeCtx. Só comparam com números do app e com o que o
 * próprio usuário definiu (metas, perfil, memória). Nunca citam ativo ou produto (CVM 19).
 */

const roundUp = (cents: number, step: number) => Math.ceil(cents / step) * step;
const roundDown = (cents: number, step: number) => Math.floor(cents / step) * step;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const words = (s: string) =>
  fold(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4);

const goalFields = (g: GoalWithPlan) => ({
  name: g.name,
  kind: g.kind,
  targetCents: g.targetCents,
  savedCents: g.savedCents,
  monthlyContributionCents: g.monthlyContributionCents,
  startMonth: g.startMonth,
  targetDate: g.targetDate,
});

const later = (days = 30): NudgeOption => ({
  id: 'later',
  label: 'Agora não',
  action: { type: 'snooze', days, reply: 'Combinado, pergunto de novo mais adiante.' },
});

/** Meta com prazo que não chega no ritmo atual: propõe o aporte necessário. */
export function goalBehind(c: NudgeCtx): Candidate[] {
  const month = startOfMonth(c.today);
  return c.goals
    .filter((g) => g.plan.status === 'behind' && g.plan.recommendedMonthlyCents && g.targetDate)
    .map((g) => {
      const needed = g.plan.recommendedMonthlyCents!;
      return {
        kind: 'goal_behind',
        type: 'nudge',
        category: 'meta',
        fingerprint: `goal_behind:${g.id}:${month}`,
        priority: 70,
        title: `Meta ${g.name} atrasada`,
        message:
          `Sua meta *${g.name}* não chega até ${formatDateBR(g.targetDate!)} no ritmo atual` +
          (g.monthlyContributionCents
            ? ` (${formatBRL(g.monthlyContributionCents)}/mês)`
            : ' (sem aporte mensal)') +
          `. Faltam ${formatBRL(g.plan.remainingCents)}; para o prazo, o aporte seria ${formatBRL(needed)}/mês. Quer que eu ajuste?`,
        facts: {
          goal: g.name,
          monthly: g.monthlyContributionCents,
          needed,
          remaining: g.plan.remainingCents,
          date: g.targetDate,
        },
        draft: {
          kind: 'goal',
          payload: {
            mode: 'update',
            id: g.id,
            fields: { ...goalFields(g), monthlyContributionCents: needed },
          },
          preview: {
            title: `Meta: ${g.name}`,
            summary: `Aporte de ${formatBRL(needed)}/mês até ${formatDateBR(g.targetDate!)}`,
            lines: [],
            warnings: [],
          },
        },
      } satisfies Candidate;
    });
}

/** Objetivo que o usuário contou (memória) e que ainda não virou meta. */
export function goalFromMemory(c: NudgeCtx): Candidate[] {
  const goalWords = new Set(c.goals.flatMap((g) => words(g.name)));
  return c.memories
    .filter((m) => m.mine && m.status === 'active' && m.category === 'objetivo' && m.importance >= 3)
    .filter((m) => !words(m.content).some((w) => goalWords.has(w)))
    .slice(0, 2)
    .map((m) => ({
      kind: 'goal_from_memory',
      type: 'question',
      category: 'meta',
      fingerprint: `goal_from_memory:${m.id}`,
      priority: 55,
      title: 'Transformar objetivo em meta?',
      message: `Você me contou: "${m.content}". Quer transformar isso numa meta com valor e prazo? Assim eu acompanho o progresso e aviso se atrasar.`,
      facts: { memoryId: m.id, content: m.content },
      options: [
        {
          id: 'create',
          label: 'Criar meta',
          action: {
            type: 'chat',
            reply: 'Ótimo! Qual o valor e até quando? Por exemplo: "30 mil até dezembro de 2027".',
            prompt: `Quero criar uma meta para: ${m.content}. Valor: `,
          },
        },
        later(45),
        {
          id: 'drop',
          label: 'Não vale mais',
          action: { type: 'memory_archive', memoryId: m.id, reply: 'Ok, tirei isso da lista de objetivos.' },
        },
      ],
      ttlDays: 30,
    }));
}

/** Folga mensal média projetada (próximos 3 meses), descontando metas já em andamento. */
export function projectedSurplus(c: NudgeCtx): number | null {
  const months = c.projection?.months.slice(1, 4) ?? [];
  if (months.length < 3) return null;
  const nets = months.map(
    (m) => m.incomeCents - m.expenseCents - m.cardBillsCents - m.variableCents - m.goalsCents,
  );
  return Math.round(nets.reduce((s, v) => s + v, 0) / nets.length);
}

function reserveGoalDraft(c: NudgeCtx, monthlyCents: number) {
  const r = c.reserve!;
  const target = roundUp(r.monthlyCostCents * c.emergencyMonthsTarget, 100_00);
  const saved = Math.min(r.reserveCents, target);
  return {
    target,
    saved,
    spec: {
      kind: 'goal',
      payload: {
        mode: 'create',
        id: null,
        fields: {
          name: 'Reserva de emergência',
          kind: 'emergency',
          targetCents: target,
          savedCents: saved,
          monthlyContributionCents: monthlyCents,
          startMonth: addMonths(startOfMonth(c.today), 1),
          targetDate: null,
        },
      },
      preview: {
        title: 'Meta: Reserva de emergência',
        summary: `${formatBRL(target)} (${c.emergencyMonthsTarget} meses de custo) · aporte de ${formatBRL(monthlyCents)}/mês`,
        lines: [],
        warnings: [],
      },
    },
  };
}

/** Sobra dinheiro todo mês e nenhuma meta: pergunta o destino. */
export function noGoalSurplus(c: NudgeCtx): Candidate[] {
  if (c.goals.length) return [];
  const avg = projectedSurplus(c);
  if (avg === null || avg < 300_00) return [];
  const monthly = Math.max(50_00, roundDown(avg / 2, 50_00));
  const options: NudgeOption[] = [];
  if (c.reserve && c.reserve.monthlyCostCents > 0) {
    const d = reserveGoalDraft(c, monthly);
    if (d.target > d.saved)
      options.push({
        id: 'reserve',
        label: 'Reserva de emergência',
        action: { type: 'draft', draft: d.spec },
      });
  }
  options.push(
    {
      id: 'other',
      label: 'Outro objetivo',
      action: {
        type: 'chat',
        reply: 'Qual objetivo? Me diga o valor e o prazo, por exemplo "viagem de 15 mil em julho".',
        prompt: 'Quero criar uma meta para ',
      },
    },
    later(30),
  );
  return [
    {
      kind: 'no_goal_surplus',
      type: 'question',
      category: 'meta',
      fingerprint: `no_goal_surplus:${startOfMonth(c.today)}`,
      priority: 60,
      title: 'Dar um destino para a sobra',
      message: `Pela projeção, sobram em média ${formatBRL(avg)} por mês nos próximos 3 meses e você não tem nenhuma meta. Quer dar um destino para esse dinheiro (por exemplo, ${formatBRL(monthly)}/mês)?`,
      facts: { avg, monthly },
      options,
    },
  ];
}

/** Reserva abaixo do alvo de meses e sem meta de reserva: propõe a meta. */
export function emergencyGap(c: NudgeCtx): Candidate[] {
  const r = c.reserve;
  if (!r || r.months === null || r.monthlyCostCents <= 0) return [];
  if (r.months >= c.emergencyMonthsTarget) return [];
  if (c.goals.some((g) => g.kind === 'emergency')) return [];
  if (!c.goals.length && (projectedSurplus(c) ?? 0) >= 300_00) return []; // a pergunta da sobra já oferece
  const target = roundUp(r.monthlyCostCents * c.emergencyMonthsTarget, 100_00);
  const gap = Math.max(0, target - r.reserveCents);
  if (gap < 500_00) return [];
  const monthly = roundUp(gap / 12, 50_00);
  const d = reserveGoalDraft(c, monthly);
  const months = r.months.toFixed(1).replace('.', ',');
  const quarter = `${c.today.slice(0, 4)}-q${Math.floor((Number(c.today.slice(5, 7)) - 1) / 3) + 1}`;
  return [
    {
      kind: 'emergency_gap',
      type: 'nudge',
      category: 'reserva',
      fingerprint: `emergency_gap:${quarter}`,
      priority: r.status === 'critical' ? 72 : 62,
      title: 'Completar a reserva de emergência',
      message: `Sua reserva (${formatBRL(r.reserveCents)}) cobre ${months} meses de custo; o seu alvo é ${c.emergencyMonthsTarget} meses (${formatBRL(target)}). Com ${formatBRL(monthly)}/mês você completa em cerca de 12 meses. Quer criar essa meta?`,
      facts: { reserve: r.reserveCents, months, target, gap, monthly },
      draft: d.spec,
      ttlDays: 30,
    },
  ];
}

/** Categoria sem orçamento gastando bem acima da média: propõe um orçamento. */
export function budgetTrend(c: NudgeCtx): Candidate[] {
  if (Number(c.today.slice(8, 10)) < 20) return [];
  const month = startOfMonth(c.today);
  const hit = c.categories
    .filter((k) => k.categoryId && k.budgetCents === null && k.averageCents >= 200_00)
    .filter((k) => k.currentCents >= k.averageCents * 1.2)
    .sort((a, b) => b.currentCents - b.averageCents - (a.currentCents - a.averageCents))[0];
  if (!hit) return [];
  const amount = roundUp(hit.averageCents, 10_00);
  const over = (hit.currentCents - hit.averageCents) / hit.averageCents;
  return [
    {
      kind: 'budget_trend',
      type: 'nudge',
      category: 'orcamento',
      fingerprint: `budget_trend:${hit.categoryId}:${month}`,
      priority: 50,
      title: `Gasto alto em ${hit.name}`,
      message: `Em *${hit.name}* você já gastou ${formatBRL(hit.currentCents)} neste mês, ${pct(over)} acima da média de ${formatBRL(hit.averageCents)} dos últimos 3 meses. Quer um orçamento de ${formatBRL(amount)}/mês com alerta em 90%?`,
      facts: { category: hit.name, current: hit.currentCents, average: hit.averageCents, amount },
      draft: {
        kind: 'budget',
        payload: { categoryId: hit.categoryId, amountCents: amount, alertPct: 90 },
        preview: {
          title: `Orçamento: ${hit.name}`,
          summary: `${formatBRL(amount)} por mês, alerta em 90%`,
          lines: [],
          warnings: [],
        },
      },
      ttlDays: 12,
    },
  ];
}

/** Gasto anual grande (IPVA, IPTU, matrícula) entre 45 e 120 dias: propõe guardar por mês até lá. */
export function seasonalPrep(c: NudgeCtx): Candidate[] {
  if (!c.calendar) return [];
  const goalNames = c.goals.map((g) => fold(g.name));
  const groups = new Map<
    string,
    { label: string; season: number; itemId: string; date: string; total: number }
  >();
  for (const o of c.calendar.occurrences) {
    if (o.kind !== 'expense' || o.direction !== 'out' || o.paid || o.status === 'dismissed') continue;
    if (o.status === 'suggested' && o.confidence !== 'alta') continue;
    const days = diffDays(o.date, c.today);
    if (days < 45 || days > 120) continue;
    const key = `${o.itemId}:${o.season}`;
    const g = groups.get(key) ?? {
      label: o.label,
      season: o.season,
      itemId: o.itemId,
      date: o.date,
      total: 0,
    };
    g.total += o.amountCents;
    if (o.date < g.date) g.date = o.date;
    groups.set(key, g);
  }
  const out: Candidate[] = [];
  for (const g of groups.values()) {
    if (g.total < 300_00) continue;
    if (goalNames.some((n) => n.includes(fold(g.label)))) continue;
    const start = addMonths(startOfMonth(c.today), 1);
    const monthsLeft = Math.max(
      1,
      (Number(g.date.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
        Number(g.date.slice(5, 7)) -
        Number(start.slice(5, 7)),
    );
    const monthly = roundUp(g.total / monthsLeft, 10_00);
    const name = `${g.label} ${g.season}`;
    out.push({
      kind: 'seasonal_prep',
      type: 'nudge',
      category: 'sazonal',
      fingerprint: `seasonal_prep:${g.itemId}:${g.season}`,
      priority: 58 + (diffDays(g.date, c.today) < 75 ? 8 : 0),
      title: `Preparar ${name}`,
      message: `O *${g.label}* de ${g.season} vem em ${formatDateBR(g.date)} (${formatBRL(g.total)}). Separando ${formatBRL(monthly)}/mês a partir de ${monthLabel(start, true)}, o valor fica pronto sem apertar o mês. Quer criar essa meta?`,
      facts: { label: g.label, season: g.season, date: g.date, total: g.total, monthly, monthsLeft },
      draft: {
        kind: 'goal',
        payload: {
          mode: 'create',
          id: null,
          fields: {
            name,
            kind: 'purchase',
            targetCents: g.total,
            savedCents: 0,
            monthlyContributionCents: monthly,
            startMonth: start,
            targetDate: g.date,
          },
        },
        preview: {
          title: `Meta: ${name}`,
          summary: `${formatBRL(g.total)} até ${formatDateBR(g.date)} · ${formatBRL(monthly)}/mês`,
          lines: [],
          warnings: [],
        },
      },
      ttlDays: 21,
    });
  }
  return out;
}

/** 13º chegando e gastos de início de ano: pergunta se quer reservar parte. */
export function thirteenthSplit(c: NudgeCtx): Candidate[] {
  if (!c.calendar) return [];
  const m = Number(c.today.slice(5, 7));
  if (m < 10) return [];
  const thirteenth = c.calendar.occurrences.find(
    (o) =>
      o.key === 'decimo_terceiro' &&
      o.direction === 'in' &&
      !o.paid &&
      o.status !== 'dismissed' &&
      diffDays(o.date, c.today) >= 0 &&
      diffDays(o.date, c.today) <= 75,
  );
  if (!thirteenth || thirteenth.amountCents <= 0) return [];
  const year = Number(c.today.slice(0, 4)) + 1;
  const early = c.calendar.occurrences.filter(
    (o) =>
      o.kind === 'expense' &&
      o.direction === 'out' &&
      !o.paid &&
      o.status !== 'dismissed' &&
      o.date >= `${year}-01-01` &&
      o.date <= `${year}-03-31`,
  );
  const total = early.reduce((s, o) => s + o.amountCents, 0);
  if (total < 500_00) return [];
  const labels = [...new Set(early.map((o) => o.label))].slice(0, 3).join(', ');
  const half = roundDown(thirteenth.amountCents / 2, 10_00);
  const needed = Math.min(total, thirteenth.amountCents);
  const remindAt = addDays(thirteenth.date, 2);
  return [
    {
      kind: 'thirteenth_split',
      type: 'question',
      category: 'renda',
      fingerprint: `thirteenth_split:${year}`,
      priority: 62,
      title: 'Reservar parte do 13º?',
      message: `Seu 13º (${formatBRL(thirteenth.amountCents)}) deve cair em ${formatDateBR(thirteenth.date)}. De janeiro a março vêm ${labels} (${formatBRL(total)}). Quer reservar parte do 13º para isso?`,
      facts: { thirteenth: thirteenth.amountCents, date: thirteenth.date, total, labels, half, needed },
      options: [
        {
          id: 'half',
          label: `Separar ${formatBRL(half)}`,
          action: {
            type: 'memory_create',
            category: 'compromisso',
            content: `Separar ${formatBRL(half)} do 13º para ${labels}`,
            expiresAt: remindAt,
            reply: `Anotado! Quando o 13º cair, eu te lembro de separar ${formatBRL(half)}.`,
          },
        },
        {
          id: 'needed',
          label: `Separar ${formatBRL(needed)}`,
          action: {
            type: 'memory_create',
            category: 'compromisso',
            content: `Separar ${formatBRL(needed)} do 13º para ${labels}`,
            expiresAt: remindAt,
            reply: `Anotado! Quando o 13º cair, eu te lembro de separar ${formatBRL(needed)}.`,
          },
        },
        { id: 'no', label: 'Não precisa', action: { type: 'dismiss', reply: 'Ok, sem reserva desta vez.' } },
      ],
      ttlDays: 30,
    },
  ];
}

/** Parcelas pesando na renda nos próximos meses (informativo, com o mês em que alivia). */
export function commitmentHigh(c: NudgeCtx): Candidate[] {
  const k = c.commitment;
  if (!k) return [];
  const next = k.months.slice(0, 3).find((m) => m.pct !== null && m.pct >= k.threshold);
  if (!next) return [];
  const release = k.releases.find((r) => r.month > next.month);
  return [
    {
      kind: 'commitment_high',
      type: 'nudge',
      category: 'orcamento',
      fingerprint: `commitment_high:${next.month}`,
      priority: 45,
      title: 'Renda comprometida com parcelas',
      message:
        `Em ${monthLabel(next.month, true)}, ${pct(next.pct!)} da sua renda já está comprometida com parcelas (${formatBRL(next.committedCents)}).` +
        (release ? ` Alivia em ${monthLabel(release.month, true)}, quando termina ${release.label}.` : '') +
        ' Antes de uma nova compra parcelada, vale perguntar "cabe no bolso?".',
      facts: { month: next.month, pct: next.pct, committed: next.committedCents, release: release ?? null },
      ttlDays: 20,
    },
  ];
}

/** Insight novo e relevante da carteira (só fatos; as regras já respeitam a CVM 19). */
export function insightBridge(c: NudgeCtx): Candidate[] {
  return c.insights
    .filter((i) => i.severity === 'warning' || i.severity === 'critical')
    .slice(0, 2)
    .map((i) => ({
      kind: 'insight_bridge',
      type: 'nudge',
      category: 'carteira',
      fingerprint: `insight:${i.id}`,
      priority: i.severity === 'critical' ? 55 : 42,
      title: i.title,
      message: `${i.title}: ${i.message}`,
      facts: { insightId: i.id, rule: i.rule },
      ttlDays: 10,
    }));
}

/** Compromisso anotado com prazo chegando ou vencido: pergunta se foi feito. */
export function memoryDue(c: NudgeCtx): Candidate[] {
  return c.memories
    .filter((m) => m.mine && m.status === 'active' && m.category === 'compromisso' && m.expiresAt)
    .filter((m) => {
      const d = diffDays(m.expiresAt!, c.today);
      return d <= 2 && d >= -7;
    })
    .map((m) => ({
      kind: 'memory_due',
      type: 'question',
      category: 'memoria',
      fingerprint: `memory_due:${m.id}:${m.expiresAt}`,
      priority: 75,
      title: 'Compromisso anotado',
      message: `Você tinha anotado: "${m.content}" (até ${formatDateBR(m.expiresAt!)}). Conseguiu?`,
      facts: { memoryId: m.id, content: m.content, due: m.expiresAt },
      options: [
        {
          id: 'done',
          label: 'Sim, feito',
          action: { type: 'memory_archive', memoryId: m.id, reply: 'Boa! Tirei da lista.' },
        },
        {
          id: 'not_yet',
          label: 'Ainda não',
          action: {
            type: 'memory_extend',
            memoryId: m.id,
            days: 14,
            reply: 'Combinado, volto a perguntar em duas semanas.',
          },
        },
        {
          id: 'gave_up',
          label: 'Desisti',
          action: { type: 'memory_archive', memoryId: m.id, reply: 'Ok, tirei da lista.' },
        },
      ],
      ttlDays: 7,
    }));
}

/** Objetivo anotado há mais de 6 meses sem revisão: confirma se ainda vale. */
export function memoryStale(c: NudgeCtx): Candidate[] {
  return c.memories
    .filter((m) => m.mine && m.status === 'active' && m.category === 'objetivo' && !m.pinned)
    .filter((m) => diffDays(c.today, m.updatedAt.slice(0, 10)) > 180)
    .slice(0, 1)
    .map((m) => ({
      kind: 'memory_stale',
      type: 'question',
      category: 'memoria',
      fingerprint: `memory_stale:${m.id}:${c.today.slice(0, 4)}`,
      priority: 30,
      title: 'Esse objetivo ainda vale?',
      message: `Há alguns meses você me disse: "${m.content}". Isso ainda vale?`,
      facts: { memoryId: m.id, content: m.content },
      options: [
        {
          id: 'yes',
          label: 'Ainda vale',
          action: { type: 'memory_touch', memoryId: m.id, reply: 'Perfeito, sigo considerando.' },
        },
        {
          id: 'changed',
          label: 'Mudou',
          action: {
            type: 'chat',
            reply: 'O que mudou? Me conta que eu atualizo.',
            prompt: `Sobre "${m.content}": `,
          },
        },
        {
          id: 'drop',
          label: 'Não vale mais',
          action: { type: 'memory_archive', memoryId: m.id, reply: 'Ok, tirei da lista.' },
        },
      ],
      ttlDays: 21,
    }));
}

/** Completa o perfil aos poucos com perguntas de múltipla escolha (uma por vez). */
export function profileGap(c: NudgeCtx): Candidate[] {
  const p = c.profile;
  if (!p.questionsEnabled) return [];
  const ask = (
    field: string,
    message: string,
    options: Array<{ id: string; label: string; patch: Parameters<typeof profileOption>[2] }>,
  ): Candidate[] => [
    {
      kind: 'profile_gap',
      type: 'question',
      category: 'perfil',
      fingerprint: `profile_gap:${field}`,
      priority: 35,
      title: 'Uma pergunta rápida',
      message,
      facts: { field },
      options: [...options.map((o) => profileOption(o.id, o.label, o.patch)), later(21)],
      ttlDays: 21,
    },
  ];
  if (!p.incomeStability)
    return ask(
      'income_stability',
      'Para eu calibrar as sugestões (reserva, 13º, FGTS): qual é o seu tipo de renda?',
      (['clt', 'servidor', 'autonomo', 'empresario', 'aposentado'] as const).map((k) => ({
        id: k,
        label: INCOME_STABILITY[k],
        patch: { incomeStability: k },
      })),
    );
  if (p.dependents === null)
    return ask('dependents', 'Quantas pessoas dependem financeiramente de você?', [
      { id: '0', label: 'Nenhuma', patch: { dependents: 0 } },
      { id: '1', label: 'Uma', patch: { dependents: 1 } },
      { id: '2', label: 'Duas', patch: { dependents: 2 } },
      { id: '3', label: 'Três ou mais', patch: { dependents: 3 } },
    ]);
  if (!p.objectives.length)
    return ask(
      'objectives',
      'Qual é o seu principal objetivo financeiro agora?',
      (['reserva', 'quitar_dividas', 'casa_propria', 'aposentadoria', 'viagem'] as const).map((k) => ({
        id: k,
        label: OBJECTIVES[k],
        patch: { objectives: [k] },
      })),
    );
  if (!p.interests.length)
    return ask('interests', 'Quer que eu acompanhe algum destes temas e te avise quando algo mudar?', [
      { id: 'juros', label: 'Selic e Tesouro', patch: { interests: ['selic', 'tesouro'] } },
      { id: 'ir', label: 'Imposto de renda', patch: { interests: ['ir'] } },
      { id: 'inss', label: 'INSS e previdência', patch: { interests: ['inss', 'previdencia'] } },
      { id: 'dolar', label: 'Dólar', patch: { interests: ['dolar'] } },
    ]);
  return [];
}

function profileOption(id: string, label: string, patch: import('../profile.js').ProfilePatch): NudgeOption {
  return {
    id,
    label,
    action: { type: 'profile', patch, reply: `Anotado: ${label.toLowerCase()}. Obrigado!` },
  };
}

export const DETECTORS: Array<(c: NudgeCtx) => Candidate[]> = [
  memoryDue,
  goalBehind,
  emergencyGap,
  noGoalSurplus,
  thirteenthSplit,
  seasonalPrep,
  goalFromMemory,
  budgetTrend,
  commitmentHigh,
  insightBridge,
  profileGap,
  memoryStale,
];

/** Roda todos os detectores; um detector com erro não derruba os outros. */
export function detectAll(c: NudgeCtx, onError?: (kind: string, err: unknown) => void): Candidate[] {
  const out: Candidate[] = [];
  for (const d of DETECTORS) {
    try {
      out.push(...d(c));
    } catch (err) {
      onError?.(d.name, err);
    }
  }
  // leitor não grava: sem ações de um toque
  if (c.role === 'viewer')
    return out
      .filter((x) => !x.draft)
      .map((x) => ({ ...x, options: x.options?.filter((o) => o.action.type !== 'draft') }));
  return out;
}
