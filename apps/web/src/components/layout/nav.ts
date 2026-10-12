import {
  ArrowLeftRight,
  CalendarClock,
  Download,
  Goal,
  LayoutDashboard,
  LineChart,
  PiggyBank,
  Settings,
  Wallet,
  Briefcase,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AppPath =
  | '/'
  | '/projecao'
  | '/lancamentos'
  | '/contas'
  | '/carteira'
  | '/recorrencias'
  | '/metas'
  | '/configuracoes'
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
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
];

export const NAV_EXTRA: NavItem[] = [
  { to: '/previdencia', label: 'Previdência', icon: PiggyBank },
  { to: '/importacoes', label: 'Importações', icon: Download },
];
