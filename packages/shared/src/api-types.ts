/** Contratos de dados entre API e web. Valores em centavos (number), datas ISO (YYYY-MM-DD). */

import type { Currency } from './money.js';
import type { HistoricalReturn, RetirementParams, RetirementPlan } from './retirement-math.js';

export type Role = 'owner' | 'member' | 'viewer';

export interface Me {
  user: { id: string; name: string; email: string; image: string | null; emailVerified?: boolean };
  workspaces: Array<{ id: string; name: string; role: Role; plan: string }>;
  consented: boolean;
  /** Recursos que dependem de configuração do servidor. */
  features?: { audio: boolean; voice?: boolean; voiceProvider?: 'realtime' | 'live' };
  /** Pode editar as configurações globais (ADMIN_EMAILS). */
  isAdmin?: boolean;
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
  /** Itens do calendário no mês (só com `withSeasonal`); os confirmados já estão nas entradas/saídas. */
  seasonal?: SeasonalOccurrenceDTO[];
}

export type SeasonalKind = 'expense' | 'income' | 'adjustment' | 'info';
export type SeasonalStatus = 'suggested' | 'confirmed' | 'dismissed';
export type SeasonalConfidence = 'alta' | 'media' | 'estimado';

/** Uma parcela da agenda anual (mês/dia do pagamento e valor). */
export interface SeasonalScheduleEntry {
  month: number;
  day: number;
  amountCents: number;
}

/** O que foi pago numa temporada passada (base da sugestão). */
export interface SeasonalEvidence {
  year: number;
  totalCents: number;
  months: number[];
  n: number;
}

export interface SeasonalItemDTO {
  id: string;
  key: string;
  label: string;
  kind: SeasonalKind;
  direction: 'in' | 'out' | null;
  categoryId: string | null;
  categoryName: string | null;
  schedule: SeasonalScheduleEntry[];
  adjustmentPct: number | null;
  leadDays: number;
  confidence: SeasonalConfidence;
  evidence: SeasonalEvidence[];
  status: SeasonalStatus;
  source: 'detected' | 'manual';
}

/** Ocorrência futura (ou do mês corrente) de um item do calendário. */
export interface SeasonalOccurrenceDTO {
  itemId: string;
  key: string;
  label: string;
  kind: SeasonalKind;
  direction: 'in' | 'out' | null;
  date: string;
  /** Ano da temporada (IPVA de dez/2025–fev/2026 é a temporada 2026). */
  season: number;
  /** Valor da parcela; nos reajustes, o acréscimo mensal. */
  amountCents: number;
  status: SeasonalStatus;
  confidence: SeasonalConfidence;
  paid: boolean;
  /** Confirmado e ainda não pago: já conta na projeção. */
  inProjection: boolean;
  installment: { n: number; total: number } | null;
}

