import { useEffect, useRef, useState } from 'react';
import {
  Inbox,
  RefreshCw,
  Archive,
  Brain,
  Check,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  INCOME_STABILITY,
  INTERESTS,
  LIFE_STAGES,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABEL,
  NUDGE_FREQUENCY,
  OBJECTIVES,
  RISK_SELF,
  UFS,
  formatDateBR,
  type FinancialProfileDTO,
  type MemoryCategory,
  type MemoryDTO,
} from '@sf/shared';
import {
  useAgentUsage,
  useApiMutation,
  useInvalidateWorkspace,
  useMemories,
  useNudgeMutes,
  useNudges,
  useProfile,
} from '@/lib/queries';
import { api } from '@/lib/api';
import { NUDGE_CATEGORY, NudgeList, WaText } from '@/components/agent/nudge-card';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog, ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, PageHeader } from '@/components/common/states';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : 'Falhou.');

function MemoryForm({
  memory,
  open,
  onClose,
}: {
  memory: MemoryDTO | null;
  open: boolean;
  onClose: () => void;
}) {
  const [f, setF] = useState({
    content: '',
    category: 'objetivo' as MemoryCategory,
    expiresAt: '',
    shared: false,
  });
  useEffect(() => {
    if (!open) return;
    setF(
      memory
        ? {
            content: memory.content,
            category: memory.category as MemoryCategory,
            expiresAt: memory.expiresAt ?? '',
            shared: memory.scope === 'household',
          }
        : { content: '', category: 'objetivo', expiresAt: '', shared: false },
    );
  }, [open, memory]);
  const save = useApiMutation((v: typeof f) =>
    memory
      ? {
          path: `/api/memories/${memory.id}`,
          method: 'PATCH',
          body: {
            content: v.content.trim(),
            category: v.category,
            expiresAt: v.expiresAt || null,
            shared: v.shared,
          },
        }
      : {
          path: '/api/memories',
          method: 'POST',
          body: {
            content: v.content.trim(),
            category: v.category,
            expiresAt: v.expiresAt || null,
            shared: v.shared,
          },
        },
  );
  const valid = f.content.trim().length >= 2;
  const submit = async () => {
    try {
      await save.mutateAsync(f);
      toast.success(memory ? 'Memória atualizada.' : 'Anotado.');
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={memory ? 'Editar memória' : 'Contar algo ao assistente'}
      description="O assistente usa isto nas conversas e nas sugestões. Você pode apagar quando quiser."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || save.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="O que lembrar" htmlFor="m-content" className="col-span-2">
          <Input
            id="m-content"
            value={f.content}
            maxLength={300}
            onChange={(e) => setF({ ...f, content: e.target.value })}
            placeholder="Ex.: Quero trocar de carro em 2027"
          />
        </Field>
        <Field label="Tipo" htmlFor="m-cat">
          <Select
            id="m-cat"
            value={f.category}
            onChange={(e) => setF({ ...f, category: e.target.value as MemoryCategory })}
          >
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prazo (opcional)" htmlFor="m-date">
          <Input
            id="m-date"
            type="date"
            value={f.expiresAt}
            onChange={(e) => setF({ ...f, expiresAt: e.target.value })}
          />
        </Field>
        <label className="col-span-2 flex items-center justify-between gap-3 text-sm">
          <span>
            Compartilhar com o workspace
            <span className="block text-[12px] text-muted-foreground">
              Membros veem (ex.: nascimento de um filho). Dado sensível nunca é compartilhado.
            </span>
          </span>
          <Switch
            checked={f.shared}
            onCheckedChange={(v) => setF({ ...f, shared: v })}
            aria-label="Compartilhar com o workspace"
          />
        </label>
      </div>
    </ResponsiveDialog>
  );
}

function MemoryItem({ m, onEdit }: { m: MemoryDTO; onEdit: (m: MemoryDTO) => void }) {
  const act = useApiMutation((body: Record<string, unknown>) => ({
    path: `/api/memories/${m.id}`,
    method: 'PATCH',
    body,
  }));
  const del = useApiMutation(() => ({ path: `/api/memories/${m.id}`, method: 'DELETE' }));
  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  const busy = act.isPending || del.isPending;
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-xl border px-3 py-2.5',
        m.status === 'pending' && 'border-warning/40 bg-warning-soft/40',
        m.status === 'archived' && 'opacity-70',
      )}
      data-testid="memory-item"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm">{m.content}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Badge tone="outline">{MEMORY_CATEGORY_LABEL[m.category as MemoryCategory] ?? m.category}</Badge>
          {m.pinned ? <Badge tone="accent">fixada</Badge> : null}
          {m.scope === 'household' ? (
            <Badge tone="neutral">{m.mine ? 'compartilhada' : 'de outro membro'}</Badge>
          ) : null}
          {m.sensitive ? <Badge tone="warning">sensível</Badge> : null}
          {m.expiresAt ? <span>prazo {formatDateBR(m.expiresAt)}</span> : null}
          <span>
            {m.source === 'chat'
              ? 'aprendido na conversa'
              : m.source === 'manual'
                ? 'você anotou'
                : 'a seu pedido'}{' '}
            · {formatDateBR(m.updatedAt.slice(0, 10))}
          </span>
        </div>
      </div>
      {m.mine ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {m.status === 'pending' ? (
            <>
              <Button
                size="sm"
                variant="soft"
                disabled={busy}
                onClick={() => void run(act.mutateAsync({ action: 'confirm' }), 'Confirmado.')}
              >
                <Check /> Confirmar
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Descartar"
                disabled={busy}
                onClick={() => void run(act.mutateAsync({ action: 'reject' }), 'Descartado.')}
              >
                <X />
              </Button>
            </>
          ) : m.status === 'archived' ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Restaurar"
              disabled={busy}
              onClick={() => void run(act.mutateAsync({ action: 'restore' }), 'Restaurado.')}
            >
              <RotateCcw />
            </Button>
          ) : (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={m.pinned ? 'Desafixar' : 'Fixar'}
                disabled={busy}
                onClick={() => void run(act.mutateAsync({ pinned: !m.pinned }))}
              >
                {m.pinned ? <PinOff /> : <Pin />}
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Editar" onClick={() => onEdit(m)}>
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Arquivar"
                disabled={busy}
                onClick={() => void run(act.mutateAsync({ action: 'archive' }), 'Arquivado.')}
              >
                <Archive />
              </Button>
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Apagar"
            disabled={busy}
            onClick={() => void run(del.mutateAsync(undefined), 'Apagado.')}
          >
            <Trash2 />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function MemoryTab() {
  const open = useMemories('open');
  const archived = useMemories('archived');
  const profile = useProfile();
  const [form, setForm] = useState<{ open: boolean; memory: MemoryDTO | null }>({
    open: false,
    memory: null,
  });
  const [wipe, setWipe] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const wipeAll = useApiMutation(() => ({ path: '/api/memories', method: 'DELETE' }));
  const setAuto = useApiMutation((memoryAuto: boolean) => ({
    path: '/api/profile',
    method: 'PUT',
    body: { memoryAuto },
  }));

  const items = open.data ?? [];
  const pending = items.filter((m) => m.status === 'pending' && m.mine);
  const active = items.filter((m) => m.status === 'active');
  const groups = MEMORY_CATEGORIES.map((c) => ({ c, list: active.filter((m) => m.category === c) })).filter(
    (g) => g.list.length,
  );
  const edit = (m: MemoryDTO) => setForm({ open: true, memory: m });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {pending.length ? (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-1.5">
                  <ShieldAlert className="size-4 text-warning" aria-hidden /> Aguardando sua confirmação
                </span>
              }
              description="Parece um dado sensível. Só uso depois que você confirmar."
            />
            <CardBody>
              <ul className="space-y-2">
                {pending.map((m) => (
                  <MemoryItem key={m.id} m={m} onEdit={edit} />
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader
            title="O que sei sobre você"
            description="Aprendo com as conversas e uso nas respostas e sugestões."
            actions={
              <Button size="sm" variant="outline" onClick={() => setForm({ open: true, memory: null })}>
                <Plus /> Anotar
              </Button>
            }
          />
          <CardBody>
            {open.isLoading ? (
              <Skeleton className="h-32" />
            ) : groups.length ? (
              <div className="space-y-4">
                {groups.map((g) => (
                  <section key={g.c} aria-label={MEMORY_CATEGORY_LABEL[g.c]}>
                    <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {MEMORY_CATEGORY_LABEL[g.c]}
                    </h3>
                    <ul className="space-y-2">
                      {g.list.map((m) => (
                        <MemoryItem key={m.id} m={m} onEdit={edit} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon={<Brain className="size-5" />}
                title="Ainda não sei nada sobre você"
                hint="Conte seus objetivos no chat ou anote aqui."
                prompt="Quero trocar de carro em 2027 e juntar uma reserva de 6 meses"
              />
            )}
            {(archived.data ?? []).length ? (
              <div className="mt-4">
                <Button size="sm" variant="link" onClick={() => setShowArchived(!showArchived)}>
                  {showArchived ? 'Ocultar arquivadas' : `Ver arquivadas (${archived.data!.length})`}
                </Button>
                {showArchived ? (
                  <ul className="mt-2 space-y-2">
                    {archived.data!.map((m) => (
                      <MemoryItem key={m.id} m={m} onEdit={edit} />
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>
      <Card className="h-fit">
        <CardHeader title="Sua privacidade" />
        <CardBody className="space-y-4 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>
              Memória automática
              <span className="block text-[12px] text-muted-foreground">
                Aprender com as conversas. Desligado, só guardo o que você pedir.
              </span>
            </span>
            <Switch
              checked={profile.data?.memoryAuto ?? true}
              disabled={!profile.data || setAuto.isPending}
              onCheckedChange={(v) =>
                void setAuto.mutateAsync(v).then(
                  () => toast.success(v ? 'Memória automática ligada.' : 'Memória automática desligada.'),
                  (err) => toast.error(errMsg(err)),
                )
              }
              aria-label="Memória automática"
            />
          </label>
          <p className="text-[12.5px] text-muted-foreground">
            Nunca guardo senhas, CPF ou número de cartão. Memórias pessoais só você vê. Tudo entra na
            exportação dos seus dados.
          </p>
          <Button
            variant="outline"
            className="w-full text-negative"
            disabled={!items.length}
            onClick={() => setWipe(true)}
          >
            <Trash2 /> Apagar toda a memória
          </Button>
        </CardBody>
      </Card>
      <MemoryForm
        open={form.open}
        memory={form.memory}
        onClose={() => setForm({ open: false, memory: null })}
      />
      <ConfirmDialog
        open={wipe}
        onOpenChange={setWipe}
        title="Apagar toda a memória?"
        description="O assistente esquece tudo o que aprendeu sobre você neste workspace. Não dá para desfazer."
        confirmLabel="Apagar tudo"
        danger
        busy={wipeAll.isPending}
        onConfirm={() =>
          void wipeAll.mutateAsync(undefined).then(
            () => {
              toast.success('Memória apagada.');
              setWipe(false);
            },
            (err) => toast.error(errMsg(err)),
          )
        }
      />
    </div>
  );
}

function Chips<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Record<K, string>;
  value: string[];
  onChange: (v: K[]) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {(Object.entries(options) as Array<[K, string]>).map(([k, l]) => {
        const on = value.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange((on ? value.filter((x) => x !== k) : [...value, k]) as K[])}
            className="rounded-full border px-3 py-1 text-[12.5px] text-muted-foreground transition-colors aria-pressed:border-primary aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-foreground"
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

const tri = (v: boolean | null) => (v === null ? '' : v ? 'sim' : 'nao');
const fromTri = (v: string) => (v === '' ? null : v === 'sim');

function ProfileTab() {
  const profile = useProfile();
  const usage = useAgentUsage();
  const [f, setF] = useState<FinancialProfileDTO | null>(null);
  useEffect(() => {
    if (profile.data) setF(profile.data);
  }, [profile.data]);
  const save = useApiMutation((p: FinancialProfileDTO) => ({
    path: '/api/profile',
    method: 'PUT',
    body: p as unknown as Record<string, unknown>,
  }));
  if (!f) return <Skeleton className="h-64" />;
  const sel = <T extends Record<string, string>>(
    id: string,
    label: string,
    options: T,
    value: string | null,
    set: (v: string | null) => void,
  ) => (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value ?? ''} onChange={(e) => set(e.target.value || null)}>
        <option value="">Não informado</option>
        {Object.entries(options).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
    </Field>
  );
  const submit = async () => {
    try {
      await save.mutateAsync(f);
      toast.success('Perfil salvo.');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader
          title="Perfil financeiro"
          description="Ajuda o assistente a propor metas e ações que façam sentido para você. Preencha o que quiser."
        />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {sel('p-stage', 'Fase de vida', LIFE_STAGES, f.lifeStage, (v) => setF({ ...f, lifeStage: v }))}
            <Field label="Dependentes" htmlFor="p-dep">
              <Input
                id="p-dep"
                type="number"
                min={0}
                max={20}
                value={f.dependents ?? ''}
                onChange={(e) =>
                  setF({ ...f, dependents: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </Field>
            {sel('p-income', 'Tipo de renda', INCOME_STABILITY, f.incomeStability, (v) =>
              setF({ ...f, incomeStability: v }),
            )}
            {sel('p-risk', 'Perfil de risco (autodeclarado)', RISK_SELF, f.riskSelf, (v) =>
              setF({ ...f, riskSelf: v }),
            )}
            <Field label="Tem veículo?" htmlFor="p-car">
              <Select
                id="p-car"
                value={tri(f.ownsVehicle)}
                onChange={(e) => setF({ ...f, ownsVehicle: fromTri(e.target.value) })}
              >
                <option value="">Não informado</option>
                <option value="sim">Sim</option>
                <option value="nao">Não</option>
              </Select>
            </Field>
            <Field label="Casa própria?" htmlFor="p-home">
              <Select
                id="p-home"
                value={tri(f.ownsHome)}
                onChange={(e) => setF({ ...f, ownsHome: fromTri(e.target.value) })}
              >
                <option value="">Não informado</option>
                <option value="sim">Sim</option>
                <option value="nao">Não</option>
              </Select>
            </Field>
            <Field label="Estado (UF)" htmlFor="p-uf">
              <Select
                id="p-uf"
                value={f.uf ?? ''}
                onChange={(e) => setF({ ...f, uf: e.target.value || null })}
              >
                <option value="">Não informado</option>
                {UFS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Objetivos</p>
            <Chips
              label="Objetivos"
              options={OBJECTIVES}
              value={f.objectives}
              onChange={(v) => setF({ ...f, objectives: v })}
            />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">O que acompanhar</p>
            <p className="mb-2 text-[12px] text-muted-foreground">
              Aviso quando algo mudar nesses temas. Só fatos e comparações com as suas metas, nunca
              recomendação de investimento.
            </p>
            <Chips
              label="O que acompanhar"
              options={INTERESTS}
              value={f.interests}
              onChange={(v) => setF({ ...f, interests: v })}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void submit()} disabled={save.isPending}>
              Salvar perfil
            </Button>
          </div>
        </CardBody>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Proatividade" description="Quando e por onde o assistente puxa conversa." />
        <CardBody className="space-y-4 text-sm">
          {sel('p-freq', 'Frequência de sugestões', NUDGE_FREQUENCY, f.nudgeFrequency, (v) =>
            setF({ ...f, nudgeFrequency: (v ?? 'normal') as FinancialProfileDTO['nudgeFrequency'] }),
          )}
          {(['whatsapp', 'web'] as const).map((ch) => (
            <label key={ch} className="flex items-center justify-between gap-3">
              <span>{ch === 'whatsapp' ? 'Pelo WhatsApp' : 'No app (caixa do assistente)'}</span>
              <Switch
                checked={f.nudgeChannels.includes(ch)}
                onCheckedChange={(v) =>
                  setF({
                    ...f,
                    nudgeChannels: v
                      ? [...new Set([...f.nudgeChannels, ch])]
                      : f.nudgeChannels.filter((x) => x !== ch),
                  })
                }
                aria-label={ch === 'whatsapp' ? 'Sugestões pelo WhatsApp' : 'Sugestões no app'}
              />
            </label>
          ))}
          <label className="flex items-center justify-between gap-3">
            <span>
              Perguntas estratégicas
              <span className="block text-[12px] text-muted-foreground">
                De vez em quando, uma pergunta para decidir algo.
              </span>
            </span>
            <Switch
              checked={f.questionsEnabled}
              onCheckedChange={(v) => setF({ ...f, questionsEnabled: v })}
              aria-label="Perguntas estratégicas"
            />
          </label>
          <p className="text-[12px] text-muted-foreground">Salve o perfil para aplicar.</p>
          <NudgeKinds />
          {usage.data ? (
            <p className="border-t pt-3 text-[12px] text-muted-foreground" data-testid="agent-usage">
              IA em segundo plano nesta semana: US$ {usage.data.weekUsd.toFixed(2).replace('.', ',')} de US${' '}
              {usage.data.weekLimitUsd.toFixed(2).replace('.', ',')}
              {usage.data.proactive !== 'full' ? ' (desligada no servidor)' : ''}.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

const RESPONSE_STATUS: Record<string, string> = {
  accepted: 'aceita',
  answered: 'respondida',
  dismissed: 'dispensada',
  snoozed: 'adiada',
  expired: 'expirou',
};

function InboxTab() {
  const open = useNudges('open');
  const history = useNudges('history');
  const invalidate = useInvalidateWorkspace();
  const [showHistory, setShowHistory] = useState(false);
  const [checking, setChecking] = useState(false);
  const started = useRef(false);
  // a caixa procura sugestões novas ao abrir (não espera o ciclo diário do worker)
  const check = async (manual = false) => {
    setChecking(true);
    try {
      const r = await api<{ created: number }>('/api/nudges/refresh', { method: 'POST', body: {} });
      if (manual) toast(r.created ? `${r.created} sugestão(ões) nova(s).` : 'Nada novo por enquanto.');
      void invalidate();
    } catch (err) {
      if (manual) toast.error(err instanceof Error ? err.message : 'Falhou.');
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div>
        {open.isLoading ? (
          <Skeleton className="h-40" />
        ) : (
          <NudgeList
            items={open.data ?? []}
            empty={
              <EmptyState
                icon={<Inbox className="size-5" />}
                title="Nada pendente agora"
                hint="Quando eu notar algo nas suas contas, metas ou no que você me contou, aparece aqui e, se quiser, no WhatsApp."
              />
            }
          />
        )}
        {(history.data ?? []).length ? (
          <div className="mt-5">
            <Button size="sm" variant="link" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? 'Ocultar histórico' : `Ver histórico (${history.data!.length})`}
            </Button>
            {showHistory ? (
              <ul className="mt-2 space-y-2" aria-label="Histórico de sugestões">
                {history.data!.map((n) => (
                  <li key={n.id} className="rounded-xl border px-3 py-2 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{n.title}</span>
                      <Badge
                        tone={n.status === 'accepted' || n.status === 'answered' ? 'positive' : 'neutral'}
                      >
                        {RESPONSE_STATUS[n.status] ?? n.status}
                        {n.responseLabel ? `: ${n.responseLabel}` : ''}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                      <WaText text={n.message} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <Card className="h-fit">
        <CardHeader title="Como funciona" />
        <CardBody className="space-y-3 text-[13px] text-muted-foreground">
          <p>
            Eu olho suas metas, a projeção, o calendário anual e o que você me contou, e sugiro ações. Nada é
            gravado sem a sua confirmação.
          </p>
          <p>
            No WhatsApp mando no máximo uma por dia, respeitando o horário silencioso. Responda{' '}
            <strong>depois</strong> para adiar ou <strong>parar</strong> para não receber aquele tipo.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={checking}
            onClick={() => void check(true)}
          >
            <RefreshCw className={cn(checking && 'animate-spin')} /> Procurar sugestões agora
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

const MUTABLE = [
  'meta',
  'reserva',
  'orcamento',
  'sazonal',
  'renda',
  'carteira',
  'memoria',
  'perfil',
] as const;

function NudgeKinds() {
  const mutes = useNudgeMutes();
  const toggle = useApiMutation((v: { kind: string; muted: boolean }) => ({
    path: '/api/nudges/mute',
    method: 'POST',
    body: v,
  }));
  const muted = new Set(mutes.data ?? []);
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="font-medium">Tipos de sugestão</p>
      {MUTABLE.map((c) => (
        <label key={c} className="flex items-center justify-between gap-3 text-[13px]">
          <span>{NUDGE_CATEGORY[c]}</span>
          <Switch
            checked={!muted.has(`cat:${c}`)}
            disabled={!mutes.data || toggle.isPending}
            onCheckedChange={(v) =>
              void toggle
                .mutateAsync({ kind: `cat:${c}`, muted: !v })
                .catch((err) => toast.error(errMsg(err)))
            }
            aria-label={`Sugestões de ${NUDGE_CATEGORY[c]}`}
          />
        </label>
      ))}
    </div>
  );
}

export function AssistantPage() {
  const [tab, setTab] = useState('caixa');
  const open = useNudges('open');
  const count = open.data?.length ?? 0;
  return (
    <div>
      <PageHeader
        title="Assistente"
        description="O que o assistente sabe sobre você e como ele te ajuda por conta própria."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Seções do assistente" className="mb-4">
          <TabsTrigger value="caixa">Caixa{count ? ` (${count})` : ''}</TabsTrigger>
          <TabsTrigger value="memoria">O que sei sobre você</TabsTrigger>
          <TabsTrigger value="perfil">Perfil e proatividade</TabsTrigger>
        </TabsList>
        <TabsContent value="caixa">
          <InboxTab />
        </TabsContent>
        <TabsContent value="memoria">
          <MemoryTab />
        </TabsContent>
        <TabsContent value="perfil">
          <ProfileTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
