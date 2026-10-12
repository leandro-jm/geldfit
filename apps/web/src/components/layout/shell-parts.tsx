import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Eye,
  EyeOff,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Settings,
  Sun,
  MessageCircle,
  LayoutDashboard,
  LineChart,
  ArrowLeftRight,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth';
import { api } from '@/lib/api';
import { useFilters } from '@/lib/filters';
import { usePrefs, type ThemePref } from '@/lib/prefs';
import { useAccounts, useMe, meKey } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, initials } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Tip,
} from '@/components/ui/menu';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { NAV, NAV_EXTRA, type NavItem } from './nav';
import { useChat } from '@/components/chat/chat-context';

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--primary)" />
        <path
          d="M8 20.5l5-5 4 3.5 7-8"
          fill="none"
          stroke="var(--primary-foreground)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="24" cy="11" r="2" fill="var(--primary-foreground)" />
      </svg>
      {compact ? null : (
        <span className="truncate text-[15px] font-semibold tracking-tight">Saúde Financeira</span>
      )}
    </span>
  );
}

function isActive(path: string, to: string): boolean {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}

function NavLink({ item, collapsed, path }: { item: NavItem; collapsed: boolean; path: string }) {
  const active = isActive(path, item.to);
  const link = (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        'group flex h-10 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        active &&
          'bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft hover:text-primary-soft-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <item.icon className="size-[18px] shrink-0" aria-hidden />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tip label={item.label} side="right">
      {link}
    </Tip>
  ) : (
    link
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  rail,
}: {
  collapsed: boolean;
  onToggle?: () => void;
  rail?: boolean;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <aside
      className={cn(
        'sticky top-0 flex h-dvh shrink-0 flex-col border-r bg-card transition-[width] duration-200',
        collapsed ? 'w-[72px]' : 'w-[var(--sidebar-w)]',
      )}
      data-testid="sidebar"
    >
      <div className={cn('flex h-16 items-center', collapsed ? 'justify-center' : 'px-4')}>
        <Link to="/" aria-label="Saúde Financeira — Painel">
          <Logo compact={collapsed} />
        </Link>
      </div>
      <nav
        aria-label="Navegação principal"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3 scrollbar-thin"
      >
        {NAV.map((item) => (
          <NavLink key={item.to} item={item} collapsed={collapsed} path={path} />
        ))}
        <div
          className={cn(
            'mb-1 mt-4 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
            collapsed && 'sr-only',
          )}
        >
          Mais
        </div>
        {NAV_EXTRA.map((item) => (
          <NavLink key={item.to} item={item} collapsed={collapsed} path={path} />
        ))}
      </nav>
      {!rail && onToggle ? (
        <div className={cn('border-t p-3', collapsed && 'flex justify-center')}>
          <Button
            variant="ghost"
            size={collapsed ? 'icon' : 'sm'}
            className={cn(!collapsed && 'w-full justify-start text-muted-foreground')}
            onClick={onToggle}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {collapsed ? <ChevronsRight aria-hidden /> : <ChevronsLeft aria-hidden />}
            {collapsed ? null : 'Recolher'}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceSwitcher({ compact }: { compact?: boolean }) {
  const { workspace, workspaces, setWorkspace } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const create = async () => {
    try {
      const r = await api<{ id: string }>('/api/workspaces', { method: 'POST', body: { name } });
      await qc.invalidateQueries({ queryKey: meKey });
      setWorkspace(r.id);
      setCreating(false);
      setName('');
      toast.success(`Workspace “${name}” criado.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível criar.');
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-10 min-w-0 items-center gap-2 rounded-[10px] px-2.5 text-left text-sm font-medium hover:bg-muted',
              compact ? 'max-w-[150px]' : 'max-w-[240px] border bg-card',
            )}
            aria-label={`Workspace: ${workspace?.name ?? ''}. Trocar workspace`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold">
              {initials(workspace?.name ?? '?')}
            </span>
            <span className="truncate">{workspace?.name}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem key={w.id} onSelect={() => setWorkspace(w.id)}>
              <span className="flex size-5 items-center justify-center">
                {w.id === workspace?.id ? <Check className="!text-primary" aria-hidden /> : null}
              </span>
              <span className="flex-1 truncate">{w.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {w.role === 'owner' ? 'dono' : w.role === 'member' ? 'membro' : 'leitura'}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setCreating(true)}>
            <Plus aria-hidden /> Novo workspace
          </MenuItem>
        </MenuContent>
      </Menu>
      <ResponsiveDialog
        open={creating}
        onOpenChange={setCreating}
        title="Novo workspace"
        description="Use workspaces separados para a casa, um negócio ou as finanças de outra pessoa."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim()}>
              Criar
            </Button>
          </>
        }
      >
        <Field label="Nome" htmlFor="ws-name">
          <Input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Casa"
            autoFocus
          />
        </Field>
      </ResponsiveDialog>
    </>
  );
}

export function AccountFilter() {
  const { accountId, setAccountId } = useFilters();
  const accounts = useAccounts();
  return (
    <div className="w-[200px]">
      <label htmlFor="global-account" className="sr-only">
        Filtrar por conta
      </label>
      <Select
        id="global-account"
        value={accountId ?? ''}
        onChange={(e) => setAccountId(e.target.value || null)}
        className="[&_select]:h-10"
      >
        <option value="">Todas as contas</option>
        {(accounts.data ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function PrivacyToggle() {
  const { privacy, togglePrivacy } = usePrefs();
  return (
    <Tip label={privacy ? 'Mostrar valores' : 'Ocultar valores'}>
      <Button
        variant="ghost"
        size="icon"
        aria-pressed={privacy}
        aria-label={privacy ? 'Mostrar valores' : 'Ocultar valores (modo privacidade)'}
        onClick={togglePrivacy}
      >
        {privacy ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </Tip>
  );
}

const THEMES: Array<{ value: ThemePref; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'Sistema', icon: Monitor },
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
];

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = usePrefs();
  return (
    <Menu>
      <Tip label="Tema">
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Alterar tema" data-testid="theme-toggle">
            {resolvedTheme === 'dark' ? <Moon aria-hidden /> : <Sun aria-hidden />}
          </Button>
        </MenuTrigger>
      </Tip>
      <MenuContent>
        <MenuLabel>Tema</MenuLabel>
        <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
          {THEMES.map((t) => (
            <MenuRadioItem key={t.value} value={t.value}>
              {t.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await authClient.signOut().catch(() => {});
    qc.clear();
    void navigate({ to: '/login' });
  };
}

export function AvatarMenu({ withTheme }: { withTheme?: boolean }) {
  const me = useMe();
  const signOut = useSignOut();
  const { theme, setTheme } = usePrefs();
  const user = me.data?.user;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="Menu da conta"
          className="flex size-10 items-center justify-center rounded-full hover:bg-muted"
        >
          {user?.image ? (
            <img src={user.image} alt="" className="size-8 rounded-full object-cover" />
          ) : (
            <span className="flex size-8 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
              {initials(user?.name ?? '?')}
            </span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <div className="px-2.5 py-2">
          <div className="truncate text-sm font-medium">{user?.name}</div>
          <div className="truncate text-[12px] text-muted-foreground">{user?.email}</div>
        </div>
        <MenuSeparator />
        {withTheme ? (
          <>
            <MenuLabel>Tema</MenuLabel>
            <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
              {THEMES.map((t) => (
                <MenuRadioItem key={t.value} value={t.value}>
                  {t.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem asChild>
          <Link to="/configuracoes">
            <Settings aria-hidden /> Configurações
          </Link>
        </MenuItem>
        <MenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden /> Sair
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function BottomTabs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const chat = useChat();
  const tabs = [
    { to: '/', label: 'Painel', icon: LayoutDashboard },
    { to: '/projecao', label: 'Projeção', icon: LineChart },
    null,
    { to: '/lancamentos', label: 'Lançamentos', icon: ArrowLeftRight },
    { to: '/mais', label: 'Mais', icon: MoreHorizontal },
  ];
  const moreActive =
    !['/', '/projecao', '/lancamentos', '/chat'].some((p) => isActive(path, p)) || path === '/mais';
  return (
    <nav
      aria-label="Navegação principal"
      data-testid="bottom-tabs"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-5 items-center">
        {tabs.map((t, i) =>
          t === null ? (
            <li key="chat" className="flex justify-center">
              <button
                type="button"
                onClick={() => chat.openChat()}
                aria-label="Abrir chat"
                className="-mt-6 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-pop ring-4 ring-background"
              >
                <MessageCircle className="size-6" aria-hidden />
              </button>
            </li>
          ) : (
            <li key={i}>
              <Link
                to={t.to}
                aria-current={(t.to === '/mais' ? moreActive : isActive(path, t.to)) ? 'page' : undefined}
                className="flex h-14 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium tracking-tight text-muted-foreground aria-[current=page]:text-primary"
              >
                <t.icon className="size-5" aria-hidden />
                <span className="max-w-full truncate">{t.label}</span>
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

/** Barra de chat fixa no rodapé das telas de dados (celular). Toque abre o chat em tela cheia. */
export function MobileChatBar() {
  const chat = useChat();
  return (
    <div className="fixed inset-x-0 z-30 px-3" style={{ bottom: 'calc(64px + var(--safe-bottom) + 8px)' }}>
      <button
        type="button"
        onClick={() => chat.openChat()}
        className="mx-auto flex h-12 w-full max-w-lg items-center gap-2 rounded-full border bg-card px-4 text-left text-[14px] text-muted-foreground shadow-pop"
        data-testid="mobile-chat-bar"
      >
        <MessageCircle className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">Pergunte ou lance algo…</span>
      </button>
    </div>
  );
}
