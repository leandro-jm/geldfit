import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileLock2, Loader2, LockKeyhole, MessageSquareText, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth';
import { api } from '@/lib/api';
import { meKey } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/switch';
import { Logo } from '@/components/layout/shell-parts';

function AuthFrame({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <main className="w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-soft sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

function GoogleButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="w-full"
      size="lg"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await authClient.signIn.social({
            provider: 'google',
            callbackURL: window.location.origin + '/',
          });
          if (r.error) toast.error(r.error.message ?? 'Login com Google indisponível neste servidor.');
        } catch {
          toast.error('Login com Google indisponível neste servidor.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
        <path
          fill="#EA4335"
          d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3 14.7 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z"
        />
      </svg>
      Continuar com Google
    </Button>
  );
}

export function LoginPage({ mode, redirect }: { mode: 'login' | 'signup'; redirect?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = signup
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (r.error) {
        const code = r.error.code ?? '';
        setError(
          code.includes('INVALID_EMAIL_OR_PASSWORD')
            ? 'E-mail ou senha incorretos.'
            : code.includes('USER_ALREADY_EXISTS')
              ? 'Já existe uma conta com este e-mail. Entre com sua senha.'
              : code.includes('PASSWORD_TOO_SHORT')
                ? 'A senha precisa ter pelo menos 8 caracteres.'
                : (r.error.message ?? 'Não foi possível continuar.'),
        );
        return;
      }
      await qc.invalidateQueries({ queryKey: meKey });
      void navigate({ to: redirect && redirect.startsWith('/') ? redirect : '/' });
    } catch {
      setError('Não foi possível conectar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title={signup ? 'Criar conta' : 'Entrar'}
      subtitle={
        signup ? 'Planeje suas finanças conversando. Leva menos de um minuto.' : 'Bem-vindo de volta.'
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {signup ? (
          <Field label="Nome" htmlFor="name">
            <Input
              id="name"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        ) : null}
        <Field label="E-mail" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Senha" htmlFor="password" hint={signup ? 'Mínimo de 8 caracteres.' : undefined}>
          <Input
            id="password"
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || !email || password.length < (signup ? 8 : 1) || (signup && !name.trim())}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {signup ? 'Criar conta' : 'Entrar'}
        </Button>
      </form>
      <div className="my-5 flex items-center gap-3 text-[12px] text-muted-foreground">
        <div className="h-px flex-1 bg-border" /> ou <div className="h-px flex-1 bg-border" />
      </div>
      <GoogleButton />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        {signup ? (
          <>
            Já tem conta?{' '}
            <Link to="/login" search={{ redirect }} className="font-medium text-primary hover:underline">
              Entrar
            </Link>
          </>
        ) : (
          <>
            Novo por aqui?{' '}
            <Link to="/cadastro" search={{ redirect }} className="font-medium text-primary hover:underline">
              Criar conta
            </Link>
          </>
        )}
      </p>
    </AuthFrame>
  );
}

export function ConsentPage() {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = [
    {
      icon: ShieldCheck,
      title: 'Para que usamos seus dados',
      text: 'Contas, lançamentos, faturas e investimentos que você informar servem só para calcular saldos, projeções, lembretes e insights para você.',
    },
    {
      icon: MessageSquareText,
      title: 'Mensagens e anexos',
      text: 'O que você escreve no chat e os arquivos que envia são processados por um provedor de IA, sem uso para treinamento e sem retenção além do necessário. Números de cartão e CPF são mascarados antes.',
    },
    {
      icon: FileLock2,
      title: 'Segurança',
      text: 'Anexos são cifrados em repouso e cada workspace só é visível para seus membros.',
    },
    {
      icon: Trash2,
      title: 'Seus direitos (LGPD)',
      text: 'Você pode exportar tudo (JSON e CSV) e excluir o workspace ou a conta quando quiser, em Configurações.',
    },
  ];
  const accept = async () => {
    setBusy(true);
    try {
      await api('/api/me/consent', { method: 'POST', body: { terms: true, privacy: true, llm: true } });
      await qc.invalidateQueries({ queryKey: meKey });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível registrar.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Antes de começar" subtitle="Leia como tratamos seus dados.">
      <ul className="space-y-4">
        {items.map((i) => (
          <li key={i.title} className="flex gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
              <i.icon className="size-4" aria-hidden />
            </div>
            <div>
              <h2 className="text-sm font-medium">{i.title}</h2>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{i.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border bg-subtle p-3 text-[13px]">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => setChecked(v === true)}
          className="mt-0.5"
          aria-label="Concordo com os termos"
        />
        <span>
          Li e concordo com os Termos de Uso, a Política de Privacidade e o processamento das minhas mensagens
          e anexos por IA.
        </span>
      </label>
      <Button size="lg" className="mt-4 w-full" disabled={!checked || busy} onClick={() => void accept()}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <LockKeyhole aria-hidden />}
        Concordar e continuar
      </Button>
    </AuthFrame>
  );
}

export function InvitePage({ token }: { token: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ workspaceId: string }>('/api/invites/accept', {
        method: 'POST',
        body: { token },
      });
      try {
        window.localStorage.setItem('sf.workspace', r.workspaceId);
      } catch {
        /* ignora */
      }
      await qc.invalidateQueries({ queryKey: meKey });
      toast.success('Convite aceito!');
      void navigate({ to: '/' });
      setTimeout(() => window.location.reload(), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Convite inválido.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame
      title="Convite para um workspace"
      subtitle="Alguém compartilhou um workspace do Saúde Financeira com você."
    >
      {error ? (
        <p role="alert" className="mb-4 rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
          {error}
        </p>
      ) : null}
      <Button size="lg" className="w-full" onClick={() => void accept()} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Aceitar convite
      </Button>
      <Button variant="ghost" className="mt-2 w-full" asChild>
        <Link to="/">Agora não</Link>
      </Button>
    </AuthFrame>
  );
}
