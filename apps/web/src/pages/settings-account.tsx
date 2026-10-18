import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth';
import { meKey, useMe } from '@/lib/queries';
import { initials } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

// Mensagens do Better Auth (em inglês) para pt-BR
const AUTH_ERRORS: Record<string, string> = {
  INVALID_PASSWORD: 'Senha atual incorreta.',
  PASSWORD_TOO_SHORT: 'A nova senha precisa ter pelo menos 8 caracteres.',
  PASSWORD_TOO_LONG: 'A nova senha é longa demais.',
  CHANGE_EMAIL_DISABLED: 'A troca de e-mail não está disponível.',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'Sua conta entra pelo Google e não tem senha.',
  SESSION_EXPIRED: 'Por segurança, saia e entre de novo antes de fazer esta alteração.',
};

function authMessage(err: { code?: string; message?: string } | null | undefined, fallback: string) {
  if (!err) return fallback;
  if (err.code && AUTH_ERRORS[err.code]) return AUTH_ERRORS[err.code]!;
  if (err.message === 'Email is the same') return 'Esse já é o seu e-mail.';
  return fallback;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dados do usuário logado: nome, e-mail e senha (rotas do Better Auth). */
export function AccountSection() {
  const me = useMe();
  const qc = useQueryClient();
  const user = me.data?.user;
  const accounts = useQuery({
    queryKey: ['auth', 'accounts'],
    queryFn: async () => (await authClient.listAccounts()).data ?? [],
    staleTime: 5 * 60_000,
  });
  const hasPassword = (accounts.data ?? []).some((a) => a.providerId === 'credential');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'name' | 'email' | 'password' | null>(null);
  const [emailSent, setEmailSent] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  useEffect(() => setName(user?.name ?? ''), [user?.name]);
  useEffect(() => setEmail(user?.email ?? ''), [user?.email]);

  const refresh = () => qc.invalidateQueries({ queryKey: meKey });

  const saveName = async () => {
    setBusy('name');
    const { error } = await authClient.updateUser({ name: name.trim() });
    setBusy(null);
    if (error) return toast.error(authMessage(error, 'Não foi possível salvar o nome.'));
    await refresh();
    toast.success('Nome atualizado.');
  };

  const saveEmail = async () => {
    const newEmail = email.trim().toLowerCase();
    setBusy('email');
    const { error } = await authClient.changeEmail({
      newEmail,
      callbackURL: `${window.location.origin}/configuracoes`,
    });
    setBusy(null);
    if (error) return toast.error(authMessage(error, 'Não foi possível trocar o e-mail.'));
    if (user?.emailVerified) {
      // e-mail verificado: só muda depois do link enviado ao endereço atual
      setEmailSent(user.email);
      setEmail(user.email);
    } else {
      await refresh();
      toast.success('E-mail atualizado. Enviamos um link para verificar o novo endereço.');
    }
  };

  const savePassword = async () => {
    setBusy('password');
    const { error } = await authClient.changePassword({
      currentPassword: pw.current,
      newPassword: pw.next,
      revokeOtherSessions: true,
    });
    setBusy(null);
    if (error) return toast.error(authMessage(error, 'Não foi possível trocar a senha.'));
    setPw({ current: '', next: '', confirm: '' });
    toast.success('Senha alterada. As outras sessões foram encerradas.');
  };

  const nameChanged = name.trim() && name.trim() !== user?.name;
  const emailValid = EMAIL_RE.test(email.trim());
  const emailChanged = emailValid && email.trim().toLowerCase() !== user?.email.toLowerCase();
  const pwMismatch = pw.confirm.length > 0 && pw.next !== pw.confirm;
  const pwReady = pw.current && pw.next.length >= 8 && pw.next === pw.confirm;

  return (
    <Card id="conta" className="scroll-mt-24">
      <CardHeader title="Minha conta" description="Seu nome aparece para os membros do workspace e no assistente." />
      <CardBody>
        {!user ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[14px] font-semibold text-primary-soft-foreground">
                {initials(user.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium">{user.name}</p>
                <p className="truncate text-[13px] text-muted-foreground">{user.email}</p>
              </div>
            </div>

            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (nameChanged) void saveName();
              }}
            >
              <Field label="Nome" htmlFor="account-name" className="flex-1">
                <Input
                  id="account-name"
                  value={name}
                  maxLength={80}
                  autoComplete="name"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button type="submit" disabled={!nameChanged || busy === 'name'}>
                Salvar nome
              </Button>
            </form>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (emailChanged) void saveEmail();
              }}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Field
                  label={
                    <span className="inline-flex items-center gap-2">
                      E-mail
                      {user.emailVerified ? (
                        <Badge tone="positive">verificado</Badge>
                      ) : (
                        <Badge tone="warning">não verificado</Badge>
                      )}
                    </span>
                  }
                  htmlFor="account-email"
                  className="flex-1"
                  error={email.trim() && !emailValid ? 'E-mail inválido.' : null}
                >
                  <Input
                    id="account-email"
                    type="email"
                    value={email}
                    autoComplete="email"
                    aria-describedby="account-email-hint"
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setEmailSent(null);
                    }}
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={!emailChanged || busy === 'email'}>
                  Trocar e-mail
                </Button>
              </div>
              <p
                id="account-email-hint"
                className="mt-1.5 text-[12.5px] text-muted-foreground"
                role={emailSent ? 'status' : undefined}
              >
                {emailSent
                  ? `Enviamos um link para ${emailSent}. O e-mail só muda depois que você confirmar por lá.`
                  : user.emailVerified
                    ? 'Para trocar, você confirma pelo e-mail atual.'
                    : 'O novo endereço recebe um link de verificação.'}
              </p>
            </form>

            {accounts.isPending ? null : hasPassword ? (
              <form
                className="space-y-2 border-t pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pwReady) void savePassword();
                }}
              >
                <p className="text-[14px] font-medium">Senha</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Senha atual" htmlFor="pw-current">
                    <Input
                      id="pw-current"
                      type="password"
                      autoComplete="current-password"
                      value={pw.current}
                      onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
                    />
                  </Field>
                  <Field label="Nova senha" htmlFor="pw-next" hint="Mínimo de 8 caracteres.">
                    <Input
                      id="pw-next"
                      type="password"
                      autoComplete="new-password"
                      value={pw.next}
                      onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label="Confirmar nova senha"
                    htmlFor="pw-confirm"
                    error={pwMismatch ? 'As senhas não conferem.' : null}
                  >
                    <Input
                      id="pw-confirm"
                      type="password"
                      autoComplete="new-password"
                      value={pw.confirm}
                      onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
                    />
                  </Field>
                </div>
                <Button type="submit" variant="secondary" disabled={!pwReady || busy === 'password'}>
                  Trocar senha
                </Button>
              </form>
            ) : (
              <p className="border-t pt-4 text-[13px] text-muted-foreground">
                Você entra com o Google, então não há senha para trocar aqui.
              </p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
