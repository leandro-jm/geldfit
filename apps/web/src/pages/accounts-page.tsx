import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  CreditCard,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  formatBRL,
  formatDateBR,
  monthLabel,
  parseAmount,
  type AccountDTO,
  type CardDTO,
  type Currency,
} from '@sf/shared';
import { useAccounts, useAction, useCardStatements, useCards } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, relativeDays, todayLocalISO } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog, ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Money } from '@/components/common/money';
import { TransferDialog } from '@/components/common/transfer-dialog';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { CardUsage } from './dashboard/panels';

const TYPE_LABEL: Record<AccountDTO['type'], string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  investment: 'Investimento',
  cash: 'Dinheiro',
};
const CURRENCY_LABEL: Record<Currency, string> = { BRL: 'Real (R$)', USD: 'Dólar (US$)' };
const centsToInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

function AccountForm({
  account,
  open,
  onClose,
}: {
  account: AccountDTO | null;
  open: boolean;
  onClose: () => void;
}) {
  const action = useAction();
  const [f, setF] = useState({
    institution: '',
    name: '',
    type: 'checking' as AccountDTO['type'],
    currency: 'BRL' as Currency,
    opening: '0,00',
    openingDate: todayLocalISO(),
    isPrivate: false,
  });
  useEffect(() => {
    if (!open) return;
    setF(
      account
        ? {
            institution: account.institution,
            name: account.name,
            type: account.type,
            currency: account.currency,
            opening: centsToInput(account.openingBalanceCents),
            openingDate: account.openingDate,
            isPrivate: account.isPrivate,
          }
        : {
            institution: '',
            name: '',
            type: 'checking',
            currency: 'BRL',
            opening: '0,00',
            openingDate: todayLocalISO(),
            isPrivate: false,
          },
    );
  }, [open, account]);
  const cents = parseAmount(f.opening);
  const valid = f.institution.trim() && f.name.trim() && cents !== null;
  const currencyLocked = Boolean(account?.lastActivityDate);
  const submit = async () => {
    if (!valid) return;
    try {
      const r = await action.mutateAsync({
        kind: 'account',
        payload: {
          mode: account ? 'update' : 'create',
          id: account?.id ?? null,
          fields: {
            institution: f.institution.trim(),
            name: f.name.trim(),
            type: f.type,
            currency: f.currency,
            openingBalanceCents: cents,
            openingDate: f.openingDate,
            isPrivate: f.isPrivate,
          },
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.');
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={account ? 'Editar conta' : 'Nova conta'}
      description="Dica: pelo chat é só dizer “abri uma conta no BB com 5.000”."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Instituição" htmlFor="acc-inst">
          <Input
            id="acc-inst"
            value={f.institution}
            onChange={(e) => setF({ ...f, institution: e.target.value })}
            placeholder="Ex.: Banco do Brasil"
          />
        </Field>
        <Field label="Nome" htmlFor="acc-name">
          <Input
            id="acc-name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="Ex.: BB"
          />
        </Field>
        <Field label="Tipo" htmlFor="acc-type">
          <Select
            id="acc-type"
            value={f.type}
            onChange={(e) => setF({ ...f, type: e.target.value as AccountDTO['type'] })}
          >
            {Object.entries(TYPE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Moeda"
          htmlFor="acc-currency"
          hint={
            currencyLocked
              ? 'A conta já tem lançamentos; a moeda não pode mudar.'
              : 'Dólar para contas como Nomad, Wise, Avenue.'
          }
        >
          <Select
            id="acc-currency"
            value={f.currency}
            disabled={currencyLocked}
            onChange={(e) => setF({ ...f, currency: e.target.value as Currency })}
          >
            {Object.entries(CURRENCY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={`Saldo inicial (${f.currency === 'USD' ? 'US$' : 'R$'})`}
          htmlFor="acc-open"
          error={cents === null ? 'Valor inválido' : null}
        >
          <Input
            id="acc-open"
            inputMode="decimal"
            value={f.opening}
            onChange={(e) => setF({ ...f, opening: e.target.value })}
          />
        </Field>
        <Field label="Data do saldo inicial" htmlFor="acc-date">
          <Input
            id="acc-date"
            type="date"
            value={f.openingDate}
            onChange={(e) => setF({ ...f, openingDate: e.target.value })}
          />
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-xl border p-3 sm:col-span-2">
          <label htmlFor="acc-private" className="text-[13px]">
            <span className="font-medium">Conta privada</span>
            <span className="block text-muted-foreground">
              Só você vê esta conta; ela entra na sua projeção.
            </span>
          </label>
          <Switch
            id="acc-private"
            checked={f.isPrivate}
            onCheckedChange={(v) => setF({ ...f, isPrivate: v })}
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function CardForm({ card, open, onClose }: { card: CardDTO | null; open: boolean; onClose: () => void }) {
  const action = useAction();
  const accounts = useAccounts();
  const [f, setF] = useState({
    name: '',
    accountId: '',
    last4: '',
    holderTag: '',
    limit: '',
    closingDay: '5',
    dueDay: '12',
    isPrivate: false,
  });
  useEffect(() => {
    if (!open) return;
    setF(
      card
        ? {
            name: card.name,
            accountId: card.accountId ?? '',
            last4: card.last4 ?? '',
            holderTag: card.holderTag ?? '',
            limit: centsToInput(card.limitCents),
            closingDay: String(card.closingDay),
            dueDay: String(card.dueDay),
            isPrivate: card.isPrivate,
          }
        : {
            name: '',
            accountId: accounts.data?.find((a) => a.currency === 'BRL')?.id ?? '',
            last4: '',
            holderTag: '',
            limit: '',
            closingDay: '5',
            dueDay: '12',
            isPrivate: false,
          },
    );
  }, [open, card, accounts.data]);
  const limit = parseAmount(f.limit || '0');
  const cd = Number(f.closingDay);
  const dd = Number(f.dueDay);
  const valid =
    f.name.trim() &&
    limit !== null &&
    cd >= 1 &&
    cd <= 31 &&
    dd >= 1 &&
    dd <= 31 &&
    (!f.last4 || /^\d{4}$/.test(f.last4));
  const submit = async () => {
    if (!valid) return;
    try {
      const r = await action.mutateAsync({
        kind: 'card',
        payload: {
          mode: card ? 'update' : 'create',
          id: card?.id ?? null,
          fields: {
            name: f.name.trim(),
            accountId: f.accountId || null,
            last4: f.last4 || null,
            holderTag: f.holderTag.trim() || null,
            limitCents: limit,
            closingDay: cd,
            dueDay: dd,
            isPrivate: f.isPrivate,
          },
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.');
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={card ? 'Editar cartão' : 'Novo cartão'}
      description="Pelo chat: “cartão Santander fecha dia 5 e vence dia 12, limite 10 mil”."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Nome" htmlFor="card-name" className="col-span-2 sm:col-span-1">
          <Input
            id="card-name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="Ex.: Santander"
          />
        </Field>
        <Field label="Conta que paga a fatura" htmlFor="card-acc" className="col-span-2 sm:col-span-1">
          <Select
            id="card-acc"
            value={f.accountId}
            onChange={(e) => setF({ ...f, accountId: e.target.value })}
          >
            <option value="">Nenhuma</option>
            {/* A fatura é em reais: só conta em reais pode pagá-la */}
            {(accounts.data ?? [])
              .filter((a) => a.currency === 'BRL')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Limite (R$)" htmlFor="card-limit">
          <Input
            id="card-limit"
            inputMode="decimal"
            value={f.limit}
            onChange={(e) => setF({ ...f, limit: e.target.value })}
          />
        </Field>
        <Field
          label="Final do cartão"
          htmlFor="card-last4"
          error={f.last4 && !/^\d{4}$/.test(f.last4) ? '4 dígitos' : null}
        >
          <Input
            id="card-last4"
            inputMode="numeric"
            maxLength={4}
            value={f.last4}
            onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '') })}
          />
        </Field>
        <Field label="Dia do fechamento" htmlFor="card-close">
          <Input
            id="card-close"
            type="number"
            min={1}
            max={31}
            value={f.closingDay}
            onChange={(e) => setF({ ...f, closingDay: e.target.value })}
          />
        </Field>
        <Field label="Dia do vencimento" htmlFor="card-due">
          <Input
            id="card-due"
            type="number"
            min={1}
            max={31}
            value={f.dueDay}
            onChange={(e) => setF({ ...f, dueDay: e.target.value })}
          />
        </Field>
        <Field
          label="Titular (adicional)"
          htmlFor="card-holder"
          className="col-span-2"
          hint="Opcional — ex.: “Ana” para o cartão adicional dela."
        >
          <Input
            id="card-holder"
            value={f.holderTag}
            onChange={(e) => setF({ ...f, holderTag: e.target.value })}
          />
        </Field>
        <div className="col-span-2 flex items-center justify-between gap-3 rounded-xl border p-3">
          <label htmlFor="card-private" className="text-[13px] font-medium">
            Cartão privado
          </label>
          <Switch
            id="card-private"
            checked={f.isPrivate}
            onCheckedChange={(v) => setF({ ...f, isPrivate: v })}
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function Statements({ cardId }: { cardId: string }) {
  const q = useCardStatements(cardId);
  if (q.isPending) return <Skeleton className="h-24 w-full" />;
  if (q.error) return <ErrorState error={q.error} />;
  const sts = [...(q.data?.statements ?? [])].sort((a, b) => b.refMonth.localeCompare(a.refMonth));
  if (!sts.length) return <p className="text-[13px] text-muted-foreground">Nenhuma fatura ainda.</p>;
  return (
    <ul className="divide-y rounded-xl border">
      {sts.map((s) => {
        const items = (q.data?.items ?? []).filter((i) => i.cardStatementId === s.id);
        return (
          <li key={s.id}>
            <details className="group">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium capitalize">{monthLabel(s.refMonth, true)}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    fecha {formatDateBR(s.closingDate)} · vence {formatDateBR(s.dueDate)}
                  </span>
                </span>
                <Badge tone={s.status === 'paid' ? 'positive' : s.status === 'closed' ? 'warning' : 'accent'}>
                  {s.status === 'paid' ? 'paga' : s.status === 'closed' ? 'fechada' : 'aberta'}
                </Badge>
                <Money cents={s.totalCents} className="w-24 text-right font-medium" />
              </summary>
              <ul className="space-y-1 px-3 pb-3 pl-10 text-[12.5px]">
                {items.length === 0 ? <li className="text-muted-foreground">Sem lançamentos.</li> : null}
                {items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      <span className="tnum text-muted-foreground">{formatDateBR(i.date).slice(0, 5)}</span>{' '}
                      {i.description}
                      {i.installmentN ? (
                        <span className="text-muted-foreground">
                          {' '}
                          ({i.installmentN}/{i.installmentTotal})
                        </span>
                      ) : null}
                    </span>
                    <Money cents={i.amountCents} direction={i.direction} />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** Equivalente em reais de um valor em dólar, com a PTAX usada. */
export function FxNote({
  cents,
  fx,
  className,
}: {
  cents: number;
  fx: NonNullable<AccountDTO['fx']>;
  className?: string;
}) {
  return (
    <p className={cn('text-[12.5px] text-muted-foreground', className)}>
      ≈ <Money cents={cents} /> · PTAX{' '}
      {fx.rate.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} em{' '}
      {formatDateBR(fx.date).slice(0, 5)}
    </p>
  );
}

export function AccountsPage() {
  const accounts = useAccounts();
  const cards = useCards();
  const action = useAction();
  const { canWrite } = useWorkspace();
  const [accForm, setAccForm] = useState<{ open: boolean; account: AccountDTO | null }>({
    open: false,
    account: null,
  });
  const [cardForm, setCardForm] = useState<{ open: boolean; card: CardDTO | null }>({
    open: false,
    card: null,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ open: boolean; fromId: string | null }>({
    open: false,
    fromId: null,
  });
  const canTransfer = canWrite && (accounts.data?.length ?? 0) >= 2;
  const [del, setDel] = useState<{ entity: 'accounts' | 'cards'; id: string; name: string } | null>(null);
  const total = (accounts.data ?? []).reduce((s, a) => s + a.balanceBrlCents, 0);

  const doDelete = async () => {
    if (!del) return;
    try {
      const r = await action.mutateAsync({ kind: 'delete', payload: { entity: del.entity, ids: [del.id] } });
      toast.success(r.summary);
      setDel(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível excluir.');
    }
  };

  return (
    <div>
      <PageHeader title="Contas e Cartões" description="Saldos de hoje, faturas e limites." />

      <section aria-labelledby="accounts-h" className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="accounts-h" className="flex items-baseline gap-2 text-[15px] font-semibold">
            Contas <Money cents={total} className="text-[13px] font-normal text-muted-foreground" />
          </h2>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              {canTransfer ? (
                <Button size="sm" variant="outline" onClick={() => setTransfer({ open: true, fromId: null })}>
                  <ArrowLeftRight aria-hidden /> Transferir
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setAccForm({ open: true, account: null })}>
                <Plus aria-hidden /> Nova conta
              </Button>
            </div>
          ) : null}
        </div>
        {accounts.error ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : null}
        {accounts.isPending ? (
          <div className="grid gap-3 @min-[560px]:grid-cols-2 @min-[1000px]:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : accounts.data?.length === 0 ? (
          <EmptyState
            title="Nenhuma conta cadastrada"
            icon={<Wallet className="size-5" />}
            hint="Comece dizendo:"
            prompt="abri uma conta no BB com 5.000"
          />
        ) : (
          <ul className="grid gap-3 @min-[560px]:grid-cols-2 @min-[1000px]:grid-cols-3">
            {(accounts.data ?? []).map((a) => (
              <li key={a.id}>
                <Card className="flex h-full flex-col p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-[12px] font-semibold">
                      {a.institution.slice(0, 3).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="flex items-center gap-1.5 truncate text-[14px] font-semibold">
                        {a.name}
                        {a.isPrivate ? (
                          <Lock className="size-3.5 text-muted-foreground" aria-label="privada" />
                        ) : null}
                      </h3>
                      <p className="truncate text-[12.5px] text-muted-foreground">
                        {a.institution} · {TYPE_LABEL[a.type]}
                        {a.currency === 'USD' ? ' · em dólar' : ''}
                      </p>
                    </div>
                    {canWrite ? (
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Ações da conta ${a.name}`}>
                            <MoreVertical aria-hidden />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          {canTransfer ? (
                            <MenuItem onSelect={() => setTransfer({ open: true, fromId: a.id })}>
                              <ArrowLeftRight aria-hidden /> Transferir daqui
                            </MenuItem>
                          ) : null}
                          <MenuItem onSelect={() => setAccForm({ open: true, account: a })}>
                            <Pencil aria-hidden /> Editar
                          </MenuItem>
                          <MenuItem
                            onSelect={() => setDel({ entity: 'accounts', id: a.id, name: a.name })}
                            className="text-negative"
                          >
                            <Trash2 aria-hidden /> Excluir
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </div>
                  <Money
                    cents={a.balanceCents}
                    currency={a.currency}
                    tone={a.balanceCents < 0 ? 'negative' : undefined}
                    className="mt-4 block text-2xl font-semibold tracking-tight"
                  />
                  {a.fx ? <FxNote cents={a.balanceBrlCents} fx={a.fx} className="mt-0.5" /> : null}
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                    {a.lastActivityDate
                      ? `Último lançamento ${relativeDays(a.lastActivityDate)}`
                      : 'Sem lançamentos'}
                    {a.stale ? (
                      <Badge tone="warning">
                        <AlertTriangle aria-hidden /> sem lançamentos há 30+ dias
                      </Badge>
                    ) : null}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="cards-h">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="cards-h" className="text-[15px] font-semibold">
            Cartões
          </h2>
          {canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setCardForm({ open: true, card: null })}>
              <Plus aria-hidden /> Novo cartão
            </Button>
          ) : null}
        </div>
        {cards.isPending ? (
          <Skeleton className="h-32" />
        ) : cards.data?.length === 0 ? (
          <EmptyState
            title="Nenhum cartão cadastrado"
            icon={<CreditCard className="size-5" />}
            prompt="cartão Santander fecha dia 5 e vence dia 12, limite 10 mil"
          />
        ) : (
          <ul className="grid gap-3 @min-[900px]:grid-cols-2">
            {(cards.data ?? []).map((c) => (
              <li key={c.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <CardUsage card={c} />
                      <p className="mt-2 text-[12px] text-muted-foreground">
                        Fecha dia {c.closingDay} · vence dia {c.dueDay}
                        {c.holderTag ? ` · titular ${c.holderTag}` : ''} · limite {formatBRL(c.limitCents)}
                      </p>
                    </div>
                    {canWrite ? (
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Ações do cartão ${c.name}`}>
                            <MoreVertical aria-hidden />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setCardForm({ open: true, card: c })}>
                            <Pencil aria-hidden /> Editar
                          </MenuItem>
                          <MenuItem
                            onSelect={() => setDel({ entity: 'cards', id: c.id, name: c.name })}
                            className="text-negative"
                          >
                            <Trash2 aria-hidden /> Excluir
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 -ml-2"
                    aria-expanded={expanded === c.id}
                    onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                  >
                    <ChevronDown
                      className={cn('transition-transform', expanded === c.id && 'rotate-180')}
                      aria-hidden
                    />{' '}
                    Faturas e parcelas
                  </Button>
                  {expanded === c.id ? (
                    <div className="mt-2">
                      <Statements cardId={c.id} />
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AccountForm
        open={accForm.open}
        account={accForm.account}
        onClose={() => setAccForm({ open: false, account: null })}
      />
      <CardForm
        open={cardForm.open}
        card={cardForm.card}
        onClose={() => setCardForm({ open: false, card: null })}
      />
      <TransferDialog
        open={transfer.open}
        defaultFromAccountId={transfer.fromId}
        onClose={() => setTransfer({ open: false, fromId: null })}
      />
      <ConfirmDialog
        open={Boolean(del)}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Excluir ${del?.entity === 'cards' ? 'cartão' : 'conta'} “${del?.name ?? ''}”?`}
        description="Os lançamentos ligados a ela deixam de entrar na projeção. Dá para desfazer pelo chat (“desfaz”)."
        confirmLabel="Excluir"
        danger
        busy={action.isPending}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}
