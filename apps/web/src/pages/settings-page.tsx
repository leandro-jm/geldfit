import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Mail, MessageCircle, Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { parseAmount } from '@sf/shared';
import { api, apiFetch } from '@/lib/api';
import {
  useAction,
  useInvalidateWorkspace,
  useMe,
  useMembers,
  useSettings,
  useWhatsApp,
  meKey,
} from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { downloadBlob, formatDateTimeBR, initials, todayLocalISO } from '@/lib/utils';
import { useSignOut } from '@/components/layout/shell-parts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/common/states';
import { AccountSection } from './settings-account';
import { AppSection } from './settings-app';
import { AiSettingsSection } from './settings-ai';
import { McpSection } from './settings-mcp';

const ROLE_LABEL = { owner: 'Dono', member: 'Membro', viewer: 'Leitura' } as const;

const REMINDERS: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'due_bill', label: 'Contas a vencer', hint: 'Lembrete no dia anterior ao vencimento' },
  { kind: 'statement_closed', label: 'Fatura fechada', hint: 'Valor da fatura quando o cartão fecha' },
  { kind: 'statement_due', label: 'Vencimento de fatura', hint: 'Antes do vencimento do cartão' },
  { kind: 'balance_alert', label: 'Alerta de saldo', hint: 'Quando a projeção cair abaixo do piso' },
  { kind: 'weekly_summary', label: 'Resumo semanal', hint: 'Gastos da semana e próximos vencimentos' },
  { kind: 'monthly_summary', label: 'Resumo mensal', hint: 'Fechamento do mês' },
  {
    kind: 'import_reminder',
    label: 'Lembrete de importação',
    hint: 'Pede o extrato quando a conta fica desatualizada',
  },
  { kind: 'budget_alert', label: 'Orçamentos', hint: 'Quando um orçamento passa do limite de alerta' },
  { kind: 'insights', label: 'Insights da carteira', hint: 'Novos insights no resumo' },
  {
    kind: 'seasonal',
    label: 'Calendário anual',
    hint: 'IPVA, IPTU, matrícula, 13º e reajustes, 30 a 60 dias antes',
  },
  {
    kind: 'nudge',
    label: 'Sugestões do assistente',
    hint: 'Metas, reserva e orçamentos propostos a partir dos seus dados (no máximo 1 por dia)',
  },
  {
    kind: 'question',
    label: 'Perguntas do assistente',
    hint: 'De vez em quando, uma pergunta rápida para decidir algo ou completar seu perfil',
  },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader title={title} description={description} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function WorkspaceSection() {
  const { workspace, role } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState(workspace?.name ?? '');
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  const save = async () => {
    try {
      await api('/api/workspace', { method: 'PATCH', body: { name: name.trim() } });
      await qc.invalidateQueries({ queryKey: meKey });
      toast.success('Nome atualizado.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  return (
    <Section
      id="workspace"
      title="Workspace"
      description={
        <>
          Plano <Badge tone="accent">{workspace?.plan ?? 'free'}</Badge> · seu papel:{' '}
          {role ? ROLE_LABEL[role] : '—'}
        </>
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Nome do workspace" htmlFor="ws-rename" className="flex-1">
          <Input
            id="ws-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={role !== 'owner'}
          />
        </Field>
        {role === 'owner' ? (
          <Button onClick={() => void save()} disabled={!name.trim() || name.trim() === workspace?.name}>
            Salvar
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function MembersSection() {
  const q = useMembers();
  const me = useMe();
  const { role } = useWorkspace();
  const invalidate = useInvalidateWorkspace();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'viewer'>('member');
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const owner = role === 'owner';

  const invite = async () => {
    try {
      const r = await api<{ ok: boolean; url?: string }>('/api/invites', {
        method: 'POST',
        body: { email: email.trim(), role: inviteRole },
      });
      toast.success(`Convite enviado para ${email.trim()}.`);
      setLastUrl(r.url ?? null);
      setEmail('');
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };
  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };

  return (
    <Section
      id="membros"
      title="Membros e convites"
      description="Membros lançam e editam; quem tem acesso de leitura só consulta."
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="divide-y rounded-xl border">
          {(q.data?.members ?? []).map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-semibold">
                {initials(m.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">
                  {m.name}{' '}
                  {m.id === me.data?.user.id ? <span className="text-muted-foreground">(você)</span> : null}
                </p>
                <p className="truncate text-[12.5px] text-muted-foreground">{m.email}</p>
              </div>
              {owner ? (
                <div className="w-32">
                  <Select
                    aria-label={`Papel de ${m.name}`}
                    value={m.role}
                    onChange={(e) =>
                      void call(() =>
                        api(`/api/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }),
                      )
                    }
                  >
                    <option value="owner">Dono</option>
                    <option value="member">Membro</option>
                    <option value="viewer">Leitura</option>
                  </Select>
                </div>
              ) : (
                <Badge>{ROLE_LABEL[m.role]}</Badge>
              )}
              {owner && m.id !== me.data?.user.id ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remover ${m.name}`}
                  onClick={() => void call(() => api(`/api/members/${m.id}`, { method: 'DELETE', body: {} }))}
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {owner ? (
        <>
          {(q.data?.invites ?? []).length ? (
            <div className="mt-4">
              <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">Convites pendentes</h3>
              <ul className="space-y-1.5">
                {(q.data?.invites ?? []).map((i) => (
                  <li key={i.id} className="flex items-center gap-2 text-[13px]">
                    <Mail className="size-4 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <Badge>{ROLE_LABEL[i.role]}</Badge>
                    <span className="hidden text-[12px] text-muted-foreground sm:inline">
                      expira {formatDateTimeBR(i.expiresAt)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revogar convite de ${i.email}`}
                      onClick={() =>
                        void call(() => api(`/api/invites/${i.id}`, { method: 'DELETE', body: {} }))
                      }
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <Field label="Convidar por e-mail" htmlFor="inv-email" className="flex-1">
              <Input
                id="inv-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="pessoa@exemplo.com"
              />
            </Field>
            <div className="sm:w-36">
              <Select
                aria-label="Papel do convidado"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'member' | 'viewer')}
              >
                <option value="member">Membro</option>
                <option value="viewer">Leitura</option>
              </Select>
            </div>
            <Button type="submit" disabled={!/.+@.+\..+/.test(email)}>
              <UserPlus aria-hidden /> Convidar
            </Button>
          </form>
          {lastUrl ? (
            <p className="mt-2 break-all rounded-lg bg-subtle p-2 text-[12px] text-muted-foreground">
              Link do convite (ambiente de desenvolvimento):{' '}
              <a className="text-primary underline" href={lastUrl}>
                {lastUrl}
              </a>
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function WhatsAppSection() {
  const q = useWhatsApp();
  const { workspaces } = useWorkspace();
  const invalidate = useInvalidateWorkspace();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const channel = q.data?.channels[0];
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      void invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      id="whatsapp"
      title="WhatsApp"
      description="Lance e consulte pelo WhatsApp; os lembretes também chegam por lá."
    >
      {q.isPending ? (
        <Skeleton className="h-16" />
      ) : !q.data?.enabled ? (
        <p className="text-[13.5px] text-muted-foreground">O WhatsApp não está configurado neste servidor.</p>
      ) : channel?.verifiedAt ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-[14px]">
            <MessageCircle className="size-4 text-positive" aria-hidden /> Vinculado a{' '}
            <span className="tnum font-medium">+{channel.address}</span>
            <Badge tone="positive">verificado</Badge>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Workspace padrão no WhatsApp" htmlFor="wa-ws" className="flex-1">
              <Select
                id="wa-ws"
                value={channel.defaultWorkspaceId ?? ''}
                onChange={(e) =>
                  void run(
                    () =>
                      api('/api/channels/whatsapp', {
                        method: 'PATCH',
                        body: { workspaceId: e.target.value },
                      }),
                    'Workspace padrão atualizado.',
                  )
                }
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api('/api/channels/whatsapp', { method: 'DELETE', body: {} }),
                  'WhatsApp desvinculado.',
                )
              }
            >
              Desvincular
            </Button>
          </div>
        </div>
      ) : channel ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('/api/channels/whatsapp/verify', { method: 'POST', body: { code } }),
              'WhatsApp vinculado!',
            );
          }}
        >
          <Field
            label={`Código enviado para +${channel.address}`}
            htmlFor="wa-code"
            className="flex-1"
            hint="Vale por 10 minutos."
          >
            <Input
              id="wa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="tnum tracking-[0.3em]"
            />
          </Field>
          <Button type="submit" disabled={busy || code.length !== 6}>
            Verificar
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => api('/api/channels/whatsapp', { method: 'DELETE', body: {} }))}
          >
            Trocar número
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('/api/channels/whatsapp', { method: 'POST', body: { phone } }),
              'Enviamos um código para o seu WhatsApp.',
            );
          }}
        >
          <Field label="Seu número com DDD" htmlFor="wa-phone" className="flex-1">
            <Input
              id="wa-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(48) 99999-0000"
            />
          </Field>
          <Button type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null} Enviar código
          </Button>
        </form>
      )}
    </Section>
  );
}

function PreferencesSections() {
  const q = useSettings();
  const action = useAction();
  const { canWrite } = useWorkspace();
  const s = q.data?.settings;
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [times, setTimes] = useState({ reminderTime: '09:00', quietStart: '21:00', quietEnd: '08:00' });
  const [proj, setProj] = useState({
    floor: '0,00',
    variable: '0,00',
    window: '3',
    optimistic: '0.85',
    pessimistic: '1.15',
    emergency: '6',
    usdMin: '',
    usdMax: '',
  });

  useEffect(() => {
    if (!q.data || !s) return;
    const p: Record<string, boolean> = {};
    for (const r of REMINDERS)
      p[r.kind] = q.data.reminderPrefs.find((x) => x.kind === r.kind)?.enabled ?? true;
    setPrefs(p);
    setTimes({
      reminderTime: s.reminderTime.slice(0, 5),
      quietStart: s.quietStart.slice(0, 5),
      quietEnd: s.quietEnd.slice(0, 5),
    });
    setProj({
      floor: (s.balanceFloorCents / 100).toFixed(2).replace('.', ','),
      variable: (s.variableMonthlyCents / 100).toFixed(2).replace('.', ','),
      window: String(s.variableWindowMonths),
      optimistic: String(s.optimisticFactor),
      pessimistic: String(s.pessimisticFactor),
      emergency: String(s.emergencyMonthsTarget),
      usdMin: s.usdMinPct !== null ? String(s.usdMinPct) : '',
      usdMax: s.usdMaxPct !== null ? String(s.usdMaxPct) : '',
    });
  }, [q.data, s]);

  const save = async (payload: unknown) => {
    try {
      const r = await action.mutateAsync({ kind: 'settings', payload });
      toast.success(r.summary, { description: r.impact ?? undefined });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falhou.');
    }
  };

  const saveReminders = () =>
    save({
      workspace: { reminderTime: times.reminderTime, quietStart: times.quietStart, quietEnd: times.quietEnd },
      reminderPrefs: Object.entries(prefs).map(([kind, enabled]) => ({ kind, enabled })),
    });

  const num = (v: string) => Number(v.replace(',', '.'));
  const saveProjection = () => {
    const floor = parseAmount(proj.floor);
    const variable = parseAmount(proj.variable || '0');
    if (floor === null || variable === null) return toast.error('Valores inválidos.');
    return save({
      workspace: {
        balanceFloorCents: floor,
        variableMonthlyCents: Math.max(0, variable),
        variableWindowMonths: Math.min(6, Math.max(3, Math.round(num(proj.window)))),
        optimisticFactor: num(proj.optimistic),
        pessimisticFactor: num(proj.pessimistic),
        emergencyMonthsTarget: num(proj.emergency),
        usdMinPct: proj.usdMin.trim() ? num(proj.usdMin) : null,
        usdMaxPct: proj.usdMax.trim() ? num(proj.usdMax) : null,
      },
    });
  };

  if (q.isPending) return <Skeleton className="h-64" />;
  return (
    <>
      <Section
        id="lembretes"
        title="Lembretes"
        description="O que você quer receber (WhatsApp e e-mail) e em que horário."
      >
        <ul className="divide-y rounded-xl border">
          {REMINDERS.map((r) => (
            <li key={r.kind} className="flex min-h-14 items-center justify-between gap-3 px-3 py-2">
              <label htmlFor={`rem-${r.kind}`} className="min-w-0 text-[13.5px]">
                <span className="font-medium">{r.label}</span>
                <span className="block text-[12.5px] text-muted-foreground">{r.hint}</span>
              </label>
              <Switch
                id={`rem-${r.kind}`}
                checked={prefs[r.kind] ?? true}
                onCheckedChange={(v) => setPrefs({ ...prefs, [r.kind]: v })}
                disabled={!canWrite}
              />
            </li>
          ))}
        </ul>
        <div className="mt-4 grid grid-cols-1 gap-3 @min-[440px]:grid-cols-3">
          <Field label="Horário" htmlFor="t-rem">
            <Input
              id="t-rem"
              type="time"
              value={times.reminderTime}
              onChange={(e) => setTimes({ ...times, reminderTime: e.target.value })}
            />
          </Field>
          <Field label="Silêncio de" htmlFor="t-qs">
            <Input
              id="t-qs"
              type="time"
              value={times.quietStart}
              onChange={(e) => setTimes({ ...times, quietStart: e.target.value })}
            />
          </Field>
          <Field label="até" htmlFor="t-qe">
            <Input
              id="t-qe"
              type="time"
              value={times.quietEnd}
              onChange={(e) => setTimes({ ...times, quietEnd: e.target.value })}
            />
          </Field>
        </div>
        {canWrite ? (
          <Button className="mt-4" onClick={() => void saveReminders()} disabled={action.isPending}>
            Salvar lembretes
          </Button>
        ) : null}
      </Section>

      <Section
        id="projecao"
        title="Projeção e metas"
        description="Piso de saldo, gasto variável e fatores dos cenários."
      >
        <div className="grid grid-cols-1 gap-4 @min-[520px]:grid-cols-2 @min-[1000px]:grid-cols-4">
          <Field label="Piso de saldo (R$)" htmlFor="p-floor" hint="Alerta quando a projeção ficar abaixo.">
            <Input
              id="p-floor"
              inputMode="decimal"
              value={proj.floor}
              onChange={(e) => setProj({ ...proj, floor: e.target.value })}
            />
          </Field>
          <Field
            label="Variável informado (R$/mês)"
            htmlFor="p-var"
            hint="Usado com menos de 2 meses de histórico."
          >
            <Input
              id="p-var"
              inputMode="decimal"
              value={proj.variable}
              onChange={(e) => setProj({ ...proj, variable: e.target.value })}
            />
          </Field>
          <Field label="Janela do variável" htmlFor="p-win">
            <Select
              id="p-win"
              value={proj.window}
              onChange={(e) => setProj({ ...proj, window: e.target.value })}
            >
              {[3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} meses
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reserva de emergência (meses)" htmlFor="p-em">
            <Input
              id="p-em"
              inputMode="decimal"
              value={proj.emergency}
              onChange={(e) => setProj({ ...proj, emergency: e.target.value })}
            />
          </Field>
          <Field label="Fator otimista" htmlFor="p-opt" hint="× gasto variável (ex.: 0,85)">
            <Input
              id="p-opt"
              inputMode="decimal"
              value={proj.optimistic}
              onChange={(e) => setProj({ ...proj, optimistic: e.target.value })}
            />
          </Field>
          <Field label="Fator pessimista" htmlFor="p-pes" hint="× gasto variável (ex.: 1,15)">
            <Input
              id="p-pes"
              inputMode="decimal"
              value={proj.pessimistic}
              onChange={(e) => setProj({ ...proj, pessimistic: e.target.value })}
            />
          </Field>
          <Field label="Dólar mínimo (%)" htmlFor="p-umin">
            <Input
              id="p-umin"
              inputMode="decimal"
              value={proj.usdMin}
              onChange={(e) => setProj({ ...proj, usdMin: e.target.value })}
            />
          </Field>
          <Field label="Dólar máximo (%)" htmlFor="p-umax">
            <Input
              id="p-umax"
              inputMode="decimal"
              value={proj.usdMax}
              onChange={(e) => setProj({ ...proj, usdMax: e.target.value })}
            />
          </Field>
        </div>
        {canWrite ? (
          <Button className="mt-4" onClick={() => void saveProjection()} disabled={action.isPending}>
            Salvar projeção
          </Button>
        ) : null}
      </Section>
    </>
  );
}

function DataSection() {
  const { workspace, role } = useWorkspace();
  const qc = useQueryClient();
  const signOut = useSignOut();
  const [delWs, setDelWs] = useState(false);
  const [delMe, setDelMe] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const exportFile = async (path: string, filename: string) => {
    try {
      const res = await apiFetch(path);
      downloadBlob(await res.blob(), filename);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao exportar.');
    }
  };

  return (
    <>
      <Section id="dados" title="Seus dados (LGPD)" description="Exporte tudo a qualquer momento.">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void exportFile('/api/export', `saude-financeira-${todayLocalISO()}.json`)}
          >
            <Download aria-hidden /> Exportar tudo (JSON)
          </Button>
          <Button
            variant="outline"
            onClick={() => void exportFile('/api/export/transactions.csv', 'lancamentos.csv')}
          >
            <Download aria-hidden /> Lançamentos (CSV)
          </Button>
        </div>
      </Section>

      <Card className="border-negative/30">
        <CardHeader
          title="Zona de perigo"
          description="Ações permanentes. Os dados são expurgados pelo sistema."
        />
        <CardBody className="space-y-3">
          {role === 'owner' ? (
            <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-[13.5px]">
                <p className="font-medium">Excluir o workspace “{workspace?.name}”</p>
                <p className="text-muted-foreground">
                  Some para todos os membros, com contas, lançamentos e anexos.
                </p>
              </div>
              <Button variant="danger" onClick={() => (setConfirmText(''), setDelWs(true))}>
                <Trash2 aria-hidden /> Excluir workspace
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-[13.5px]">
              <p className="font-medium">Excluir minha conta</p>
              <p className="text-muted-foreground">
                Você sai de todos os workspaces; os que só você administra são excluídos.
              </p>
            </div>
            <Button variant="danger" onClick={() => (setConfirmText(''), setDelMe(true))}>
              <Trash2 aria-hidden /> Excluir conta
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={delWs}
        onOpenChange={setDelWs}
        title="Excluir workspace?"
        description={`Digite o nome “${workspace?.name ?? ''}” para confirmar.`}
        confirmLabel="Excluir para sempre"
        danger
        busy={busy || confirmText !== workspace?.name}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api('/api/workspace', { method: 'DELETE', body: { confirmName: confirmText } });
            toast.success('Workspace excluído.');
            try {
              window.localStorage.removeItem('sf.workspace');
            } catch {
              /* ignora */
            }
            await qc.invalidateQueries({ queryKey: meKey });
            window.location.assign('/');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Falhou.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="del-ws" className="sr-only">
          Nome do workspace
        </label>
        <Input
          id="del-ws"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={workspace?.name}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={delMe}
        onOpenChange={setDelMe}
        title="Excluir sua conta?"
        description="Digite EXCLUIR para confirmar. Isso não pode ser desfeito."
        confirmLabel="Excluir minha conta"
        danger
        busy={busy || confirmText !== 'EXCLUIR'}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api('/api/me', { method: 'DELETE', body: { confirm: 'EXCLUIR' } });
            await signOut();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Falhou.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="del-me" className="sr-only">
          Confirmação
        </label>
        <Input
          id="del-me"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="EXCLUIR"
        />
      </ConfirmDialog>
    </>
  );
}

const TOC = [
  ['conta', 'Minha conta'],
  ['workspace', 'Workspace'],
  ['membros', 'Membros'],
  ['whatsapp', 'WhatsApp'],
  ['mcp', 'Assistentes externos'],
  ['app', 'App e notificações'],
  ['lembretes', 'Lembretes'],
  ['projecao', 'Projeção'],
  ['dados', 'Dados'],
] as const;

export function SettingsPage() {
  const isAdmin = useMe().data?.isAdmin === true;
  // a seção de IA vale para o servidor inteiro: só para admins, logo antes de "Dados"
  const toc = isAdmin ? [...TOC.slice(0, -1), ['ia', 'Inteligência artificial'] as const, TOC.at(-1)!] : TOC;
  return (
    <div>
      <PageHeader title="Configurações" />
      <div className="grid gap-6 @min-[1000px]:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Seções" className="hidden @min-[1000px]:block">
          <ul className="sticky top-24 space-y-0.5">
            {toc.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-lg px-3 py-1.5 text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4">
          <AccountSection />
          <WorkspaceSection />
          <MembersSection />
          <WhatsAppSection />
          <McpSection />
          <AppSection />
          <PreferencesSections />
          {isAdmin ? <AiSettingsSection /> : null}
          <DataSection />
        </div>
      </div>
    </div>
  );
}
