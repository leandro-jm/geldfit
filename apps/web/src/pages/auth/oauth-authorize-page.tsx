import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, Loader2, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { AuthFrame } from './auth-pages';

export type OAuthSearch = {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
};

/** Consentimento OAuth para um assistente externo (Claude, ChatGPT...) acessar um espaço via MCP. */
export function OAuthAuthorizePage({ search }: { search: OAuthSearch }) {
  const me = useMe();
  const workspaces = me.data?.workspaces ?? [];
  const [workspaceId, setWorkspaceId] = useState(() => workspaces[0]?.id ?? '');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const malformed =
    !search.client_id ||
    !search.redirect_uri ||
    search.response_type !== 'code' ||
    !search.code_challenge ||
    search.code_challenge_method !== 'S256';

  const client = useQuery({
    queryKey: ['oauth-client', search.client_id, search.redirect_uri],
    queryFn: () =>
      api<{ name: string; redirectHost: string }>(
        `/api/oauth/client?client_id=${encodeURIComponent(search.client_id!)}&redirect_uri=${encodeURIComponent(search.redirect_uri!)}`,
      ),
    enabled: !malformed,
    retry: false,
  });

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    setError(null);
    try {
      const r = await api<{ redirect: string }>('/api/oauth/authorize', {
        method: 'POST',
        body: {
          client_id: search.client_id,
          redirect_uri: search.redirect_uri,
          code_challenge: search.code_challenge,
          code_challenge_method: search.code_challenge_method,
          state: search.state,
          scope: search.scope,
          workspace_id: workspaceId || workspaces[0]?.id,
          decision,
        },
      });
      window.location.assign(r.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a autorização.');
      setBusy(null);
    }
  };

  if (malformed || client.isError) {
    return (
      <AuthFrame title="Não foi possível conectar">
        <p role="alert" className="rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
          {client.error instanceof Error
            ? client.error.message
            : 'O pedido de conexão veio incompleto. Volte ao assistente e tente conectar de novo.'}
        </p>
      </AuthFrame>
    );
  }
  if (client.isPending) {
    return (
      <AuthFrame title="Conectar assistente">
        <div className="flex justify-center py-6" aria-busy="true">
          <Loader2 className="animate-spin text-muted-foreground" aria-label="Carregando" />
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={`Conectar ${client.data.name}`}
      subtitle={
        <>
          <strong className="font-medium text-foreground">{client.data.name}</strong> (
          {client.data.redirectHost}) quer acessar suas finanças pelo MCP.
        </>
      }
    >
      <ul className="space-y-3 text-[14px]">
        <li className="flex gap-3">
          <Eye className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>Ver contas, lançamentos, projeção, calendário, metas e carteira do espaço escolhido.</span>
        </li>
        <li className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
          <span>Somente leitura: o assistente não lança, edita nem apaga nada.</span>
        </li>
        <li className="flex gap-3">
          <Undo2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>Você pode desconectar quando quiser em Configurações → Assistentes externos.</span>
        </li>
      </ul>

      {workspaces.length > 1 ? (
        <Field label="Espaço" htmlFor="oauth-ws" className="mt-6">
          <Select id="oauth-ws" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-negative-soft px-3 py-2 text-[13px] text-negative">
          {error}
        </p>
      ) : null}

      <Button size="lg" className="mt-6 w-full" onClick={() => void decide('allow')} disabled={busy !== null}>
        {busy === 'allow' ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Autorizar
      </Button>
      <Button
        variant="ghost"
        className="mt-2 w-full"
        onClick={() => void decide('deny')}
        disabled={busy !== null}
      >
        Cancelar
      </Button>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Só autorize assistentes em que você confia. Você será levado de volta para {client.data.redirectHost}.
      </p>
    </AuthFrame>
  );
}
