import { z } from 'zod';
import {
  formatBRL,
  formatDateBR,
  goalPlan,
  INCOME_STABILITY,
  INTERESTS,
  LIFE_STAGES,
  MEMORY_CATEGORIES,
  NUDGE_FREQUENCY,
  OBJECTIVES,
  RISK_SELF,
  UFS,
  type DraftPreview,
} from '@sf/shared';
import { AppError } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import { getProfile, PROFILE_PATCH_SCHEMA, profileForPrompt, type ProfilePatch } from '../domain/profile.js';
import { forgetMatching, listMemories, rememberFact } from './memory.js';
import { defineTool } from './tool-kit.js';

const enumOf = <T extends Record<string, string>>(o: T) =>
  z.enum(Object.keys(o) as [keyof T & string, ...(keyof T & string)[]]);

export const listMemoriesTool = defineTool({
  name: 'list_memories',
  description:
    'Lista o que você sabe sobre o usuário (memória de longo prazo: objetivos, família, preferências, compromissos), inclusive fatos pendentes de confirmação. Use para "o que você sabe sobre mim?" ou antes de propor metas.',
  kind: 'read',
  schema: z.object({ category: z.enum(MEMORY_CATEGORIES).nullish() }),
  async run(ctx, input) {
    const all = await listMemories(ctx.tx, ctx.actor, ['active', 'pending']);
    const items = all.filter((m) => !input.category || m.category === input.category);
    const profile = await getProfile(ctx.tx, ctx.actor);
    return {
      memories: items.map((m) => ({
        id: m.id,
        category: m.category,
        content: m.content,
        status: m.status === 'pending' ? 'pendente de confirmação' : 'ativa',
        prazo: m.expiresAt ? formatDateBR(m.expiresAt) : null,
        compartilhada: !m.mine,
      })),
      profile: profileForPrompt(profile),
      note: 'O usuário pode ver, editar e apagar tudo em Assistente › O que sei sobre você.',
      answer: items.length
        ? `Isto é o que anotei sobre você:\n${items.map((m) => `- ${m.content}${m.status === 'pending' ? ' (aguardando sua confirmação)' : ''}`).join('\n')}\nVocê pode editar ou apagar em Assistente.`
        : 'Ainda não anotei nada sobre você. Pode me contar seus objetivos, por exemplo "quero trocar de carro em 2027".',
    };
  },
});

export const listGoalsTool = defineTool({
  name: 'list_goals',
  description:
    'Lista as metas do usuário com progresso: quanto falta, aporte mensal, aporte necessário para o prazo e status (em dia, atrasada). Use antes de alterar uma meta (draft_goal precisa do goal_id) ou para "como estão minhas metas?".',
  kind: 'read',
  schema: z.object({ include_done: z.boolean().nullish() }),
  async run(ctx, input) {
    const rows = await ctx.tx
      .selectFrom('goals')
      .selectAll()
      .where('workspaceId', '=', ctx.actor.workspaceId)
      .where('status', 'in', input.include_done ? ['active', 'done'] : ['active'])
      .orderBy('createdAt')
      .execute();
    const STATUS = {
      done: 'concluída',
      on_track: 'em dia',
      behind: 'atrasada para o prazo',
      overdue: 'prazo vencido',
      no_date: 'sem prazo',
    };
    return {
      goals: rows.map((g) => {
        const plan = goalPlan(
          {
            targetCents: g.targetCents,
            savedCents: g.savedCents,
            monthlyContributionCents: g.monthlyContributionCents,
            startMonth: g.startMonth,
            targetDate: g.targetDate,
          },
          ctx.today,
        );
        return {
          goal_id: g.id,
          name: g.name,
          kind: g.kind,
          target: formatBRL(g.targetCents),
          saved: formatBRL(g.savedCents),
          remaining: formatBRL(plan.remainingCents),
          monthly: g.monthlyContributionCents ? formatBRL(g.monthlyContributionCents) : null,
          target_date: g.targetDate ? formatDateBR(g.targetDate) : null,
          monthly_needed_for_date: plan.recommendedMonthlyCents
            ? formatBRL(plan.recommendedMonthlyCents)
            : null,
          finish_month: plan.finishMonth,
          status: STATUS[plan.status],
        };
      }),
    };
  },
});

export const rememberTool = defineTool({
  name: 'remember',
  description:
    'Guarda um fato duradouro que o usuário pediu para você lembrar ("lembra que meu filho nasce em março", "anota que quero trocar de carro em 2027"). Não use para lançamentos ou valores que já ficam no app. Grava na hora (é dado pessoal do próprio usuário) e ele pode apagar depois.',
  kind: 'read',
  schema: z.object({
    content: z.string().describe('O fato em 3ª pessoa, curto ("Filho nasce em março de 2027")'),
    category: z.enum(MEMORY_CATEGORIES),
    expires_at: z.string().nullish().describe('AAAA-MM-DD se for compromisso com prazo'),
    shared: z.boolean().nullish().describe('true para fatos da família visíveis aos membros do workspace'),
    importance: z.number().int().min(1).max(5).nullish(),
  }),
  async run(ctx, input) {
    const m = await rememberFact(ctx.tx, ctx.actor, {
      content: input.content,
      category: input.category,
      scope: input.shared ? 'household' : 'personal',
      importance: input.importance ?? 4,
      expiresAt: input.expires_at ?? null,
      source: 'tool',
    });
    return { saved: true, memory_id: m.id, content: m.content, answer: `Anotado: ${m.content}.` };
  },
});

