import {
  addMonths,
  formatBRL,
  historicalReturn,
  monthLabel,
  retirementMonths,
  retirementPlan,
  startOfMonth,
  type RetirementBaselineDTO,
  type RetirementParams,
  type RetirementProfileDTO,
  type RetirementScenarioDTO,
} from '@sf/shared';
import { sql, type Tx } from '@sf/db';
import type { Actor } from '../context.js';
import { AppError } from '../lib/errors.js';
import { emergencyReserve } from './forecast.js';
import { buildPortfolio } from './portfolio.js';
import { listAccounts } from './queries.js';

export const RETIREMENT_DEFAULTS: Omit<RetirementProfileDTO, 'birthDate'> = {
  retireAge: 65,
  endAge: 90,
  accumulationRate: 0.04,
  withdrawalRate: 0.03,
  contributionGrowth: 0,
  inssMonthlyCents: null,
  targetIncomeCents: null,
  includeInvestments: false,
};

/** Ajustes pontuais de uma pergunta ("e se eu aposentar em 2040?"); não alteram o perfil salvo. */
export interface RetirementOverrides {
  birthDate?: string | null;
  retireYear?: number | null;
  retireAge?: number | null;
  endAge?: number | null;
  accumulationRate?: number | null;
  withdrawalRate?: number | null;
  contributionGrowth?: number | null;
  targetIncomeCents?: number | null;
  inssMonthlyCents?: number | null;
  includeInvestments?: boolean | null;
}

export async function getRetirementProfile(tx: Tx, actor: Actor): Promise<RetirementProfileDTO | null> {
  const r = await tx
    .selectFrom('retirementProfiles')
    .select([
      'birthDate',
      'retireAge',
      'endAge',
      'accumulationRate',
      'withdrawalRate',
      'contributionGrowth',
      'inssMonthlyCents',
      'targetIncomeCents',
      'includeInvestments',
    ])
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .executeTakeFirst();
  return r ?? null;
}

/**
 * Saldo, contribuições e gasto de hoje. Entram os planos do usuário (e os sem dono); a carteira é
 * sempre calculada para a tela ligar e desligar o flag sem nova consulta.
 */
