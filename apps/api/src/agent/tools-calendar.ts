import { z } from 'zod';
import {
  formatBRL,
  monthLabel,
  MONTHS_SHORT,
  splitInstallments,
  type DraftPreview,
  type SeasonalItemDTO,
  type SeasonalScheduleEntry,
} from '@sf/shared';
import { AppError } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import { resolveCategory } from '../domain/resolve.js';
import {
  describeEvidence,
  describeSchedule,
  findSeasonalItem,
  occurrenceSentence,
  seasonalCalendar,
} from '../domain/seasonal.js';
import { amountInput, defineTool, monthInput, toCents, toMonth, type ToolCtx } from './tool-kit.js';

const scheduleTotal = (s: SeasonalScheduleEntry[]) => s.reduce((a, e) => a + e.amountCents, 0);

/** Novo total mantendo a proporção entre as parcelas. */
function rescale(schedule: SeasonalScheduleEntry[], totalCents: number): SeasonalScheduleEntry[] {
  const old = scheduleTotal(schedule);
  const parts =
    old > 0
      ? schedule.map((e) => Math.round((e.amountCents * totalCents) / old))
      : splitInstallments(totalCents, schedule.length);
  const diff = totalCents - parts.reduce((a, b) => a + b, 0);
  return schedule.map((e, i) => ({ ...e, amountCents: parts[i]! + (i === parts.length - 1 ? diff : 0) }));
}

/** Agenda em N parcelas mensais a partir de um mês. */
function installments(totalCents: number, month: number, day: number, n: number): SeasonalScheduleEntry[] {
  return splitInstallments(totalCents, n).map((amountCents, i) => ({
    month: ((month - 1 + i) % 12) + 1,
    day,
    amountCents,
  }));
}

function monthNumber(v: string | number | null | undefined, today: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v >= 1 && v <= 12 ? v : null;
  if (/^\d{1,2}$/.test(v.trim())) return monthNumber(Number(v), today);
  const m = toMonth(v, today);
  return m ? Number(m.slice(5, 7)) : null;
}

async function emit(ctx: ToolCtx, payload: unknown, preview: DraftPreview) {
  const draft = await createDraft(
    ctx.tx,
    ctx.actor,
    'seasonal',
    payload as never,
    preview,
    ctx.conversationId,
  );
  ctx.emitDraft(draft);
  return {
    draft_id: draft.id,
    status: 'aguardando confirmação do usuário',
    preview: {
      title: preview.title,
      summary: preview.summary,
      warnings: preview.warnings,
      projection_impact: preview.projectionImpact ?? null,
    },
    instruction: 'Mostre a prévia em uma frase curta e peça confirmação. Não diga que já foi gravado.',
  };
}

export const getCalendarTool = defineTool({
  name: 'get_calendar',
  description:
    'Calendário financeiro anual aprendido do histórico: IPVA, IPTU, matrícula e material escolar, 13º, IRPF, restituição, reajustes (plano de saúde, escola, aluguel), anuais como seguro do carro, e come-cotas. Use para "quando vem o IPVA?", "o que pesa no começo do ano?", "qual mês estoura?", "quanto foi o IPTU ano passado?". Itens sugeridos ainda NÃO estão na projeção.',
  kind: 'read',
  schema: z.object({
    months: z.number().int().min(1).max(24).default(12).describe('Horizonte em meses'),
    item: z.string().nullish().describe('Um item específico: "ipva", "13º", "seguro do carro"'),
  }),
  async run(ctx, input) {
    const cal = await seasonalCalendar(ctx.tx, ctx.actor.workspaceId, ctx.today, input.months);
    if (input.item) {
      const it = findSeasonalItem(cal.items, input.item);
      if (!it)
        return {
          found: false,
          answer: `Não encontrei "${input.item}" no seu histórico. Se for um gasto anual, posso cadastrar: me diga valor e mês.`,
        };
      const occ = cal.occurrences.filter((o) => o.itemId === it.id);
      return {
        found: true,
        item: itemSummary(it),
        next: occ.map(occurrenceSentence),
        answer: `${it.label}: ${
          occ.length
            ? occ.map(occurrenceSentence).join('; ')
            : `nada previsto nos próximos ${input.months} meses`
        }.${it.evidence.length ? ` Histórico: ${describeEvidence(it)}.` : ''}${
          it.status === 'suggested' ? ' Ainda não está na projeção; quer que eu coloque?' : ''
        }`,
      };
    }
    const pending = cal.occurrences.filter((o) => !o.paid && o.kind !== 'info');
    const byMonth = new Map<string, number>();
    for (const o of pending)
      if (o.direction === 'out') {
        const m = o.date.slice(0, 7);
        byMonth.set(m, (byMonth.get(m) ?? 0) + o.amountCents);
      }
    const heaviest = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
    const suggested = cal.items.filter((i) => i.status === 'suggested');
    return {
      occurrences: cal.occurrences.map(occurrenceSentence),
      to_confirm: suggested.map((i) => i.label),
      heaviest_month: heaviest ? `${monthLabel(`${heaviest[0]}-01`, true)}: ${formatBRL(heaviest[1])}` : null,
      answer: cal.occurrences.length
        ? `Próximos ${input.months} meses: ${cal.occurrences.map(occurrenceSentence).join('; ')}.${
            heaviest
              ? ` Mês mais pesado: ${monthLabel(`${heaviest[0]}-01`, true)} (${formatBRL(heaviest[1])}).`
              : ''
          }${suggested.length ? ` A confirmar para entrar na projeção: ${suggested.map((i) => i.label).join(', ')}.` : ''}`
        : 'Ainda não achei gastos anuais no seu histórico. Se tiver IPVA, IPTU ou matrícula, me diga valor e mês que eu cadastro.',
    };
  },
});