export interface CalendarDTO {
  items: SeasonalItemDTO[];
  occurrences: SeasonalOccurrenceDTO[];
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

export type CommitmentLevel = 'ok' | 'atencao' | 'alto';

/** Item que compromete a renda num mês: um grupo de parcelas ou uma recorrência com fim. */
export interface CommitmentItem {
  label: string;
  cents: number;
  kind: 'card' | 'carne' | 'financing';
  /** Parcela atual e total (null em recorrência). */
  n: number | null;
  total: number | null;
  /** Última parcela (ou último mês da recorrência) cai neste mês. */
  endsThisMonth: boolean;
}

export interface CommitmentMonth {
  month: string;
  /** Renda recorrente do mês (recebida ou prevista). */
  incomeCents: number;
  /** Parcelas (cartão pelo vencimento da fatura, carnê pela data) e recorrências com fim. */
  committedCents: number;
  /** Fração da renda (0,38 = 38%); null sem renda recorrente no mês. */
  pct: number | null;
  level: CommitmentLevel;
  /** Maiores itens do mês (até 5). */
  items: CommitmentItem[];
}

/**
 * Renda futura comprometida com parcelas: quanto da renda recorrente de cada mês já está
 * reservado para parcelas e financiamentos.
 */
export interface CommitmentDTO {
  months: CommitmentMonth[];
  /** Referência de alerta (fração). */
  threshold: number;
  peak: { month: string; pct: number } | null;
  /** Itens cuja última parcela cai no horizonte, em ordem de mês. */
  releases: Array<{ month: string; label: string; cents: number }>;
}

/** Gráfico anexado a uma resposta do assistente (web desenha; WhatsApp vira texto). */
export type ChatVisual = {
  type: 'commitment';
  title: string;
  threshold: number;
  months: Array<{
    month: string;
    pct: number | null;
    committedCents: number;
    incomeCents: number;
    /** Parte do comprometido que vem da compra avaliada (comparação antes × depois). */
    addedCents?: number;
  }>;
};

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

/** Fato que o agente lembra sobre o usuário ("O que sei sobre você"). */
export interface MemoryDTO {
  id: string;
  scope: 'personal' | 'household';
  category: string;
  key: string;
  content: string;
  sensitive: boolean;
  status: 'active' | 'pending' | 'archived' | 'rejected';
  source: 'chat' | 'question' | 'manual' | 'tool';
  importance: number;
  pinned: boolean;
  expiresAt: string | null;
  /** Memória de outro membro do workspace (scope household): só leitura. */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialProfileDTO {
  lifeStage: string | null;
  dependents: number | null;
  incomeStability: string | null;
  riskSelf: string | null;
  objectives: string[];
  interests: string[];
  ownsVehicle: boolean | null;
  ownsHome: boolean | null;
  uf: string | null;
  nudgeFrequency: 'off' | 'baixa' | 'normal' | 'alta';
  nudgeChannels: string[];
  questionsEnabled: boolean;
  memoryAuto: boolean;
}

/** Sugestão ou pergunta proativa do assistente (caixa do assistente e WhatsApp). */
export interface NudgeDTO {
  id: string;
  kind: string;
  type: 'nudge' | 'question';
  category: string;
  title: string;
  message: string;
  priority: number;
  options: Array<{ id: string; label: string }>;
  /** Tem ação de um toque (prévia para confirmar). */
  hasDraft: boolean;
  draftId: string | null;
  status:
    | 'candidate'
    | 'scheduled'
    | 'delivered'
    | 'accepted'
    | 'dismissed'
    | 'snoozed'
    | 'answered'
    | 'expired'
    | 'superseded';
  deliveredAt: string | null;
  deliveredChannel: 'whatsapp' | 'web' | null;
  respondedAt: string | null;
  /** Resposta registrada (opção escolhida ou texto). */
  responseLabel: string | null;
  createdAt: string;
}

/** Resultado de responder a uma sugestão: texto para o usuário e, se houver, a prévia criada. */
export interface NudgeAnswerDTO {
  reply: string;
  draft: DraftDTO | null;
  /** Abre o chat com este texto (resposta livre, ex.: valor e prazo de uma meta). */
  chatPrompt: string | null;
}

export interface AgentUsageDTO {
  proactive: 'off' | 'deterministic' | 'full';
  weekUsd: number;
  weekLimitUsd: number;
  byPurpose: Array<{ purpose: string; calls: number; usd: number }>;
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

/** Premissas de aposentadoria do usuário. Taxas reais em fração ao ano (0.04 = 4% a.a.). */
export interface RetirementProfileDTO {
  birthDate: string;
  retireAge: number;
  endAge: number;
  accumulationRate: number;
  withdrawalRate: number;
  contributionGrowth: number;
  inssMonthlyCents: number | null;
  targetIncomeCents: number | null;
  includeInvestments: boolean;
}

/** Dados de hoje que alimentam o cenário (a web recalcula localmente a partir deles). */
export interface RetirementBaselineDTO {
  plans: Array<{ id: string; provider: string; name: string; balanceCents: number; refMonth: string }>;
  pensionBalanceCents: number;
  /** Mês do extrato mais recente; null sem extratos. */
  balanceAsOf: string | null;
  /** Primeiro mês simulado. */
  startMonth: string;
  monthlyContributionCents: number;
  contributionMonths: number;
  /** Carteira + contas de investimento, mesmo quando não entram no cenário. */
  otherAssetsCents: number;
  monthlyExpenseCents: number;
  expenseSource: 'projection_12m' | 'history_6m' | 'none';
  historical: HistoricalReturn | null;
  warnings: string[];
}

export interface RetirementScenarioDTO {
  profile: RetirementProfileDTO | null;
  /** Premissas efetivas (perfil + ajustes da pergunta + padrões); birthDate null se ninguém informou. */
  assumptions: Omit<RetirementProfileDTO, 'birthDate'> & {
    birthDate: string | null;
    retireYear: number | null;
  };
  baseline: RetirementBaselineDTO;
  needSource: RetirementBaselineDTO['expenseSource'] | 'target';
  params: RetirementParams | null;
  plan: RetirementPlan | null;
  missing: Array<'birth_date'>;
  warnings: string[];
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
  visuals?: ChatVisual[];
  /** Turno falado na conversa por voz (transcrição). */
  voice?: boolean;
  /** Canal da conversa (o histórico unificado junta web e WhatsApp). */
  channel?: 'web' | 'whatsapp';
  /** Mensagem que o assistente mandou por conta própria (lembrete, sugestão ou pergunta). */
  proactive?: boolean;
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
  | { type: 'visual'; visual: ChatVisual }
  | { type: 'message_end'; messageId: string }
  | { type: 'error'; message: string };

interface VoiceSessionBase {
  conversationId: string;
  /** Tempo máximo desta conversa (respeita o saldo diário do plano). */
  maxSeconds: number;
  /** Primeiro nome do usuário logado (para o cumprimento inicial). */
  userFirstName: string;
  model: string;
}

/**
 * Sessão de conversa por voz via WebRTC.
 * - `realtime`: o navegador recebe um segredo efêmero e troca o SDP direto com a OpenAI.
 * - `live`: o servidor cria a sessão GPT-Live com a oferta do navegador e devolve a resposta SDP.
 */
export type VoiceSessionDTO =
  | (VoiceSessionBase & {
      provider: 'realtime';
      clientSecret: string;
      expiresAt: number;
      /** Endpoint da troca de SDP (WebRTC) no provedor. */
      callsUrl: string;
    })
  | (VoiceSessionBase & { provider: 'live'; sessionId: string; answerSdp: string });

/** Resultado de uma ferramenta chamada pelo modelo de voz. `output` volta para o modelo. */
export interface VoiceToolResponse {
  output: string;
  isError: boolean;
  drafts: DraftDTO[];
  visuals: ChatVisual[];
  confirmed: Array<{ draftId: string; summary: string; impact: string | null }>;
  cancelled: string[];
}

/** Eventos SSE do endpoint global /events */
export type LiveEvent = { type: 'data_changed'; workspaceId: string; table: string } | { type: 'ping' };

export interface PageContext {
  panel: string;
  detail?: string;
}