export async function retirementBaseline(
  tx: Tx,
  actor: Actor,
  today: string,
): Promise<RetirementBaselineDTO> {
  const ws = actor.workspaceId;
  const warnings: string[] = [];
  const allPlans = await tx
    .selectFrom('pensionPlans')
    .select(['id', 'provider', 'name', 'ownerUserId', 'debitAccountId'])
    .where('workspaceId', '=', ws)
    .execute();
  const mine = allPlans.filter((p) => p.ownerUserId === null || p.ownerUserId === actor.userId);
  const others = allPlans.length - mine.length;
  if (others)
    warnings.push(
      `${others === 1 ? 'Há 1 plano' : `Há ${others} planos`} de outro membro, fora deste cenário.`,
    );
  const ids = mine.map((p) => p.id);

  const entries = ids.length
    ? await tx
        .selectFrom('pensionEntries')
        .select(['planId', 'refMonth', 'balanceCents', 'contribParticipantCents', 'contribSponsorCents'])
        .where('planId', 'in', ids)
        .where('refMonth', '>=', addMonths(startOfMonth(today), -24))
        .orderBy('refMonth')
        .execute()
    : [];
  const latest = new Map<string, (typeof entries)[number]>();
  for (const e of entries) latest.set(e.planId, e);
  const plans = mine
    .filter((p) => latest.has(p.id))
    .map((p) => ({
      id: p.id,
      provider: p.provider,
      name: p.name,
      balanceCents: latest.get(p.id)!.balanceCents,
      refMonth: latest.get(p.id)!.refMonth,
    }));
  const pensionBalanceCents = plans.reduce((s, p) => s + p.balanceCents, 0);
  const balanceAsOf = plans.length
    ? plans
        .map((p) => p.refMonth)
        .sort()
        .at(-1)!
    : null;
  const startMonth = balanceAsOf ? addMonths(balanceAsOf, 1) : startOfMonth(today);
  if (!balanceAsOf)
    warnings.push('Sem extrato da previdência: importe um extrato ou inclua os investimentos.');
  else if (balanceAsOf < addMonths(startOfMonth(today), -3))
    warnings.push(`O extrato mais recente é de ${monthLabel(balanceAsOf)}; a simulação parte dele.`);

  // Contribuição: média dos últimos 6 meses com extrato (participante + patrocinadora, todos os planos)
  const byMonth = new Map<string, { total: number; participantDebited: number }>();
  const debited = new Set(mine.filter((p) => p.debitAccountId).map((p) => p.id));
  for (const e of entries) {
    const m = byMonth.get(e.refMonth) ?? { total: 0, participantDebited: 0 };
    m.total += e.contribParticipantCents + e.contribSponsorCents;
    if (debited.has(e.planId)) m.participantDebited += e.contribParticipantCents;
    byMonth.set(e.refMonth, m);
  }
  const recent = [...byMonth.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 6);
  const avg = (k: 'total' | 'participantDebited') =>
    recent.length ? Math.round(recent.reduce((s, [, v]) => s + v[k], 0) / recent.length) : 0;
  const monthlyContributionCents = avg('total');

  // Rentabilidade histórica (só referência), ponderada pelo saldo de cada plano
  let historical: RetirementBaselineDTO['historical'] = null;
  if (entries.length) {
    const ipcaRows = await tx
      .selectFrom('benchmarks')
      .select(['date', 'value'])
      .where('series', '=', 'IPCA')
      .where('date', '>=', entries[0]!.refMonth)
      .execute();
    const ipca = new Map(ipcaRows.map((r) => [startOfMonth(r.date), Number(r.value)]));
    const per = plans
      .map((p) => ({
        weight: p.balanceCents,
        r: historicalReturn(
          entries
            .filter((e) => e.planId === p.id)
            .map((e) => ({
              refMonth: e.refMonth,
              balanceCents: e.balanceCents,
              contributionCents: e.contribParticipantCents + e.contribSponsorCents,
            })),
          ipca,
        ),
      }))
      .filter((x) => x.r && x.weight > 0);
    const w = per.reduce((s, x) => s + x.weight, 0);
    if (w > 0) {
      const realOk = per.every((x) => x.r!.realAnnual !== null);
      historical = {
        nominalAnnual: per.reduce((s, x) => s + x.r!.nominalAnnual * x.weight, 0) / w,
        realAnnual: realOk ? per.reduce((s, x) => s + x.r!.realAnnual! * x.weight, 0) / w : null,
        months: Math.min(...per.map((x) => x.r!.months)),
      };
    }
  }

  // Carteira e contas de investimento (entram só com o flag)
  const pf = await buildPortfolio(tx, ws, today);
  const accounts = await listAccounts(tx, ws, today);
  const otherAssetsCents =
    pf.positions.reduce((s, p) => s + Math.max(0, p.marketValueCents), 0) +
    accounts.filter((a) => a.type === 'investment').reduce((s, a) => s + Math.max(0, a.balanceBrlCents), 0);

  // Gasto mensal: o custo médio dos próximos 12 meses da projeção; sem projeção, os últimos 6 meses
  let monthlyExpenseCents = (await emergencyReserve(tx, ws, today, pf)).monthlyCostCents;
  let expenseSource: RetirementBaselineDTO['expenseSource'] = 'projection_12m';
  if (monthlyExpenseCents <= 0) {
    const from = addMonths(startOfMonth(today), -6);
    const r = await sql<{ cents: number }>`
      select coalesce(sum(amount_brl_cents), 0)::bigint as cents from transactions
      where workspace_id = ${ws}::uuid and status = 'posted' and kind = 'regular' and direction = 'out'
        and date >= ${from}::date and date < ${startOfMonth(today)}::date`.execute(tx);
    monthlyExpenseCents = Math.round(Number(r.rows[0]?.cents ?? 0) / 6);
    expenseSource = monthlyExpenseCents > 0 ? 'history_6m' : 'none';
  }
  // Contribuição debitada em conta é gasto de hoje que para na aposentadoria
  const debitedCents = avg('participantDebited');
  if (debitedCents > 0 && monthlyExpenseCents > 0) {
    monthlyExpenseCents = Math.max(0, monthlyExpenseCents - debitedCents);
    warnings.push(`Tirei do gasto a contribuição debitada em conta (${formatBRL(debitedCents)}/mês).`);
  }

  return {
    plans,
    pensionBalanceCents,
    balanceAsOf,
    startMonth,
    monthlyContributionCents,
    contributionMonths: recent.length,
    otherAssetsCents,
    monthlyExpenseCents,
    expenseSource,
    historical,
    warnings,
  };
}

