import {
  ArrowLeftRight,
  CalendarClock,
  CalendarDays,
  Download,
  Goal,
  LayoutDashboard,
  LineChart,
  PiggyBank,
  Settings,
  Wallet,
  Briefcase,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AppPath =
  | '/'
  | '/projecao'
  | '/lancamentos'
  | '/contas'
  | '/carteira'
  | '/recorrencias'
  | '/calendario'
  | '/metas'
  | '/configuracoes'
  | '/assistente'
  | '/previdencia'
  | '/importacoes'
  | '/mais'
  | '/chat';

export interface NavItem {
  to: AppPath;
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Painel', icon: LayoutDashboard },
  { to: '/projecao', label: 'Projeção', icon: LineChart },
  { to: '/lancamentos', label: 'Lançamentos', icon: ArrowLeftRight },
  { to: '/contas', label: 'Contas e Cartões', icon: Wallet },
  { to: '/carteira', label: 'Carteira', icon: Briefcase },
  { to: '/recorrencias', label: 'Recorrências', icon: CalendarClock },
  { to: '/metas', label: 'Metas e Orçamentos', icon: Goal },
  { to: '/assistente', label: 'Assistente', icon: Sparkles },
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
];

export const NAV_EXTRA: NavItem[] = [
  { to: '/calendario', label: 'Calendário anual', icon: CalendarDays },
  { to: '/previdencia', label: 'Previdência', icon: PiggyBank },
  { to: '/importacoes', label: 'Importações', icon: Download },
];
