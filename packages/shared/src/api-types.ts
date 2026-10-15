/** Contratos de dados entre API e web. Valores em centavos (number), datas ISO (YYYY-MM-DD). */

import type { Currency } from './money.js';

export type Role = 'owner' | 'member' | 'viewer';

export interface Me {
  user: { id: string; name: string; email: string; image: string | null };
  workspaces: Array<{ id: string; name: string; role: Role; plan: string }>;
  consented: boolean;
  /** Recursos que dependem de configuração do servidor. */
  features?: { audio: boolean };
}

export interface AccountDTO {
  id: string;
  institution: string;
  type: 'checking' | 'savings' | 'investment' | 'cash';
  name: string;
  currency: Currency; // saldo inicial e lançamentos ficam nesta moeda
  openingBalanceCents: number;
  openingDate: string;
  isPrivate: boolean;
  ownerUserId: string | null;
  balanceCents: number; // na moeda da conta
  balanceBrlCents: number; // em reais (conta em dólar convertida pela PTAX)
  fx: { rate: number; date: string } | null; // PTAX usada na conversão (só contas em dólar)
  lastActivityDate: string | null;
  stale: boolean; // sem lançamento há mais de 30 dias
  archivedAt: string | null;
}

export interface CardDTO {
  id: string;
  name: string;
  accountId: string | null;
  last4: string | null;
  holderTag: string | null;
  limitCents: number;
  closingDay: number;
  dueDay: number;
  isPrivate: boolean;
  usedCents: number; // limite comprometido (faturas abertas + parcelas futuras)
  currentStatement: StatementDTO | null;
}

export interface StatementDTO {
  id: string;
  cardId: string;
  refMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  reportedTotalCents: number | null;
  status: 'open' | 'closed' | 'paid';
}

export interface CategoryDTO {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  parentId: string | null;
  icon: string | null;
  color: string | null;
}

