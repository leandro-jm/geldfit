import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountDTO,
  CardDTO,
  CategoryDTO,
  CategorySpend,
  DashboardSummary,
  DraftDTO,
  EmergencyReserveDTO,
  InsightDTO,
  Me,
  MonthlyFlow,
  PensionDTO,
  PortfolioDTO,
  ProjectionDTO,
  RecurrenceDTO,
  SafeToSpendDTO,
  TransactionDTO,
  UpcomingItem,
} from '@sf/shared';
import { api, ApiError } from './api';
import { useWorkspace } from './workspace';
import type {
  AllocationTargetRow,
  AttachmentRow,
  AuditRow,
  BudgetRow,
  CommitResult,
  GoalRow,
  MembersResponse,
  SettingsResponse,
  StatementsResponse,
  TradeRow,
  WhatsAppResponse,
} from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status === 429) return count < 4;
        return !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;
      },
      retryDelay: (attempt, err) =>
        err instanceof ApiError && err.status === 429
          ? 5_000 * (attempt + 1)
          : Math.min(1000 * 2 ** attempt, 8000),
    },
  },
});

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: () => api<Me>('/api/me'), staleTime: 60_000 });
}

/** Query no escopo do workspace atual: a chave começa com ['ws', id] para invalidação em bloco. */
function useWsQuery<T>(
  path: string,
  extra: unknown[] = [],
  opts: { enabled?: boolean; refetchInterval?: number } = {},
) {
  const { workspaceId } = useWorkspace();
  return useQuery({
    queryKey: ['ws', workspaceId, path, ...extra],
    queryFn: ({ signal }) => api<T>(path, { signal }),
    enabled: Boolean(workspaceId) && opts.enabled !== false,
    refetchInterval: opts.refetchInterval,
    placeholderData: (prev) => prev,
  });
}

export const useSummary = () => useWsQuery<DashboardSummary>('/api/dashboard/summary');
export const useEmergencyReserve = () => useWsQuery<EmergencyReserveDTO>('/api/dashboard/emergency-reserve');
export const useSafeToSpend = () => useWsQuery<SafeToSpendDTO>('/api/dashboard/safe-to-spend');
export const useUpcoming = (days = 15) => useWsQuery<UpcomingItem[]>(`/api/dashboard/upcoming?days=${days}`);
export const useFlows = () => useWsQuery<MonthlyFlow[]>('/api/dashboard/flows');
export const useCategorySpend = () => useWsQuery<CategorySpend[]>('/api/dashboard/categories');
export const useProjection = (accountId?: string | null, months = 24) =>
  useWsQuery<ProjectionDTO>(`/api/projection?months=${months}${accountId ? `&account=${accountId}` : ''}`);
export const useAccounts = () => useWsQuery<AccountDTO[]>('/api/accounts');
export const useCards = () => useWsQuery<CardDTO[]>('/api/cards');
export const useCardStatements = (cardId: string | null) =>
  useWsQuery<StatementsResponse>(`/api/cards/${cardId}/statements`, [], { enabled: Boolean(cardId) });
export const useCategories = () => useWsQuery<CategoryDTO[]>('/api/categories');
export const useRecurrences = () => useWsQuery<RecurrenceDTO[]>('/api/recurrences');
export const usePension = () => useWsQuery<PensionDTO>('/api/pension');
export const usePortfolio = () => useWsQuery<PortfolioDTO>('/api/portfolio');
export const useTrades = () => useWsQuery<TradeRow[]>('/api/trades');
export const useAllocationTargets = () => useWsQuery<AllocationTargetRow[]>('/api/allocation-targets');
export const useInsights = () => useWsQuery<InsightDTO[]>('/api/insights');
export const useInsightMutes = () => useWsQuery<Array<{ rule: string }>>('/api/insights/mutes');
export const useBudgets = () => useWsQuery<BudgetRow[]>('/api/budgets');
export const useGoals = () => useWsQuery<GoalRow[]>('/api/goals');
export const useAudit = (limit = 20) => useWsQuery<AuditRow[]>(`/api/audit?limit=${limit}`);
export const useSettings = () => useWsQuery<SettingsResponse>('/api/settings');
export const useMembers = () => useWsQuery<MembersResponse>('/api/members');
export const useAttachments = () => useWsQuery<AttachmentRow[]>('/api/attachments');
export const usePendingDrafts = (kind?: string) =>
  useWsQuery<DraftDTO[]>(`/api/drafts?status=pending${kind ? `&kind=${kind}` : ''}`);
export const useWhatsApp = () => useWsQuery<WhatsAppResponse>('/api/channels/whatsapp');

export interface TxFilters {
  from?: string;
  to?: string;
  account?: string;
  card?: string;
  category?: string;
  q?: string;
  direction?: 'in' | 'out';
  status?: 'posted' | 'scheduled';
  limit?: number;
  offset?: number;
}

export function useTransactions(f: TxFilters) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f))
    if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return useWsQuery<{ items: TransactionDTO[]; total: number }>(`/api/transactions?${params.toString()}`);
}

/** Invalida todas as queries do workspace atual (após escrita ou evento em tempo real). */
export function useInvalidateWorkspace() {
  const qc = useQueryClient();
  const { workspaceId } = useWorkspace();
  return () => qc.invalidateQueries({ queryKey: ['ws', workspaceId] });
}

/** Ações explícitas das telas: POST /api/actions {kind, payload} (mesmo mecanismo de draft do agente). */
export function useAction() {
  const invalidate = useInvalidateWorkspace();
  return useMutation({
    mutationFn: (v: { kind: string; payload: unknown }) =>
      api<CommitResult>('/api/actions', { method: 'POST', body: v as Record<string, unknown> }),
    onSuccess: () => void invalidate(),
  });
}