export const forgetTool = defineTool({
  name: 'forget',
  description:
    'Esquece (arquiva) um fato da memória quando o usuário pedir ("esquece que eu queria viajar", "isso não vale mais"). Passe o memory_id de list_memories ou um texto de busca.',
  kind: 'read',
  schema: z.object({ memory_id: z.string().uuid().nullish(), search: z.string().nullish() }),
  async run(ctx, input) {
    if (!input.memory_id && !input.search) throw new AppError(422, 'O que devo esquecer?', 'missing');
    const gone = await forgetMatching(ctx.tx, ctx.actor, { id: input.memory_id, search: input.search });
    if (!gone.length)
      return {
        forgotten: 0,
        answer: 'Não encontrei nada parecido na memória. Quer ver o que eu sei sobre você?',
      };
    return {
      forgotten: gone.length,
      items: gone.map((g) => g.content),
      answer: `Pronto, esqueci: ${gone.map((g) => g.content).join('; ')}.`,
    };
  },
});

export const updateProfileTool = defineTool({
  name: 'update_profile',
  description:
    'Atualiza o perfil financeiro do usuário (fase de vida, dependentes, tipo de renda, perfil de risco autodeclarado, objetivos, temas que quer acompanhar, se tem carro ou casa, UF, frequência de avisos proativos). Passe só o que ele informou. Gera prévia para confirmação. O perfil de risco é só autodeclarado: não indica produtos.',
  kind: 'draft',
  schema: z.object({
    life_stage: enumOf(LIFE_STAGES).nullish(),
    dependents: z.number().int().min(0).max(20).nullish(),
    income_stability: enumOf(INCOME_STABILITY).nullish(),
    risk_self: enumOf(RISK_SELF).nullish(),
    objectives_add: z.array(enumOf(OBJECTIVES)).nullish(),
    objectives_remove: z.array(enumOf(OBJECTIVES)).nullish(),
    interests_add: z.array(enumOf(INTERESTS)).nullish(),
    interests_remove: z.array(enumOf(INTERESTS)).nullish(),
    owns_vehicle: z.boolean().nullish(),
    owns_home: z.boolean().nullish(),
    uf: z.enum(UFS).nullish(),
    nudge_frequency: enumOf(NUDGE_FREQUENCY).nullish(),
  }),
  async run(ctx, input) {
    const current = await getProfile(ctx.tx, ctx.actor);
    const patch: ProfilePatch = {};
    const lines: DraftPreview['lines'] = [];
    const set = <K extends keyof ProfilePatch>(k: K, v: ProfilePatch[K], label: string, shown: string) => {
      patch[k] = v;
      lines.push({ label, value: shown });
    };
    if (input.life_stage) set('lifeStage', input.life_stage, 'Fase de vida', LIFE_STAGES[input.life_stage]);
    if (input.dependents != null)
      set('dependents', input.dependents, 'Dependentes', String(input.dependents));
    if (input.income_stability)
      set('incomeStability', input.income_stability, 'Renda', INCOME_STABILITY[input.income_stability]);
    if (input.risk_self)
      set('riskSelf', input.risk_self, 'Perfil de risco (autodeclarado)', RISK_SELF[input.risk_self]);
    const merge = (cur: string[], add?: string[] | null, remove?: string[] | null) =>
      [...new Set([...cur, ...(add ?? [])])].filter((x) => !(remove ?? []).includes(x));
    if (input.objectives_add?.length || input.objectives_remove?.length) {
      const next = merge(current.objectives, input.objectives_add, input.objectives_remove);
      set(
        'objectives',
        next as ProfilePatch['objectives'],
        'Objetivos',
        next.map((o) => OBJECTIVES[o as keyof typeof OBJECTIVES]).join(', ') || 'nenhum',
      );
    }
    if (input.interests_add?.length || input.interests_remove?.length) {
      const next = merge(current.interests, input.interests_add, input.interests_remove);
      set(
        'interests',
        next as ProfilePatch['interests'],
        'Acompanhar',
        next.map((i) => INTERESTS[i as keyof typeof INTERESTS]).join(', ') || 'nada',
      );
    }
    if (input.owns_vehicle != null)
      set('ownsVehicle', input.owns_vehicle, 'Veículo', input.owns_vehicle ? 'sim' : 'não');
    if (input.owns_home != null)
      set('ownsHome', input.owns_home, 'Casa própria', input.owns_home ? 'sim' : 'não');
    if (input.uf) set('uf', input.uf, 'UF', input.uf);
    if (input.nudge_frequency)
      set(
        'nudgeFrequency',
        input.nudge_frequency,
        'Avisos proativos',
        NUDGE_FREQUENCY[input.nudge_frequency],
      );
    if (!lines.length) throw new AppError(422, 'Nada para atualizar no perfil.', 'missing');
    const payload = PROFILE_PATCH_SCHEMA.parse(patch);
    const preview: DraftPreview = {
      title: 'Atualizar perfil financeiro',
      summary: lines.map((l) => `${l.label}: ${l.value}`).join(' · '),
      lines,
      warnings: [],
    };
    const draft = await createDraft(
      ctx.tx,
      ctx.actor,
      'financial_profile',
      payload,
      preview,
      ctx.conversationId,
    );
    ctx.emitDraft(draft);
    return {
      draft_id: draft.id,
      status: 'aguardando confirmação do usuário',
      preview: { title: preview.title, summary: preview.summary },
      instruction: 'Mostre a prévia em uma frase curta e peça confirmação. Não diga que já foi gravado.',
    };
  },
});

export const MEMORY_TOOLS = [listMemoriesTool, listGoalsTool, rememberTool, forgetTool, updateProfileTool];
