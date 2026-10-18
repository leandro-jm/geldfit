import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDateTimeBR } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

type Grant = {
  id: string;
  clientName: string;
  workspaceName: string;
  createdAt: string;
  lastUsedAt: string | null;
};
const grantsKey = ['mcp-grants'] as const;

/** Assistentes externos (Claude, ChatGPT...) conectados via MCP: endereço e conexões ativas. */
export function McpSection() {
  const qc = useQueryClient();
  const url = `${window.location.origin}/api/mcp`;
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const grants = useQuery({ queryKey: grantsKey, queryFn: () => api<Grant[]>('/api/mcp/grants') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/mcp/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Assistente desconectado.');
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: grantsKey });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Não foi possível desconectar.'),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar. Selecione o endereço e copie manualmente.');
    }
  };

  return (
    <Card id="mcp" className="scroll-mt-24">
      <CardHeader
        title="Assistentes externos"
        description="Conecte o Claude, o ChatGPT ou outro assistente compatível com MCP para consultar suas finanças. Acesso somente leitura."
      />
      <CardBody className="space-y-5">
        <div>
          <p className="text-[13px] font-medium">Endereço do servidor MCP</p>
          <div className="mt-1.5 flex gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-lg border bg-subtle px-3 py-2 text-[13px]"
              title={url}
            >
              {url}
            </code>
            <Button variant="outline" onClick={() => void copy()} aria-label="Copiar endereço">
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
            <li>No assistente, adicione um conector personalizado (MCP) e cole este endereço.</li>
            <li>Entre com a sua conta quando ele pedir e escolha o espaço.</li>
            <li>Pronto: pergunte sobre projeção, parcelas, calendário ou metas na conversa.</li>
          </ol>
        </div>

        <div>
          <p className="text-[13px] font-medium">Conectados</p>
          {grants.isPending ? (
            <Skeleton className="mt-2 h-14 w-full" />
          ) : !grants.data?.length ? (
            <p className="mt-2 text-[13px] text-muted-foreground">Nenhum assistente conectado.</p>
          ) : (
            <ul className="mt-2 divide-y rounded-xl border">
              {grants.data.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                    <Plug className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{g.clientName}</p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {g.workspaceName} · conectado em {formatDateTimeBR(g.createdAt)}
                      {g.lastUsedAt ? ` · último uso ${formatDateTimeBR(g.lastUsedAt)}` : ''}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(g)}>
                    Desconectar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Desconectar ${revoking?.clientName ?? ''}?`}
        description="O assistente perde o acesso na hora. Para usar de novo, será preciso autorizar outra vez."
        confirmLabel="Desconectar"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}
