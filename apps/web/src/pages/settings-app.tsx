import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, BellRing, Check, Download, Share, Smartphone, SquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { isIOS, isStandalone, useInstallApp } from '@/lib/pwa';
import { disablePush, enablePush, pushStatus, type PushStatus } from '@/lib/push';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

function Row({
  icon,
  tone,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  tone: 'positive' | 'accent' | 'muted';
  title: string;
  hint: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-xl [&_svg]:size-5',
          tone === 'positive' && 'bg-positive-soft text-positive',
          tone === 'accent' && 'bg-primary-soft text-primary-soft-foreground',
          tone === 'muted' && 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {action}
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13.5px]">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function IOSSteps() {
  return (
    <ol className="space-y-2.5 rounded-xl bg-muted/60 p-3">
      <Step n={1}>
        Toque em <Share className="inline size-4 align-text-bottom text-primary" aria-label="Compartilhar" />{' '}
        <b>Compartilhar</b> no Safari
      </Step>
      <Step n={2}>
        Escolha <SquarePlus className="inline size-4 align-text-bottom" aria-hidden />{' '}
        <b>Adicionar à Tela de Início</b>
      </Step>
      <Step n={3}>Abra o app pelo ícone</Step>
    </ol>
  );
}

function InstallCard() {
  const { canInstall, installed, install } = useInstallApp();
  if (installed)
    return (
      <Row
        icon={<Check />}
        tone="positive"
        title="App instalado"
        hint="Você está usando a versão instalada."
      />
    );
  return (
    <div className="space-y-3">
      <Row
        icon={<Smartphone />}
        tone="accent"
        title="Instalar o app"
        hint="Ícone na tela inicial, tela cheia e notificações."
      />
      {canInstall ? (
        <Button
          className="w-full sm:w-auto"
          onClick={async () => {
            if (await install()) toast.success('App instalado!');
          }}
        >
          <Download aria-hidden /> Instalar
        </Button>
      ) : isIOS() ? (
        <IOSSteps />
      ) : (
        <p className="rounded-xl bg-muted/60 p-3 text-[13.5px] text-muted-foreground">
          Abra o menu do navegador (⋮) e escolha <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.
        </p>
      )}
    </div>
  );
}

const PUSH_HINT: Record<PushStatus, string> = {
  active: 'Ativadas: lembretes e avisos do assistente chegam aqui quando o WhatsApp não estiver vinculado.',
  inactive: 'Desativadas',
  denied: 'Bloqueadas nas configurações do navegador',
  unavailable: 'Não suportadas neste navegador',
};

function PushCard() {
  const key = useQuery({
    queryKey: ['push', 'key'],
    queryFn: () => api<{ publicKey: string | null }>('/api/push/key'),
    staleTime: Infinity,
  });
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const iosBrowser = isIOS() && !isStandalone();

  useEffect(() => {
    void pushStatus().then(setStatus);
  }, []);

  if (key.data && !key.data.publicKey)
    return (
      <Row
        icon={<BellOff />}
        tone="muted"
        title="Notificações neste aparelho"
        hint="As notificações não estão configuradas neste servidor."
      />
    );

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) await enablePush();
      else await disablePush();
      toast.success(
        on ? 'Notificações ativadas neste aparelho.' : 'Notificações desativadas neste aparelho.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    } finally {
      setStatus(await pushStatus());
      setBusy(false);
    }
  };

  const active = status === 'active';
  const blocked = status === 'denied' || status === 'unavailable';
  return (
    <Row
      icon={active ? <BellRing /> : blocked ? <BellOff /> : <Bell />}
      tone={active ? 'positive' : 'muted'}
      title="Notificações neste aparelho"
      hint={
        status === null ? 'Verificando…' : iosBrowser ? 'Requer o app na Tela de Início' : PUSH_HINT[status]
      }
      action={
        <Switch
          aria-label="Notificações neste aparelho"
          checked={active}
          disabled={status === null || blocked || iosBrowser || busy || !key.data}
          onCheckedChange={(v) => void toggle(v)}
        />
      }
    />
  );
}

/** Instalação do PWA e Web Push (por aparelho). */
export function AppSection() {
  return (
    <Card id="app" className="scroll-mt-24">
      <CardHeader title="App e notificações" description="Vale para este aparelho e este navegador." />
      <CardBody className="space-y-5">
        <InstallCard />
        <PushCard />
      </CardBody>
    </Card>
  );
}
