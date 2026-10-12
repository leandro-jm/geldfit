import { createHash } from 'node:crypto';
import { normalizeDescription } from './ptbr.js';

/** dedupe_hash = sha256(conta ou cartão, data, valor, descrição normalizada). */
export function dedupeHash(input: {
  accountId?: string | null;
  cardId?: string | null;
  date: string;
  amountCents: number;
  direction: 'in' | 'out';
  description: string;
}): string {
  const owner = input.accountId ?? `card:${input.cardId ?? ''}`;
  const key = [
    owner,
    input.date,
    input.direction,
    input.amountCents,
    normalizeDescription(input.description),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
