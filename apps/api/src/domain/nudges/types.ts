import type {
  CalendarDTO,
  CategorySpend,
  CommitmentDTO,
  DraftPreview,
  EmergencyReserveDTO,
  FinancialProfileDTO,
  GoalPlan,
  MemoryDTO,
  ProjectionDTO,
} from '@sf/shared';
import type { ProfilePatch } from '../profile.js';

/** Ação de um toque: vira draft (prévia para confirmar), igual às ferramentas do agente. */
export interface DraftSpec {
  kind: string;
  payload: unknown;
  preview: DraftPreview;
}

/** O que acontece quando o usuário escolhe uma opção de uma pergunta. */
export type OptionAction =
  | { type: 'draft'; draft: DraftSpec; reply?: string }
  | { type: 'profile'; patch: ProfilePatch; reply: string }
  | { type: 'memory_create'; category: string; content: string; expiresAt?: string | null; reply: string }
  | { type: 'memory_archive'; memoryId: string; reply: string }
  | { type: 'memory_touch'; memoryId: string; reply: string }
  | { type: 'memory_extend'; memoryId: string; days: number; reply: string }
  /** Resposta livre: o assistente pergunta o detalhe e o próximo texto vai para o LLM. */
  | { type: 'chat'; reply: string; prompt: string }
  | { type: 'snooze'; days: number; reply: string }
  | { type: 'dismiss'; reply: string }
  | { type: 'mute'; reply: string };

export interface NudgeOption {
  id: string;
  label: string;
  action: OptionAction;
}

/** Candidato produzido por um detector: números determinísticos e texto pronto. */
export interface Candidate {
  kind: string;
  type: 'nudge' | 'question';
  category: string;
  fingerprint: string;
  priority: number;
  title: string;
  message: string;
  facts: Record<string, unknown>;
  options?: NudgeOption[];
  draft?: DraftSpec;
  /** Dias até o candidato perder o sentido (default 14). */
  ttlDays?: number;
}

export interface GoalWithPlan {
  id: string;
  name: string;
  kind: 'emergency' | 'travel' | 'purchase' | 'other';
  targetCents: number;
  savedCents: number;
  monthlyContributionCents: number;
  startMonth: string;
  targetDate: string | null;
  plan: GoalPlan;
}

/** Tudo que os detectores leem de uma vez por usuário (sem novas consultas dentro deles). */
export interface NudgeCtx {
  today: string;
  role: 'owner' | 'member' | 'viewer';
  profile: FinancialProfileDTO;
  memories: MemoryDTO[];
  goals: GoalWithPlan[];
  emergencyMonthsTarget: number;
  projection: ProjectionDTO | null;
  reserve: EmergencyReserveDTO | null;
  commitment: CommitmentDTO | null;
  categories: CategorySpend[];
  calendar: CalendarDTO | null;
  insights: Array<{ id: string; title: string; message: string; severity: string; rule: string }>;
}
