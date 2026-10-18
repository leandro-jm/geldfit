import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { MessageCircle, PanelRightClose, X } from 'lucide-react';
import { useBreakpoint } from '@/lib/media';
import { readStorage, writeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SideSheet } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/menu';
import { ChatView } from '@/components/chat/chat-view';
import { useChat } from '@/components/chat/chat-context';
import {
  AccountFilter,
  AvatarMenu,
  BottomTabs,
  Logo,
  MobileChatBar,
  PrivacyToggle,
  Sidebar,
  ThemeToggle,
  WorkspaceSwitcher,
} from './shell-parts';
import { AssistantBell } from '@/components/agent/nudge-card';

const CHAT_MIN = 340;
const CHAT_MAX = 640;

function readNum(key: string, fallback: number): number {
  const v = Number(readStorage(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function AppShell({ children }: { children: ReactNode }) {
  const bp = useBreakpoint();
  const chat = useChat();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const v = readStorage('sf.sidebar');
    return v ? v === 'collapsed' : window.innerWidth < 1400;
  });
  const [chatOpen, setChatOpen] = useState(() => readStorage('sf.chat') !== 'closed');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(() =>
    Math.min(CHAT_MAX, Math.max(CHAT_MIN, readNum('sf.chatWidth', 400))),
  );
  const isChatRoute = path === '/chat';

  // como "abrir o chat" funciona depende do tamanho de tela
  useEffect(() => {
    chat.registerOpener(() => {
      if (bp === 'desktop') {
        setChatOpen(true);
        writeStorage('sf.chat', null);
      } else if (bp === 'tablet') setDrawerOpen(true);
      else if (!isChatRoute) void navigate({ to: '/chat' });
    });
  }, [bp, chat, navigate, isChatRoute]);

  // chat em tela cheia só faz sentido no celular
  useEffect(() => {
    if (isChatRoute && bp !== 'phone') {
      if (bp === 'desktop') setChatOpen(true);
      else setDrawerOpen(true);
      void navigate({ to: '/', replace: true });
    }
  }, [isChatRoute, bp, navigate]);

  // clique numa notificação push com o app aberto → navega (ver src/sw.ts)
  useEffect(() => {
    const onMsg = (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type === 'navigate' && e.data.url) void navigate({ href: e.data.url });
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [navigate]);

  const toggleSidebar = () => {
    setSidebarCollapsed((c) => {
      writeStorage('sf.sidebar', c ? 'expanded' : 'collapsed');
      return !c;
    });
  };
  const closeChat = () => {
    setChatOpen(false);
    writeStorage('sf.chat', 'closed');
  };

  // redimensionamento do painel do chat
  const dragging = useRef(false);
  const onResizeStart = useCallback((e: RPointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onResizeMove = useCallback((e: RPointerEvent) => {
    if (!dragging.current) return;
    const w = Math.min(CHAT_MAX, Math.max(CHAT_MIN, window.innerWidth - e.clientX));
    setChatWidth(w);
  }, []);
  const onResizeEnd = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setChatWidth((w) => {
      writeStorage('sf.chatWidth', String(Math.round(w)));
      return w;
    });
  }, []);

  if (bp === 'phone') {
    if (isChatRoute) {
      return <MobileChatScreen />;
    }
    return (
      <div className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2"
        >
          Pular para o conteúdo
        </a>
        <header
          className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b bg-background/90 px-3 backdrop-blur"
          style={{ paddingTop: 'var(--safe-top)' }}
        >
          <Link to="/" aria-label="Painel" className="mr-1">
            <Logo compact />
          </Link>
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher compact />
          </div>
          <AssistantBell />
          <PrivacyToggle />
          <AvatarMenu withTheme />
        </header>
        <main id="main" className="@container px-4 pb-[calc(140px+var(--safe-bottom))] pt-4">
          {children}
        </main>
        <MobileChatBar />
        <BottomTabs />
      </div>
    );
  }

  const tablet = bp === 'tablet';
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2"
      >
        Pular para o conteúdo
      </a>
      <Sidebar collapsed={tablet || sidebarCollapsed} rail={tablet} onToggle={toggleSidebar} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur lg:px-6">
          <WorkspaceSwitcher />
          <div className="hidden xl:block">
            <AccountFilter />
          </div>
          <div className="flex-1" />
          <AssistantBell />
          <PrivacyToggle />
          <ThemeToggle />
          {bp === 'desktop' && !chatOpen ? (
            <Tip label="Abrir chat">
              <Button variant="ghost" size="icon" aria-label="Abrir chat" onClick={() => chat.openChat()}>
                <MessageCircle aria-hidden />
              </Button>
            </Tip>
          ) : null}
          <AvatarMenu />
        </header>
        <main
          id="main"
          className="@container mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-5 lg:px-6 lg:pt-6"
        >
          {children}
        </main>
      </div>

      {bp === 'desktop' ? (
        chatOpen ? (
          <aside
            aria-label="Chat"
            className="sticky top-0 flex h-dvh shrink-0 border-l bg-card"
            style={{ width: chatWidth }}
            data-testid="chat-panel"
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar chat"
              aria-valuemin={CHAT_MIN}
              aria-valuemax={CHAT_MAX}
              aria-valuenow={Math.round(chatWidth)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setChatWidth((w) => Math.min(CHAT_MAX, w + 20));
                if (e.key === 'ArrowRight') setChatWidth((w) => Math.max(CHAT_MIN, w - 20));
              }}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              className="group absolute -left-1.5 top-0 z-10 h-full w-3 cursor-col-resize"
              style={{ position: 'absolute' }}
            >
              <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary" />
            </div>
            <ChatView
              className="w-full"
              headerActions={
                <Tip label="Recolher chat">
                  <Button variant="ghost" size="icon-sm" aria-label="Recolher chat" onClick={closeChat}>
                    <PanelRightClose aria-hidden />
                  </Button>
                </Tip>
              }
            />
          </aside>
        ) : (
          <FloatingChatButton onClick={() => chat.openChat()} />
        )
      ) : (
        <>
          <FloatingChatButton onClick={() => setDrawerOpen(true)} />
          <SideSheet open={drawerOpen} onOpenChange={setDrawerOpen} title="Chat" width={420}>
            <ChatView
              headerActions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Fechar chat"
                  onClick={() => setDrawerOpen(false)}
                >
                  <X aria-hidden />
                </Button>
              }
            />
          </SideSheet>
        </>
      )}
    </div>
  );
}

function FloatingChatButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Abrir chat"
      data-testid="chat-fab"
      className="fixed bottom-6 right-6 z-40 flex h-14 items-center gap-2 rounded-full bg-primary pl-4 pr-5 text-[15px] font-medium text-primary-foreground shadow-pop transition-transform hover:scale-[1.02]"
    >
      <MessageCircle className="size-5" aria-hidden />
      Chat
    </button>
  );
}

/** Chat em tela cheia no celular, acompanhando o teclado (visualViewport). */
function MobileChatScreen() {
  const navigate = useNavigate();
  const [height, setHeight] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setHeight(vv.height);
      setOffset(vv.offsetTop);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return (
    <main
      id="main"
      className={cn('fixed inset-x-0 top-0 z-40 flex flex-col bg-card')}
      style={{
        height: height ?? '100dvh',
        transform: `translateY(${offset}px)`,
        paddingTop: 'var(--safe-top)',
        paddingBottom: 'var(--safe-bottom)',
      }}
    >
      <ChatView
        className="flex-1"
        headerActions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Fechar chat"
            onClick={() => (window.history.length > 1 ? window.history.back() : void navigate({ to: '/' }))}
          >
            <X aria-hidden />
          </Button>
        }
      />
    </main>
  );
}