/** Cenário de aposentadoria: ajustes da pergunta, depois o perfil salvo, depois os padrões. */
export async function retirementScenario(
  tx: Tx,
  actor: Actor,
  today: string,
  o: RetirementOverrides = {},
): Promise<RetirementScenarioDTO> {
  const profile = await getRetirementProfile(tx, actor);
  const baseline = await retirementBaseline(tx, actor, today);
  const d = { ...RETIREMENT_DEFAULTS, ...profile };
  const assumptions: RetirementScenarioDTO['assumptions'] = {
    birthDate: o.birthDate ?? profile?.birthDate ?? null,
    retireYear: o.retireYear ?? null,
    retireAge: o.retireAge ?? d.retireAge,
    endAge: o.endAge ?? d.endAge,
    accumulationRate: o.accumulationRate ?? d.accumulationRate,
    withdrawalRate: o.withdrawalRate ?? d.withdrawalRate,
    contributionGrowth: o.contributionGrowth ?? d.contributionGrowth,
    inssMonthlyCents: o.inssMonthlyCents !== undefined ? o.inssMonthlyCents : d.inssMonthlyCents,
    targetIncomeCents: o.targetIncomeCents !== undefined ? o.targetIncomeCents : d.targetIncomeCents,
    includeInvestments: o.includeInvestments ?? d.includeInvestments,
  };
  const needSource = assumptions.targetIncomeCents ? 'target' : baseline.expenseSource;
  const out: RetirementScenarioDTO = {
    profile,
    assumptions,
    baseline,
    needSource,
    params: null,
    plan: null,
    missing: [],
    warnings: [...baseline.warnings],
  };
  if (!assumptions.birthDate) {
    out.missing.push('birth_date');
    return out;
  }
  try {
    const months = retirementMonths({
      birthDate: assumptions.birthDate,
      endAge: assumptions.endAge,
      retireAge: assumptions.retireAge,
      retireYear: assumptions.retireYear,
    });
    const params: RetirementParams = {
      ...months,
      startMonth: baseline.startMonth,
      birthDate: assumptions.birthDate,
      pensionBalanceCents: baseline.pensionBalanceCents,
      otherAssetsCents: assumptions.includeInvestments ? baseline.otherAssetsCents : 0,
      monthlyContributionCents: baseline.monthlyContributionCents,
      contributionGrowth: assumptions.contributionGrowth,
      accumulationRate: assumptions.accumulationRate,
      withdrawalRate: assumptions.withdrawalRate,
      neededMonthlyCents: assumptions.targetIncomeCents ?? baseline.monthlyExpenseCents,
      inssMonthlyCents: assumptions.inssMonthlyCents ?? 0,
    };
    out.params = params;
    out.plan = retirementPlan(params);
  } catch (err) {
    if (err instanceof RangeError) throw new AppError(422, err.message, 'invalid_scenario');
    throw err;
  }
  if (assumptions.includeInvestments && baseline.otherAssetsCents > 0)
    out.warnings.push('Os investimentos considerados são os do workspace inteiro.');
  if (out.plan.alreadyRetired)
    out.warnings.push('A data pedida já passou; considerei o benefício a partir de agora.');
  if (needSource === 'none') out.warnings.push('Não achei gastos para comparar; informe a renda que deseja.');
  return out;
}

const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% a.a.`;
const NEED_LABEL: Record<RetirementScenarioDTO['needSource'], string> = {
  projection_12m: 'seu custo médio projetado',
  history_6m: 'sua média de gastos dos últimos 6 meses',
  target: 'a renda que você definiu',
  none: 'sem gastos para comparar',
};

/** Resposta pronta para o chat, como `emergencyReserveAnswer`. */
export function retirementAnswer(s: RetirementScenarioDTO): string {
  if (!s.plan || !s.params)
    return 'Para simular a aposentadoria preciso da sua data de nascimento. Me diga (por exemplo, "nasci em 15/03/1985") que eu salvo no seu perfil.';
  const p = s.plan;
  const a = s.assumptions;
  const sources =
    a.includeInvestments && s.params.otherAssetsCents > 0
      ? 'a previdência e os investimentos'
      : 'a previdência';
  const parts = [
    `Aposentando em ${monthLabel(p.retireMonth, true)} (aos ${Math.floor(p.retireAge)} anos), ${sources} chegaria a ${formatBRL(p.capitalAtRetirementCents)} e pagaria cerca de ${formatBRL(p.projectedMonthlyCents)} por mês até os ${a.endAge} anos${s.params.inssMonthlyCents > 0 ? `; com o INSS, ${formatBRL(p.projectedIncomeCents)}` : ''}.`,
  ];
  if (p.neededMonthlyCents > 0) {
    parts.push(`A referência é ${formatBRL(p.neededMonthlyCents)} por mês (${NEED_LABEL[s.needSource]}).`);
    if (p.gapCents > 0) {
      parts.push(
        `Faltam ${formatBRL(p.gapCents)} por mês: seria preciso juntar mais ${formatBRL(p.capitalGapCents)} até lá${p.extraMonthlyCents ? `, o equivalente a aportar ${formatBRL(p.extraMonthlyCents)} a mais por mês` : ''}.` +
          (p.lastsUntilAge !== null
            ? ` Gastando isso, o dinheiro dura até os ${Math.floor(p.lastsUntilAge)} anos.`
            : ''),
      );
    } else parts.push(`Sobram ${formatBRL(p.surplusCents)} por mês.`);
  }
  parts.push(
    `Valores em reais de hoje, antes de IR. Premissas: rendimento real de ${pct(a.accumulationRate)} até aposentar e ${pct(a.withdrawalRate)} depois, contribuição de ${formatBRL(s.params.monthlyContributionCents)}/mês. É uma estimativa, não a regra de benefício do plano.`,
  );
  if (s.warnings.length) parts.push(s.warnings.join(' '));
  return parts.join(' ');
}