export interface TransactionDTO {
  id: string;
  accountId: string | null;
  cardId: string | null;
  date: string;
  amountCents: number; // na moeda da conta
  amountBrlCents: number; // em reais (PTAX da data do lançamento, se a conta for em dólar)
  currency: Currency; // moeda da conta (cartão é sempre BRL)
  direction: 'in' | 'out';
  kind: 'regular' | 'transfer' | 'card_payment';
  categoryId: string | null;
  categoryName: string | null;
  description: string;
  status: 'posted' | 'scheduled';
  source: string;
  installmentN: number | null;
  installmentTotal: number | null;
  installmentGroupId: string | null;
  transferId: string | null;
  recurrenceId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RecurrenceDTO {
  id: string;
  accountId: string | null;
  cardId: string | null;
  description: string;
  amountCents: number;
  direction: 'in' | 'out';
  categoryId: string | null;
  rule: string;
  ruleText: string;
  startDate: string;
  endDate: string | null;
  amountMode: 'fixed' | 'average_n_months';
  autoPost: boolean;
  isBill: boolean;
  nextDate: string | null;
  pausedAt: string | null;
}

export interface ProjectionMonth {
  month: string;
  openingCents: number;
  incomeCents: number;
  expenseCents: number;
  cardBillsCents: number;
  variableCents: number;
  goalsCents: number;
  closingCents: number;
  closingOptimisticCents: number;
  closingPessimisticCents: number;
  belowFloor: boolean;
}

export interface ProjectionDTO {
  months: ProjectionMonth[];
  floorCents: number;
  firstBelowFloor: string | null;
  minClosing: { month: string; cents: number } | null;
  computedAt: string;
}

/** Conta que fica negativa (cheque especial) nos próximos dias, com a sugestão de cobertura. */
export interface AccountShortfall {
  accountId: string;
  accountName: string;
  /** Primeiro dia em que o saldo fica negativo. */
  date: string;
  balanceCents: number;
  /** Pior saldo no horizonte (a transferência sugerida cobre este valor). */
  minCents: number;
  cause: { description: string; amountCents: number } | null;
  suggestion: { fromAccountId: string; fromAccountName: string; amountCents: number; date: string } | null;
}

/** "Quanto posso gastar": folga sobre o piso nos 24 meses + ritmo do dia a dia no mês. */
export interface SafeToSpendDTO {
  /** Gasto extra que cabe hoje sem nenhum mês fechar abaixo do piso. */
  extraCents: number;
  /** A mesma folga no cenário pessimista. */
  conservativeExtraCents: number;
  /** Quanto falta para voltar ao piso quando a projeção já fura (0 se não fura). */
  deficitCents: number;
  /** Mês de menor saldo, que limita a folga. */
  limitingMonth: string | null;
  floorCents: number;
  firstBelowFloor: string | null;
  /** Gasto do dia a dia ainda previsto até o fim do mês e o ritmo diário equivalente. */
  monthVariableLeftCents: number;
  dailyCents: number;
  daysLeft: number;
  status: 'ok' | 'tight' | 'over';
  shortfalls: AccountShortfall[];
  computedAt: string;
}

/**
 * Reserva de emergência no cenário de desligamento: os salários param, as demais receitas
 * continuam, aportes e metas param, e contas, faturas, parcelas e o dia a dia seguem a projeção.
 */
export interface EmergencyReserveDTO {
  reserveCents: number;
  breakdown: {
    /** Saldo das contas correntes, poupança e dinheiro. */
    accountsCents: number;
    /** Contas de investimento e ativos com liquidez diária. */
    investmentsCents: number;
  };
  /** Meses cobertos a partir de hoje (fração); null quando dura os 24 meses da projeção. */
  months: number | null;
  /** Mês em que a reserva acaba (null se dura os 24 meses). */
  runsOutMonth: string | null;
  /** Custo médio mensal nos próximos 12 meses e as receitas que continuam sem o salário. */
  monthlyCostCents: number;
  otherIncomeCents: number;
  /** Salários considerados (param no desligamento), valor mensal. */
  salaries: Array<{ description: string; amountCents: number }>;
  targetMonths: number;
  status: 'ok' | 'low' | 'critical';
  /** Saldo da reserva no fim de cada mês do cenário. */
  timeline: Array<{ month: string; balanceCents: number }>;
}

export interface UpcomingItem {
  kind: 'bill' | 'statement' | 'recurrence' | 'scheduled';
  id: string;
  date: string;
  description: string;
  amountCents: number;
  direction: 'in' | 'out';
  accountName: string | null;
  accountId: string | null; // conta da conta agendada, ou conta que paga a fatura
  cardId: string | null; // cartão (faturas)
  canMarkPaid: boolean;
}

export interface DashboardSummary {
  asOf: string;
  netWorthCents: number;
  accountsBalanceCents: number;
  openBillsCents: number;
  investmentsCents: number;
  pensionCents: number;
  minProjected: { month: string; cents: number } | null;
  previousMonth: { netWorthCents: number; accountsBalanceCents: number; openBillsCents: number } | null;
  lastUpdate: string | null;
  staleAccounts: Array<{ id: string; name: string; lastActivityDate: string | null }>;
  alert: { kind: 'below_floor'; month: string; cents: number } | null;
}

export interface MonthlyFlow {
  month: string;
  incomeCents: number;
  expenseCents: number;
  projected: boolean;
}

export interface CategorySpend {
  categoryId: string | null;
  name: string;
  currentCents: number;
  averageCents: number;
  budgetCents: number | null;
}

export interface PositionDTO {
  assetId: string;
  ticker: string | null;
  name: string;
  kind: string;
  assetClass: AssetClass;
  currency: 'BRL' | 'USD';
  qty: number;
  avgPriceCents: number;
  investedCents: number;
  marketValueCents: number;
  priceDate: string | null;
  weightPct: number;
  pnlCents: number;
}

export type AssetClass = 'fixed_income' | 'equities' | 'funds' | 'usd' | 'pension' | 'cash' | 'crypto';

export interface PortfolioDTO {
  totalCents: number;
  positions: PositionDTO[];
  byClass: Array<{
    assetClass: AssetClass;
    valueCents: number;
    pct: number;
    targetPct: number | null;
    minPct: number | null;
    maxPct: number | null;
  }>;
  usd: {
    pct: number;
    minPct: number | null;
    maxPct: number | null;
    avgRate: number | null;
    ptax: number | null;
    ptaxDate: string | null;
  };
  performance: Array<{
    period: 'month' | '12m' | 'inception';
    portfolioPct: number | null;
    cdiPct: number | null;
    ibovPct: number | null;
    ipcaPct: number | null;
  }>;
}

export interface InsightDTO {
  id: string;
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PensionDTO {
  plans: Array<{
    id: string;
    provider: string;
    name: string;
    entries: Array<{
      refMonth: string;
      balanceCents: number;
      participantCents: number;
      sponsorCents: number;
      attachmentId: string | null;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface DraftPreview {
  title: string;
  summary: string;
  lines: Array<{ label: string; value: string; tone?: 'positive' | 'negative' | 'muted' | 'warning' }>;
  items?: Array<{
    date: string;
    description: string;
    amountCents: number;
    currency?: Currency; // padrão BRL
    direction: 'in' | 'out';
    category?: string | null;
    duplicate?: boolean;
    lowConfidence?: boolean;
    note?: string;
  }>;
  totals?: {
    count: number;
    amountCents: number;
    currency?: Currency | null; // null: itens em moedas diferentes (sem total)
    duplicates: number;
    lowConfidence: number;
  };
  warnings: string[];
  projectionImpact?: string | null;
}

export interface DraftDTO {
  id: string;
  kind: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed';
  preview: DraftPreview;
  expiresAt: string;
}

export interface ChatMessageDTO {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachments?: Array<{ id: string; filename: string; mime: string }>;
  drafts?: DraftDTO[];
}

/** Eventos SSE do endpoint de chat */
export type ChatStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'text_delta'; text: string }
  /** Substitui o texto já transmitido (ex.: resposta reescrita pelo filtro de conformidade). */
  | { type: 'text_replace'; text: string }
  | { type: 'confirmed'; draftId: string; summary: string; impact: string | null }
  | { type: 'tool'; name: string; status: 'start' | 'end' }
  | { type: 'draft'; draft: DraftDTO }
  | { type: 'message_end'; messageId: string }
  | { type: 'error'; message: string };

/** Eventos SSE do endpoint global /events */
export type LiveEvent = { type: 'data_changed'; workspaceId: string; table: string } | { type: 'ping' };

export interface PageContext {
  panel: string;
  detail?: string;
}