function itemSummary(it: SeasonalItemDTO) {
  return {
    label: it.label,
    status: it.status === 'confirmed' ? 'na projeção' : it.status === 'dismissed' ? 'ignorado' : 'sugerido',
    confidence: it.confidence,
    schedule:
      it.kind === 'adjustment'
        ? `+${it.adjustmentPct}% em ${MONTHS_SHORT[it.schedule[0]!.month - 1]}`
        : `${formatBRL(scheduleTotal(it.schedule))} ${describeSchedule(it.schedule)}`,
    history: describeEvidence(it),
  };
}

export const draftSeasonalTool = defineTool({
  name: 'draft_seasonal',
  description:
    'Confirma, ajusta, ignora ou cadastra um item do calendário anual (IPVA, IPTU, matrícula, 13º, seguro...). Confirmar coloca o item na projeção. Ex.: "pode colocar o IPVA", "o IPVA deste ano vai ser 2.500", "ignora o seguro", "todo março pago 980 de anuidade da OAB". `amount` é o total do ano.',
  kind: 'draft',
  schema: z.object({
    action: z.enum(['confirm', 'edit', 'dismiss', 'create']),
    item: z
      .string()
      .nullish()
      .describe('Nome do item existente ("ipva", "13º"); obrigatório exceto em create'),
    amount: amountInput.nullish().describe('Total no ano (reais)'),
    month: z
      .union([z.number(), monthInput])
      .nullish()
      .describe('Mês do (primeiro) pagamento: 1–12 ou "janeiro"'),
    day: z.number().int().min(1).max(31).nullish(),
    installments: z.number().int().min(1).max(12).nullish(),
    label: z.string().max(80).nullish().describe('Nome do item novo (create)'),
    direction: z.enum(['in', 'out']).nullish().describe('Para create: in = receita, out = despesa (padrão)'),
    category: z.string().nullish(),
  }),
  async run(ctx, input) {
    const ws = ctx.actor.workspaceId;
    const month = monthNumber(input.month, ctx.today);
    if (input.action === 'create') {
      if (!input.label) throw new AppError(422, 'Qual o nome do item?');
      if (!month) throw new AppError(422, 'Em que mês costuma cair?');
      const totalCents = toCents(input.amount);
      const direction = input.direction ?? 'out';
      const schedule = installments(totalCents, month, input.day ?? 10, input.installments ?? 1);
      const cat = await resolveCategory(ctx.tx, ws, {
        hint: input.category,
        description: input.label,
        direction,
      });
      return emit(
        ctx,
        { mode: 'create', id: null, fields: { label: input.label, direction, categoryId: cat.id, schedule } },
        {
          title: `Novo no calendário: ${input.label}`,
          summary: `${direction === 'in' ? 'Entra' : 'Sai'} ${formatBRL(totalCents)} ${describeSchedule(schedule)} todo ano · entra na projeção`,
          lines: [{ label: 'Categoria', value: cat.name }],
          warnings: [],
        },
      );
    }

    if (!input.item) throw new AppError(422, 'Qual item do calendário?');
    const cal = await seasonalCalendar(ctx.tx, ws, ctx.today, 12);
    const it = findSeasonalItem(cal.items, input.item);
    if (!it) throw new AppError(404, `Não achei "${input.item}" no calendário.`);

    if (input.action === 'dismiss')
      return emit(
        ctx,
        { mode: 'dismiss', id: it.id, fields: {} },
        {
          title: `Ignorar no calendário: ${it.label}`,
          summary: 'Não vou mais sugerir nem lembrar deste item.',
          lines: [],
          warnings: [],
        },
      );

    let schedule: SeasonalScheduleEntry[] | undefined;
    if (it.kind === 'adjustment' || it.kind === 'info') {
      if (input.amount || month)
        throw new AppError(422, 'Reajustes e itens informativos só podem ser confirmados ou ignorados.');
    } else if (input.installments || month) {
      const totalCents = input.amount ? toCents(input.amount) : scheduleTotal(it.schedule);
      const first = month ?? it.schedule[0]!.month;
      schedule = installments(
        totalCents,
        first,
        input.day ?? it.schedule[0]!.day,
        input.installments ?? it.schedule.length,
      );
    } else if (input.amount) {
      schedule = rescale(it.schedule, toCents(input.amount));
    }
    const final = schedule ?? it.schedule;
    const next = cal.occurrences.find((o) => o.itemId === it.id && !o.paid);
    return emit(
      ctx,
      { mode: schedule ? 'edit' : 'confirm', id: it.id, fields: schedule ? { schedule } : {} },
      {
        title: `${schedule ? 'Ajustar' : 'Confirmar'} no calendário: ${it.label}`,
        summary:
          it.kind === 'adjustment'
            ? `Reajuste de ${it.adjustmentPct}% todo ${MONTHS_SHORT[final[0]!.month - 1]} · entra na projeção`
            : `${formatBRL(scheduleTotal(final))} ${describeSchedule(final)} · entra na projeção`,
        lines: [
          ...(it.evidence.length ? [{ label: 'Histórico', value: describeEvidence(it) }] : []),
          ...(next ? [{ label: 'Próximo', value: occurrenceSentence(next) }] : []),
        ],
        warnings:
          it.confidence === 'estimado' ? ['Valor estimado pelo salário; ajuste se souber o valor real.'] : [],
      },
    );
  },
});

export const CALENDAR_TOOLS = [getCalendarTool, draftSeasonalTool];
