import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatBRL, parseAmount } from '@sf/shared';
import { useAccounts, useAction, useCards, useCategories } from '@/lib/queries';
import { todayLocalISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/tabs';

interface Form {
  direction: 'in' | 'out';
  description: string;
  amount: string;
  date: string;
  source: string; // "acc:<id>" | "card:<id>"
  categoryId: string;
  installments: string;
}

/** Lançamento avulso pela tela: uma entrada ou saída numa conta, ou compra (à vista/parcelada) no cartão. */
export function NewTransactionDialog({
  open,
  onClose,
  defaultAccountId,
}: {
  open: boolean;
  onClose: () => void;
  defaultAccountId?: string | null;
}) {
  const accounts = useAccounts();
  const cards = useCards();
  const cats = useCategories();
  const action = useAction();
  const blank = (): Form => {
    const acc = accounts.data?.find((a) => a.id === defaultAccountId) ?? accounts.data?.[0];
    return {
      direction: 'out',
      description: '',
      amount: '',
      date: todayLocalISO(),
      source: acc ? `acc:${acc.id}` : cards.data?.[0] ? `card:${cards.data[0].id}` : '',
      categoryId: '',
      installments: '1',
    };
  };
  const [f, setF] = useState<Form>(blank);

  useEffect(() => {
    if (open) setF(blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultAccountId, accounts.data, cards.data]);

  const [kind, id] = f.source.split(':');
  const isCard = kind === 'card';
  const currency = isCard ? 'BRL' : (accounts.data?.find((a) => a.id === id)?.currency ?? 'BRL');
  const installments = isCard && f.direction === 'out' ? Number(f.installments) : 1;
  const cents = parseAmount(f.amount);
  const valid = Boolean(f.description.trim() && cents && cents > 0 && id && f.date);
  const catList = (cats.data ?? []).filter((c) => c.kind === (f.direction === 'in' ? 'income' : 'expense'));

  const submit = async (another = false) => {
    if (!valid || !cents) return;
    try {
      const r = await action.mutateAsync({
        kind: 'transactions',
        payload: {
          source: 'manual',
          items: [
            {
              accountId: isCard ? null : id,
              cardId: isCard ? id : null,
              direction: f.direction,
              description: f.description.trim(),
              amountCents: cents,
              date: f.date,
              categoryId: f.categoryId || null,
              ...(installments > 1 ? { installments } : {}),
            },
          ],
        },
      });
      toast.success(r.summary, { description: r.impact ?? undefined });
      if (another) setF({ ...f, description: '', amount: '', categoryId: '', installments: '1' });
      else onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível registrar o lançamento.');
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Novo lançamento"
      description="Pelo chat também dá: “paguei 230 de luz no BB hoje”."
      footer={
        <>
          <Button variant="outline" onClick={() => void submit(true)} disabled={!valid || action.isPending}>
            Salvar e lançar outro
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || action.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="col-span-2">
          <Segmented
            label="Tipo"
            value={f.direction}
            onChange={(v) => setF({ ...f, direction: v, categoryId: '' })}
            options={[
              { value: 'out', label: 'Saída' },
              { value: 'in', label: 'Entrada' },
            ]}
          />
        </div>
        <Field label="Descrição" htmlFor="nt-desc" className="col-span-2">
          <Input
            id="nt-desc"
            value={f.description}
            maxLength={200}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            placeholder={f.direction === 'out' ? 'Ex.: Mercado Extra' : 'Ex.: Freela site'}
            autoFocus
          />
        </Field>
        <Field
          label={`${installments > 1 ? 'Valor total' : 'Valor'} (${currency === 'USD' ? 'US$' : 'R$'})`}
          htmlFor="nt-amount"
        >
          <Input
            id="nt-amount"
            inputMode="decimal"
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
        <Field label="Data" htmlFor="nt-date">
          <Input
            id="nt-date"
            type="date"
            value={f.date}
            onChange={(e) => setF({ ...f, date: e.target.value })}
          />
        </Field>
        <Field label="Conta ou cartão" htmlFor="nt-src" className="col-span-2 sm:col-span-1">
          <Select
            id="nt-src"
            value={f.source}
            onChange={(e) => setF({ ...f, source: e.target.value, installments: '1' })}
          >
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={`acc:${a.id}`}>
                {a.name}
              </option>
            ))}
            {(cards.data ?? []).map((c) => (
              <option key={c.id} value={`card:${c.id}`}>
                Cartão {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria" htmlFor="nt-cat" className="col-span-2 sm:col-span-1">
          <Select
            id="nt-cat"
            value={f.categoryId}
            onChange={(e) => setF({ ...f, categoryId: e.target.value })}
          >
            <option value="">Automática (pela descrição)</option>
            {catList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {isCard && f.direction === 'out' ? (
          <Field
            label="Parcelas"
            htmlFor="nt-inst"
            className="col-span-2 sm:col-span-1"
            hint={
              installments > 1 && cents
                ? `${installments}x de ~${formatBRL(Math.round(cents / installments))}, a partir da fatura da data`
                : undefined
            }
          >
            <Select
              id="nt-inst"
              value={f.installments}
              onChange={(e) => setF({ ...f, installments: e.target.value })}
            >
              {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? 'À vista' : `${n}x`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </ResponsiveDialog>
  );
}
