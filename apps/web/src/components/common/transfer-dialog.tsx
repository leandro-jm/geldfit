import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { parseAmount, type Currency } from '@sf/shared';
import { useAccounts, useAction } from '@/lib/queries';
import { todayLocalISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';

const SYMBOL: Record<Currency, string> = { BRL: 'R$', USD: 'US$' };

/** Transferência entre contas do workspace: sai de uma conta e entra na outra (com câmbio entre moedas). */
export function TransferDialog({
  open,
  onClose,
  defaultFromAccountId,
  defaultToAccountId,
  defaultAmountCents,
  defaultDate,
  defaultDescription,
}: {
  open: boolean;
  onClose: () => void;
  defaultFromAccountId?: string | null;
  /** Pré-preenchimento (ex.: sugestão para cobrir uma conta que vai ficar negativa). */
  defaultToAccountId?: string | null;
  defaultAmountCents?: number | null;
  defaultDate?: string | null;
  defaultDescription?: string | null;
}) {
  const accounts = useAccounts();
  const list = useMemo(() => accounts.data ?? [], [accounts.data]);
  const action = useAction();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [date, setDate] = useState(todayLocalISO());
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    const from = list.find((a) => a.id === defaultFromAccountId) ?? list[0];
    setFromId(from?.id ?? '');
    const to = list.find((a) => a.id === defaultToAccountId && a.id !== from?.id);
    setToId(to?.id ?? list.find((a) => a.id !== from?.id)?.id ?? '');
    setAmount(defaultAmountCents ? (defaultAmountCents / 100).toFixed(2).replace('.', ',') : '');
    setToAmount('');
    setDate(defaultDate && defaultDate > todayLocalISO() ? defaultDate : todayLocalISO());
    setDescription(defaultDescription ?? '');
  }, [
    open,
    defaultFromAccountId,
    defaultToAccountId,
    defaultAmountCents,
    defaultDate,
    defaultDescription,
    list,
  ]);

  const from = list.find((a) => a.id === fromId);
  const to = list.find((a) => a.id === toId);
  const fx = Boolean(from && to && from.currency !== to.currency);
  const cents = parseAmount(amount);
  const toCents = parseAmount(toAmount);
  const valid = Boolean(from && to && from.id !== to.id && cents && (!fx || toCents) && date);

  const changeFrom = (id: string) => {
    setFromId(id);
    if (id === toId) setToId(list.find((a) => a.id !== id)?.id ?? '');
  };

  const submit = async () => {
    if (!valid || !from || !to || !cents) return;
    try {
      const r = await action.mutateAsync({
        kind: 'transfer',
        payload: {
          fromAccountId: from.id,
          toAccountId: to.id,
          amountCents: cents,
          ...(fx ? { toAmountCents: toCents } : {}),
          date,
          description: description.trim() || `Transferência ${from.name} → ${to.name}`,
          ...(date > todayLocalISO() ? { status: 'scheduled' } : {}),
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível registrar a transferência.');
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Transferir entre contas"
      description="Sai de uma conta e entra na outra. Não conta como receita nem despesa."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Transferir
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="De" htmlFor="tr-from">
            <Select id="tr-from" value={fromId} onChange={(e) => changeFrom(e.target.value)}>
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Para" htmlFor="tr-to">
            <Select id="tr-to" value={toId} onChange={(e) => setToId(e.target.value)}>
              {list
                .filter((a) => a.id !== fromId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Valor (${SYMBOL[from?.currency ?? 'BRL']})`} htmlFor="tr-amount">
            <Input
              id="tr-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Data" htmlFor="tr-date">
            <Input id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {fx && to ? (
          <Field
            label={`Valor recebido (${SYMBOL[to.currency]})`}
            htmlFor="tr-to-amount"
            hint="Moedas diferentes: informe quanto chegou na conta de destino."
          >
            <Input
              id="tr-to-amount"
              inputMode="decimal"
              value={toAmount}
              onChange={(e) => setToAmount(e.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Descrição" htmlFor="tr-desc">
          <Input
            id="tr-desc"
            value={description}
            maxLength={200}
            placeholder={from && to ? `Transferência ${from.name} → ${to.name}` : undefined}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </ResponsiveDialog>
  );
}
