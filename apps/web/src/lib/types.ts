/** Tipos de respostas da API que não estão em @sf/shared (rotas que devolvem linhas do banco). */
import type { Role, StatementDTO } from '@sf/shared';

export interface SettingsResponse {
  workspace: { name: string; plan: string };
  settings: {
    workspaceId: string;
    timezone: string;
    balanceFloorCents: number;
    variableWindowMonths: number;
    variableMonthlyCents: number;
    optimisticFactor: number;
    pessimisticFactor: number;
    quietStart: string;
    quietEnd: string;
    reminderTime: string;
    emergencyMonthsTarget: number;
    usdMinPct: number | null;
    usdMaxPct: number | null;
    updatedAt: string;
  };
  reminderPrefs: Array<{ kind: string; enabled: boolean }>;
  role: Role;
}

export interface MembersResponse {
  members: Array<{
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: Role;
    createdAt: string;
  }>;
  invites: Array<{
    id: string;
    email: string;
    role: 'member' | 'viewer';
    expiresAt: string;
    acceptedAt: string | null;
  }>;
}

export interface TradeRow {
  id: string;
  date: string;
  kind: string;
  qty: number;
  priceCents: number;
  feesCents: number;
  totalCents: number;
  fxRate: number | null;
  broker: string | null;
  ticker: string | null;
  name: string;
  assetKind: string;
  currency: 'BRL' | 'USD';
}

export interface GoalRow {
  id: string;
  name: string;
  kind: 'emergency' | 'travel' | 'purchase' | 'other';
  targetCents: number;
  savedCents: number;
  monthlyContributionCents: number;
  startMonth: string;
  targetDate: string | null;
  status: 'active' | 'done' | 'cancelled';
  createdAt: string;
}

export interface BudgetRow {
  id: string;
  categoryId: string;
  name: string;
  amountCents: number;
  alertPct: number;
}

export interface AllocationTargetRow {
  workspaceId: string;
  assetClass: string;
  targetPct: number;
  minPct: number | null;
  maxPct: number | null;
}

export interface AttachmentRow {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  docType: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface UploadResult {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  duplicate: boolean;
  status: string;
}

export interface WhatsAppResponse {
  enabled: boolean;
  channels: Array<{
    id: string;
    address: string;
    verifiedAt: string | null;
    defaultWorkspaceId: string | null;
    codeExpiresAt: string | null;
  }>;
}

export interface StatementsResponse {
  statements: StatementDTO[];
  items: Array<{
    id: string;
    date: string;
    description: string;
    amountCents: number;
    direction: 'in' | 'out';
    installmentN: number | null;
    installmentTotal: number | null;
    cardStatementId: string | null;
    status: string;
  }>;
}

export interface AuditRow {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  at: string;
  undoneAt: string | null;
  actorName: string | null;
}

export interface CommitResult {
  summary: string;
  impact: string | null;
  ids: string[];
}

export interface DraftWithPayload {
  id: string;
  kind: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed';
  preview: import('@sf/shared').DraftPreview;
  expiresAt: string;
  payload: unknown;
}

export interface ImportPayload {
  attachmentId: string;
  items: Array<{
    accountId?: string | null;
    cardId?: string | null;
    date: string;
    amountCents: number;
    direction: 'in' | 'out';
    categoryId?: string | null;
    description: string;
    installments?: number;
    installmentStart?: number;
    attachmentId?: string | null;
    confidence?: number | null;
    status?: 'posted' | 'scheduled';
    duplicate?: boolean;
  }>;
  skipDuplicates: boolean;
  statement?: { cardId: string; refMonth: string; reportedTotalCents: number } | null;
}
