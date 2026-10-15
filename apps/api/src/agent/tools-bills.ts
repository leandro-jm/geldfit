import { z } from 'zod';
import { formatBRL, formatDateBR, parsePaymentCode, type DraftPreview, type PaymentCode } from '@sf/shared';
import { dedupeHash } from '@sf/shared/node';
import { AppError } from '../lib/errors.js';
import { createDraft } from '../domain/drafts.js';
import { findDuplicates } from '../domain/ledger.js';
import { resolveAccount, resolveCategory } from '../domain/resolve.js';
import { amountInput, dateInput, defineTool, toCents, toDate, type ToolCtx } from './tool-kit.js';

/** O que se sabe de uma conta a pagar (vindo de código digitado ou de um documento lido). */
export interface BillFacts {
  code: PaymentCode | null;
  amountCents: number | null;
  dueDate: string | null;
  payee: string | null;
  description?: string | null;
  account?: string | null;
  category?: string | null;
  attachmentId?: string | null;
  warnings?: string[];
}

/** Descrição padrão. `payee` é o beneficiário lido do documento (o código só traz banco/segmento). */
function describe(code: PaymentCode | null, payee: string | null): string {
  const tail = code?.barcode ? ` · final ${code.barcode.slice(-4)}` : '';
  if (code?.kind === 'pix') return `Pix ${code.payee ?? payee ?? 'cobrança'}`;
  if (code?.kind === 'convenio') {
    const segment = (code.payee ?? 'consumo').toLowerCase();
    return `${payee ? `${payee} (${segment})` : `Conta de ${segment}`}${tail}`;
  }
  return `Boleto ${payee ?? code?.payee ?? ''}`.trim() + tail;
}

/**
 * Agenda uma conta a pagar (lançamento "scheduled" na data de vencimento). A partir daí ela entra
 * na projeção, em "Próximos vencimentos" e nos lembretes D-3/D-1/D0 com "responda sim".
 * O app não paga nada: só registra o compromisso.
 */
export async function emitBillDraft(ctx: ToolCtx, f: BillFacts) {
  const ws = ctx.actor.workspaceId;
  const amountCents = f.amountCents ?? f.code?.amountCents ?? null;
  if (!amountCents)
    throw new AppError(422, 'O código não traz o valor. Qual é o valor a pagar?', 'missing_amount');
  const due = f.dueDate ?? f.code?.dueDate ?? null;
  if (!due)
    throw new AppError(
      422,
      `Li ${formatBRL(amountCents)}${f.code?.payee ? ` (${f.code.payee})` : ''}, mas o código não traz o vencimento. Qual é a data?`,
      'missing_due_date',
    );
  const acc = await resolveAccount(ctx.tx, ws, f.account);
  if (acc.currency !== 'BRL')
    throw new AppError(
      422,
      `Boletos e Pix são em reais; ${acc.name} é uma conta em dólar. De qual conta sai?`,
    );
  const warnings = [...(f.warnings ?? [])];
  const overdue = due < ctx.today;
  if (overdue) warnings.push(`Venceu em ${formatDateBR(due)}: agendei para hoje. Pode haver juros e multa.`);
  if (f.code?.kind === 'pix' && f.code.dynamic)
    warnings.push('Pix de cobrança: o valor final pode mudar no app do banco.');
  const date = overdue ? ctx.today : due;
  const description = (f.description?.trim() || describe(f.code, f.payee)).slice(0, 200);
  const cat = await resolveCategory(ctx.tx, ws, { hint: f.category, description, direction: 'out' });
  const hash = dedupeHash({
    accountId: acc.id,
    cardId: null,
    date,
    amountCents,
    direction: 'out',
    description,
  });
  const duplicate = (await findDuplicates(ctx.tx, ws, [hash])).size > 0;
  if (duplicate) warnings.push('Esta conta já está agendada com o mesmo valor e vencimento.');

  const preview: DraftPreview = {
    title: `Conta a pagar: ${description}`,
    summary: `${formatBRL(amountCents)} · vence ${formatDateBR(due)} · ${acc.name} · ${cat.name}`,
    lines: [
      { label: 'Lembretes', value: '3 dias antes, na véspera e no dia' },
      ...(f.code?.kind === 'pix' && f.code.city
        ? [{ label: 'Cidade do recebedor', value: f.code.city }]
        : []),
    ],
    items: [
      {
        date,
        description,
        amountCents,
        currency: 'BRL',
        direction: 'out',
        category: cat.name,
        duplicate,
        note: `agendado · ${acc.name}`,
      },
    ],
    warnings,
  };
  const draft = await createDraft(
    ctx.tx,
    ctx.actor,
    'transactions',
    {
      items: [
        {
          accountId: acc.id,
          date,
          amountCents,
          direction: 'out',
          categoryId: cat.id,
          description,
          status: 'scheduled',
          attachmentId: f.attachmentId ?? null,
        },
      ],
    },
    preview,
    ctx.conversationId,
  );
  ctx.emitDraft(draft);
  return {
    draft_id: draft.id,
    status: 'aguardando confirmação do usuário',
    preview: {
      title: preview.title,
      summary: preview.summary,
      warnings,
      projection_impact: draft.preview.projectionImpact ?? null,
    },
    instruction:
      'Mostre a prévia em uma frase e peça confirmação. Diga que você vai lembrar do vencimento; o app não faz o pagamento.',
  };
}

export const draftBillTool = defineTool({
  name: 'draft_bill',
  description:
    'Agenda uma conta a pagar a partir de linha digitável/código de barras de boleto ou de Pix copia e cola colado pelo usuário. Lê valor, vencimento e banco/recebedor do próprio código (dígitos verificadores conferidos) e cria lembretes de vencimento. Não paga nada.',
  kind: 'draft',
  schema: z.object({
    code: z
      .string()
      .min(20)
      .describe('O código exatamente como o usuário enviou (pode ter pontos, espaços e texto em volta)'),
    account: z.string().nullish().describe('Conta de onde vai sair o pagamento'),
    amount: amountInput
      .nullish()
      .describe('Só quando o código não traz valor (Pix sem valor, boleto de valor livre)'),
    due_date: dateInput.nullish().describe('Só quando o código não traz vencimento (contas de consumo, Pix)'),
    description: z.string().nullish(),
    category: z.string().nullish(),
  }),
  async run(ctx, input) {
    const r = parsePaymentCode(input.code, ctx.today);
    if (!r.ok) throw new AppError(422, r.error, 'invalid_code');
    return emitBillDraft(ctx, {
      code: r.code,
      amountCents: input.amount ? toCents(input.amount) : null,
      dueDate: input.due_date ? toDate(input.due_date, ctx.today, { future: true }) : null,
      payee: null,
      description: input.description,
      account: input.account,
      category: input.category,
    });
  },
});
