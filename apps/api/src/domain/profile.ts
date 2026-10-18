import { z } from 'zod';
import type { Tx } from '@sf/db';
import {
  INCOME_STABILITY,
  INTERESTS,
  LIFE_STAGES,
  NUDGE_FREQUENCY,
  OBJECTIVES,
  RISK_SELF,
  UFS,
  type FinancialProfileDTO,
} from '@sf/shared';
import type { Actor } from '../context.js';

const keys = <T extends Record<string, string>>(o: T) =>
  Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

/** Campos editáveis do perfil (todos opcionais: o patch só muda o que vier). */
export const PROFILE_PATCH_SCHEMA = z
  .object({
    lifeStage: z.enum(keys(LIFE_STAGES)).nullable(),
    dependents: z.number().int().min(0).max(20).nullable(),
    incomeStability: z.enum(keys(INCOME_STABILITY)).nullable(),
    riskSelf: z.enum(keys(RISK_SELF)).nullable(),
    objectives: z.array(z.enum(keys(OBJECTIVES))).max(10),
    interests: z.array(z.enum(keys(INTERESTS))).max(10),
    ownsVehicle: z.boolean().nullable(),
    ownsHome: z.boolean().nullable(),
    uf: z.enum(UFS).nullable(),
    nudgeFrequency: z.enum(keys(NUDGE_FREQUENCY)),
    nudgeChannels: z.array(z.enum(['whatsapp', 'web'])).max(2),
    questionsEnabled: z.boolean(),
    memoryAuto: z.boolean(),
  })
  .partial();
export type ProfilePatch = z.infer<typeof PROFILE_PATCH_SCHEMA>;

export const PROFILE_DEFAULTS: FinancialProfileDTO = {
  lifeStage: null,
  dependents: null,
  incomeStability: null,
  riskSelf: null,
  objectives: [],
  interests: [],
  ownsVehicle: null,
  ownsHome: null,
  uf: null,
  nudgeFrequency: 'normal',
  nudgeChannels: ['whatsapp', 'web'],
  questionsEnabled: true,
  memoryAuto: true,
};

/** Perfil do próprio usuário (padrões quando ainda não preencheu nada). */
export async function getProfile(
  tx: Tx,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
): Promise<FinancialProfileDTO> {
  const r = await tx
    .selectFrom('userFinancialProfiles')
    .selectAll()
    .where('workspaceId', '=', actor.workspaceId)
    .where('userId', '=', actor.userId)
    .executeTakeFirst();
  if (!r) return { ...PROFILE_DEFAULTS };
  return {
    lifeStage: r.lifeStage,
    dependents: r.dependents,
    incomeStability: r.incomeStability,
    riskSelf: r.riskSelf,
    objectives: r.objectives,
    interests: r.interests,
    ownsVehicle: r.ownsVehicle,
    ownsHome: r.ownsHome,
    uf: r.uf,
    nudgeFrequency: r.nudgeFrequency as FinancialProfileDTO['nudgeFrequency'],
    nudgeChannels: r.nudgeChannels,
    questionsEnabled: r.questionsEnabled,
    memoryAuto: r.memoryAuto,
  };
}

/** Grava só os campos do patch (userId sempre do ator). */
export async function upsertProfile(
  tx: Tx,
  actor: Pick<Actor, 'userId' | 'workspaceId'>,
  patch: ProfilePatch,
): Promise<FinancialProfileDTO> {
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as ProfilePatch;
  const extra = 'riskSelf' in fields ? { riskDeclaredAt: fields.riskSelf ? new Date() : null } : {};
  await tx
    .insertInto('userFinancialProfiles')
    .values({ ...fields, ...extra, workspaceId: actor.workspaceId, userId: actor.userId })
    .onConflict((oc) =>
      oc
        .columns(['workspaceId', 'userId'])
        .doUpdateSet(Object.keys(fields).length ? { ...fields, ...extra } : { updatedAt: new Date() }),
    )
    .execute();
  return getProfile(tx, actor);
}

/** Linhas do perfil para o prompt dinâmico (só o que está preenchido). */
export function profileForPrompt(p: FinancialProfileDTO): string[] {
  const out: string[] = [];
  if (p.lifeStage)
    out.push(`fase de vida: ${LIFE_STAGES[p.lifeStage as keyof typeof LIFE_STAGES] ?? p.lifeStage}`);
  if (p.dependents != null) out.push(`dependentes: ${p.dependents}`);
  if (p.incomeStability)
    out.push(
      `renda: ${INCOME_STABILITY[p.incomeStability as keyof typeof INCOME_STABILITY] ?? p.incomeStability}`,
    );
  if (p.riskSelf) out.push(`perfil de risco autodeclarado: ${p.riskSelf}`);
  if (p.objectives.length)
    out.push(
      `objetivos: ${p.objectives.map((o) => OBJECTIVES[o as keyof typeof OBJECTIVES] ?? o).join(', ')}`,
    );
  if (p.interests.length)
    out.push(`acompanha: ${p.interests.map((i) => INTERESTS[i as keyof typeof INTERESTS] ?? i).join(', ')}`);
  if (p.ownsVehicle != null) out.push(p.ownsVehicle ? 'tem veículo' : 'não tem veículo');
  if (p.ownsHome != null) out.push(p.ownsHome ? 'casa própria' : 'não tem casa própria');
  if (p.uf) out.push(`UF: ${p.uf}`);
  return out;
}
