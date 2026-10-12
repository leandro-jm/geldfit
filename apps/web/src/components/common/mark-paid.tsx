import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatBRL, parseAmount, type UpcomingItem } from '@sf/shared';
import { useAccounts, useAction } from '@/lib/queries';
import { todayLocalISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';

/** "Marcar como pago": lançamento agendado → mark_paid; fatura → card_payment (pede a conta pagadora). */
export function useMarkPaid() {
  const action = useAction();
  const [statement, setStatement] = useState<UpcomingItem | null>(null);

  const markPaid = async (item: UpcomingItem) => {
    if (item.kind === 'statement') {
      setStatement(item);
      return;
    }
    try {
      const r = await action.mutateAsync({
        kind: 'mark_paid',
        payload: { transactionId: item.id, date: todayLocalISO() },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível marcar como pago.');
    }
  };

  const dialog = <StatementPaymentDialog item={statement} onClose={() => setStatement(null)} />;
  return { markPaid, dialog, pending: action.isPending };
}

function StatementPaymentDialog({ item, onClose }: { item: UpcomingItem | null; onClose: () => void }) {
  const accounts = useAccounts();
  const action = useAction();
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayLocalISO());

  useEffect(() => {
    if (!item) return;
    const match = accounts.data?.find((a) => a.id === item.accountId) ?? accounts.data?.[0];
    setAccountId(match?.id ?? '');
    setAmount((item.amountCents / 100).toFixed(2).replace('.', ','));
    setDate(todayLocalISO());
  }, [item, accounts.data]);

  const cents = parseAmount(amount);
  const submit = async () => {
    if (!item || !cents || !accountId) return;
    try {
      const r = await action.mutateAsync({
        kind: 'card_payment',
        payload: { statementId: item.id, accountId, amountCents: cents, date },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível registrar o pagamento.');
    }
  };

  return (
    <ResponsiveDialog
      open={Boolean(item)}
      onOpenChange={(o) => !o && onClose()}
      title={`Pagar ${item?.description ?? 'fatura'}`}
      description={item ? `Valor em aberto: ${formatBRL(item.amountCents)}` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!cents || !accountId || action.isPending}>
            Registrar pagamento
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Conta pagadora" htmlFor="pay-account">
          <Select id="pay-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)" htmlFor="pay-amount">
            <Input
              id="pay-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Data" htmlFor="pay-date">
            <Input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
