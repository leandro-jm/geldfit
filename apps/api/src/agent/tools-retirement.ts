import { z } from 'zod';
import {
  formatBRL,
  formatDateBR,
  isoFromParts,
  monthLabel,
  parseAmount,
  parseISO,
  retirementMonths,
  type DraftPreview,
  type RetirementProfileDTO,
} from '@sf/shared';
import { AppError } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import {
  getRetirementProfile,
  RETIREMENT_DEFAULTS,
  retirementAnswer,
  retirementScenario,
} from '../domain/retirement.js';
import { amountInput, defineTool } from './tool-kit.js';

const pctInput = (what: string) =>
  z.number().nullish().describe(`${what}, em % ao ano acima da inflação (ex.: 4)`);
const fmtPct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% a.a.`;

function toRate(v: number | null | undefined, min: number, max: number, field: string): number | undefined {
  if (v === null || v === undefined) return undefined;
  const r = v / 100;
  if (r < min || r > max)
    throw new AppError(422, `${field} precisa ficar entre ${min * 100}% e ${max * 100}% ao ano.`, 'invalid');
  return r;
}

/** Valor opcional; zero limpa o campo (null). */
function toOptionalCents(v: string | number | null | undefined, field: string): number | null | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const c = parseAmount(v);
  if (c === null || !Number.isFinite(c) || c < 0)
    throw new AppError(422, `Não entendi o ${field} "${v}".`, 'invalid');
  return c === 0 ? null : c;
}

/**
 * Data de nascimento: ISO ou dd/mm/aaaa. Com ano de 2 dígitos, o século que não cai no futuro
 * ("85" é 1985; o parser de datas relativas leria 2085).
 */
export function parseBirthDate(v: string, today: string): string {
  const s = v.trim();
  let y: number, m: number, d: number;
  const isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const brM = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (isoM) [y, m, d] = [Number(isoM[1]), Number(isoM[2]), Number(isoM[3])];
  else if (brM) {
    [d, m, y] = [Number(brM[1]), Number(brM[2]), Number(brM[3])];
    if (brM[3]!.length === 2) y += 2000 + y > parseISO(today).y ? 1900 : 2000;
  } else throw new AppError(422, `Não entendi a data de nascimento "${v}". Use dd/mm/aaaa.`, 'invalid');
  const iso = isoFromParts(y, m, d);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    throw new AppError(422, `A data ${v} não existe.`, 'invalid');
  const age = parseISO(today).y - y;
  if (iso > today || age < 14 || age > 110)
    throw new AppError(422, `A data de nascimento ${formatDateBR(iso)} não parece certa.`, 'invalid');
  return iso;
}

const commonInput = {
  retire_age: z.number().int().nullish().describe('Idade em que pretende se aposentar'),
  end_age: z.number().int().nullish().describe('Até que idade a renda deve durar (padrão 90)'),
  accumulation_rate_pct: pctInput('Rendimento real até a aposentadoria'),
  withdrawal_rate_pct: pctInput('Rendimento real depois de aposentado'),
  contribution_growth_pct: pctInput('Crescimento real das contribuições'),
  target_income: amountInput
    .nullish()
    .describe('Renda mensal desejada, em reais de hoje (padrão: gasto atual)'),
  inss_monthly: amountInput.nullish().describe('Benefício do INSS esperado por mês, em reais de hoje'),
  include_investments: z
    .boolean()
    .nullish()
    .describe('Somar a carteira e as contas de investimento à previdência'),
};

type CommonInput = { [K in keyof typeof commonInput]?: z.infer<(typeof commonInput)[K]> };

function commonOverrides(i: CommonInput) {
  return {
    retireAge: i.retire_age ?? undefined,
    endAge: i.end_age ?? undefined,
    accumulationRate: toRate(i.accumulation_rate_pct, -0.05, 0.2, 'O rendimento até aposentar'),
    withdrawalRate: toRate(i.withdrawal_rate_pct, -0.05, 0.2, 'O rendimento depois de aposentado'),
    contributionGrowth: toRate(i.contribution_growth_pct, -0.1, 0.1, 'O crescimento das contribuições'),
    targetIncomeCents: toOptionalCents(i.target_income, 'renda desejada'),
    inssMonthlyCents: toOptionalCents(i.inss_monthly, 'valor do INSS'),
    includeInvestments: i.include_investments ?? undefined,
  };
}

export const retirementScenarioTool = defineTool({
  name: 'retirement_scenario',
  description:
    'Aposentadoria além dos 24 meses da projeção: projeta o saldo e as contribuições da previdência fechada até a data de aposentadoria e calcula a renda mensal constante até a idade final, quanto falta frente ao gasto atual (ou à renda desejada) e o aporte extra para fechar a diferença. Valores em reais de hoje. Use para "se eu aposentar em 2040, quanto recebo?", "quanto falta para eu me aposentar?", "e se eu me aposentar aos 60?". Ajustes passados aqui valem só para a pergunta.',
  kind: 'read',
  schema: z.object({
    retire_year: z.number().int().nullish().describe('Ano em que pretende se aposentar (ex.: 2040)'),
    ...commonInput,
    birth_date: z.string().nullish().describe('Data de nascimento, se o usuário informou agora (dd/mm/aaaa)'),
  }),
  async run(ctx, input) {
    const s = await retirementScenario(ctx.tx, ctx.actor, ctx.today, {
      ...commonOverrides(input),
      retireYear: input.retire_year ?? undefined,
      birthDate: input.birth_date ? parseBirthDate(input.birth_date, ctx.today) : undefined,
    });
    const answer = retirementAnswer(s);
    if (!s.plan) return { missing: ['data de nascimento'], answer };
    const p = s.plan;
    const a = s.assumptions;
    return {
      retire: monthLabel(p.retireMonth, true),
      retire_age: Math.floor(p.retireAge),
      end_age: a.endAge,
      capital_at_retirement: formatBRL(p.capitalAtRetirementCents),
      monthly_income: formatBRL(p.projectedMonthlyCents),
      income_with_inss: formatBRL(p.projectedIncomeCents),
      needed: formatBRL(p.neededMonthlyCents),
      need_source: s.needSource,
      gap: formatBRL(p.gapCents),
      surplus: formatBRL(p.surplusCents),
      capital_gap: formatBRL(p.capitalGapCents),
      extra_monthly: p.extraMonthlyCents === null ? null : formatBRL(p.extraMonthlyCents),
      lasts_until_age: p.lastsUntilAge,
      assumptions: {
        pension_balance: formatBRL(s.baseline.pensionBalanceCents),
        balance_as_of: s.baseline.balanceAsOf ? monthLabel(s.baseline.balanceAsOf) : null,
        monthly_contribution: formatBRL(s.baseline.monthlyContributionCents),
        accumulation_rate: fmtPct(a.accumulationRate),
        withdrawal_rate: fmtPct(a.withdrawalRate),
        contribution_growth: fmtPct(a.contributionGrowth),
        includes_investments: a.includeInvestments,
        historical_real_return:
          s.baseline.historical?.realAnnual != null ? fmtPct(s.baseline.historical.realAnnual) : null,
      },
      warnings: s.warnings,
      answer,
    };
  },
});

export const draftRetirementProfileTool = defineTool({
  name: 'draft_retirement_profile',
  description:
    'Salva as premissas de aposentadoria do usuário (data de nascimento, idade de aposentadoria, idade final, rendimentos reais, INSS esperado, renda desejada, incluir investimentos). Use quando ele informar a data de nascimento ("nasci em 15/03/1985") ou pedir para guardar uma premissa ("quero me aposentar aos 60", "considere 5% de rendimento"). Gera prévia.',
  kind: 'draft',
  schema: z.object({
    birth_date: z.string().nullish().describe('Data de nascimento (dd/mm/aaaa ou AAAA-MM-DD)'),
    current_age: z.number().int().nullish().describe('Idade atual, se ele não disser a data de nascimento'),
    ...commonInput,
  }),
  async run(ctx, input) {
    const current = await getRetirementProfile(ctx.tx, ctx.actor);
    const warnings: string[] = [];
    let birthDate = current?.birthDate ?? null;
    if (input.birth_date) birthDate = parseBirthDate(input.birth_date, ctx.today);
    else if (input.current_age != null) {
      const { y, m } = parseISO(ctx.today);
      birthDate = parseBirthDate(isoFromParts(y - input.current_age, m, 1), ctx.today);
      warnings.push('Data de nascimento aproximada pela idade.');
    }
    if (!birthDate) throw new AppError(422, 'Informe sua data de nascimento (dd/mm/aaaa).', 'missing');

    const o = commonOverrides(input);
    const base = { ...RETIREMENT_DEFAULTS, ...current };
    const payload: RetirementProfileDTO = {
      birthDate,
      retireAge: o.retireAge ?? base.retireAge,
      endAge: o.endAge ?? base.endAge,
      accumulationRate: o.accumulationRate ?? base.accumulationRate,
      withdrawalRate: o.withdrawalRate ?? base.withdrawalRate,
      contributionGrowth: o.contributionGrowth ?? base.contributionGrowth,
      inssMonthlyCents: o.inssMonthlyCents !== undefined ? o.inssMonthlyCents : base.inssMonthlyCents,
      targetIncomeCents: o.targetIncomeCents !== undefined ? o.targetIncomeCents : base.targetIncomeCents,
      includeInvestments: o.includeInvestments ?? base.includeInvestments,
    };
    if (payload.retireAge < 30 || payload.retireAge > 90)
      throw new AppError(422, 'A idade de aposentadoria precisa ficar entre 30 e 90 anos.', 'invalid');
    if (payload.endAge <= payload.retireAge || payload.endAge > 110)
      throw new AppError(422, 'A idade final precisa ser maior que a de aposentadoria (até 110).', 'invalid');
    const { retireMonth } = retirementMonths(payload);

    const preview: DraftPreview = {
      title: current ? 'Atualizar perfil de aposentadoria' : 'Perfil de aposentadoria',
      summary: `Aposentadoria aos ${payload.retireAge} (${monthLabel(retireMonth)}), renda até os ${payload.endAge}`,
      lines: [
        { label: 'Nascimento', value: formatDateBR(payload.birthDate) },
        { label: 'Aposentadoria', value: `aos ${payload.retireAge} anos (${monthLabel(retireMonth)})` },
        { label: 'Renda até', value: `${payload.endAge} anos` },
        {
          label: 'Rendimento real',
          value: `${fmtPct(payload.accumulationRate)} até aposentar · ${fmtPct(payload.withdrawalRate)} depois`,
        },
        ...(payload.contributionGrowth
          ? [{ label: 'Contribuições crescem', value: fmtPct(payload.contributionGrowth) }]
          : []),
        {
          label: 'INSS esperado',
          value: payload.inssMonthlyCents ? `${formatBRL(payload.inssMonthlyCents)}/mês` : 'não considerado',
          tone: payload.inssMonthlyCents ? undefined : ('muted' as const),
        },
        {
          label: 'Renda desejada',
          value: payload.targetIncomeCents ? `${formatBRL(payload.targetIncomeCents)}/mês` : 'gasto atual',
        },
        {
          label: 'Investimentos',
          value: payload.includeInvestments ? 'somados à previdência' : 'fora do cálculo',
        },
      ],
      warnings,
    };
    const draft = await createDraft(
      ctx.tx,
      ctx.actor,
      'retirement_profile',
      payload,
      preview,
      ctx.conversationId,
    );
    ctx.emitDraft(draft);
    return {
      draft_id: draft.id,
      status: 'aguardando confirmação do usuário',
      preview: { title: preview.title, summary: preview.summary, warnings },
      instruction: 'Mostre a prévia em uma frase curta e peça confirmação. Não diga que já foi gravado.',
    };
  },
});

export const RETIREMENT_TOOLS = [retirementScenarioTool, draftRetirementProfileTool];
