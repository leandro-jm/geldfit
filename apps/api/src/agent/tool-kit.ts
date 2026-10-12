import { z } from 'zod';
import { parseAmount, parseMonth, parseRelativeDate, type DraftDTO } from '@sf/shared';
import type { Tx } from '@sf/db';
import type { Actor, AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';

export interface ToolCtx {
  tx: Tx;
  actor: Actor;
  app: AppContext;
  conversationId: string;
  today: string;
  /** Anexos enviados nesta mensagem (ids). */
  attachmentIds: string[];
  emitDraft(d: DraftDTO): void;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  kind: 'read' | 'draft';
  /** Ferramentas que precisam do modelo grande (documentos, análises). */
  heavy?: boolean;
  run(ctx: ToolCtx, input: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(t: AgentTool<S>): AgentTool<S> {
  return t;
}

// Entradas tolerantes: o modelo pode mandar "2,3k", 230 ou "duzentos e trinta"
export const amountInput = z
  .union([z.number(), z.string()])
  .describe('Valor em reais: número (230.5) ou texto pt-BR ("2,3k", "1.234,56", "duzentos e trinta")');
export const dateInput = z
  .string()
  .describe('Data ISO (AAAA-MM-DD) ou relativa em pt-BR ("hoje", "ontem", "dia 5", "05/10")');
export const monthInput = z.string().describe('Mês: AAAA-MM, "março", "dezembro de 2027", "mês que vem"');

export function toCents(v: string | number | null | undefined, field = 'valor'): number {
  if (v === null || v === undefined || v === '') throw new AppError(422, `Faltou o ${field}.`, 'missing');
  const c = parseAmount(v);
  if (c === null || !Number.isFinite(c)) throw new AppError(422, `Não entendi o ${field} "${v}".`, 'invalid');
  if (c <= 0) throw new AppError(422, `O ${field} precisa ser maior que zero.`, 'invalid');
  return c;
}

export function toDate(
  v: string | null | undefined,
  today: string,
  opts: { future?: boolean; field?: string } = {},
): string {
  if (!v) return today;
  const d = parseRelativeDate(v, today, { future: opts.future });
  if (!d) throw new AppError(422, `Não entendi a data "${v}".`, 'invalid');
  return d;
}

export function toMonth(v: string | null | undefined, today: string): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(v)) return `${v.slice(0, 7)}-01`;
  const m = parseMonth(v, today);
  if (!m) throw new AppError(422, `Não entendi o mês "${v}".`, 'invalid');
  return m;
}
