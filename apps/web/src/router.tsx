import { useEffect } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { ApiError } from '@/lib/api';
import { useLiveUpdates } from '@/lib/live';
import { useMe } from '@/lib/queries';
import { useWorkspace, WorkspaceProvider } from '@/lib/workspace';
import { FiltersProvider } from '@/lib/filters';
import { ChatProvider } from '@/components/chat/chat-context';
import { AppShell } from '@/components/layout/app-shell';
import { Logo } from '@/components/layout/shell-parts';
import { ErrorState } from '@/components/common/states';
import { ConsentPage, InvitePage, LoginPage } from '@/pages/auth/auth-pages';
import { DashboardPage } from '@/pages/dashboard/dashboard-page';
import { ProjectionPage } from '@/pages/projection-page';
import { TransactionsPage } from '@/pages/transactions-page';
import { AccountsPage } from '@/pages/accounts-page';
import { PortfolioPage } from '@/pages/portfolio-page';
import { RecurrencesPage } from '@/pages/recurrences-page';
import { CalendarPage } from '@/pages/calendar-page';
import { GoalsPage } from '@/pages/goals-page';
import { PensionPage } from '@/pages/pension-page';
import { ImportsPage, ImportReviewPage } from '@/pages/imports-page';
import { SettingsPage } from '@/pages/settings-page';
import { MorePage } from '@/pages/more-page';
import { AssistantPage } from '@/pages/assistant-page';
import { OAuthAuthorizePage, type OAuthSearch } from '@/pages/auth/oauth-authorize-page';

const PUBLIC = ['/login', '/cadastro'];

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true" aria-label="Carregando">
      <div className="animate-pulse">
        <Logo />
      </div>
    </div>
  );
}

function LiveSync() {
  const { workspaceId } = useWorkspace();
  useLiveUpdates(workspaceId);
  return null;
}

const TITLES: Record<string, string> = {
  '/': 'Painel',
  '/projecao': 'Projeção',
  '/lancamentos': 'Lançamentos',
  '/contas': 'Contas e Cartões',
  '/carteira': 'Carteira',
  '/recorrencias': 'Recorrências',
  '/calendario': 'Calendário anual',
  '/metas': 'Metas e Orçamentos',
  '/previdencia': 'Previdência',
  '/importacoes': 'Importações',
  '/configuracoes': 'Configurações',
  '/assistente': 'Assistente',
  '/mais': 'Mais',
  '/chat': 'Chat',
  '/login': 'Entrar',
  '/cadastro': 'Criar conta',
  '/oauth/autorizar': 'Conectar assistente',
};

function Root() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const href = useRouterState({ select: (s) => s.location.href });
  const me = useMe();

  useEffect(() => {
    const base = TITLES[path] ?? (path.startsWith('/importacoes/') ? 'Revisar importação' : null);
    document.title = base ? `${base} · Saúde Financeira` : 'Saúde Financeira';
  }, [path]);

  const isPublic = PUBLIC.includes(path);
  if (me.isPending) return <Splash />;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      if (isPublic) return <Outlet />;
      return <Navigate to="/login" search={{ redirect: href === '/' ? undefined : href }} replace />;
    }
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (isPublic) return <Navigate to="/" replace />;
  if (!me.data.consented) return <ConsentPage />;
  // telas cheias, fora do shell do app
  if (path.startsWith('/convite/') || path === '/oauth/autorizar') return <Outlet />;

  return (
    <WorkspaceProvider me={me.data}>
      <LiveSync />
      <FiltersProvider>
        <ChatProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </ChatProvider>
      </FiltersProvider>
    </WorkspaceProvider>
  );
}

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">Página não encontrada</h1>
      <a href="/" className="mt-3 inline-block text-primary hover:underline">
        Voltar ao painel
      </a>
    </div>
  ),
});

type RedirectSearch = { redirect?: string };
const validateRedirect = (s: Record<string, unknown>): RedirectSearch => ({
  redirect: typeof s.redirect === 'string' ? s.redirect : undefined,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: validateRedirect,
  component: function Login() {
    const { redirect } = loginRoute.useSearch();
    return <LoginPage mode="login" redirect={redirect} />;
  },
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cadastro',
  validateSearch: validateRedirect,
  component: function Signup() {
    const { redirect } = signupRoute.useSearch();
    return <LoginPage mode="signup" redirect={redirect} />;
  },
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/convite/$token',
  component: function Invite() {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

const OAUTH_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
] as const;
const oauthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/autorizar',
  validateSearch: (s: Record<string, unknown>): OAuthSearch =>
    Object.fromEntries(OAUTH_KEYS.map((k) => [k, s[k] == null ? undefined : String(s[k])])),
  component: function OAuthAuthorize() {
    return <OAuthAuthorizePage search={oauthRoute.useSearch()} />;
  },
});

function page<const P extends string>(path: P, component: () => React.ReactNode) {
  return createRoute({ getParentRoute: () => rootRoute, path, component });
}

const importReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/importacoes/$draftId',
  component: function Review() {
    const { draftId } = importReviewRoute.useParams();
    return <ImportReviewPage draftId={draftId} />;
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  inviteRoute,
  oauthRoute,
  page('/', DashboardPage),
  page('/projecao', ProjectionPage),
  page('/lancamentos', TransactionsPage),
  page('/contas', AccountsPage),
  page('/carteira', PortfolioPage),
  page('/recorrencias', RecurrencesPage),
  page('/calendario', CalendarPage),
  page('/metas', GoalsPage),
  page('/previdencia', PensionPage),
  page('/importacoes', ImportsPage),
  importReviewRoute,
  page('/configuracoes', SettingsPage),
  page('/assistente', AssistantPage),
  page('/mais', MorePage),
  page('/chat', () => null),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
