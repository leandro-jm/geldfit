import { fold, normalizeDescription } from '@sf/shared';
import type { Tx } from '@sf/db';
import { AppError } from '../lib/errors.js';

/** Apelidos comuns de instituições, para resolver "no BB", "no Santander". */
const ALIASES: Record<string, string[]> = {
  'banco do brasil': ['bb', 'banco do brasil', 'brasil'],
  'caixa economica federal': ['caixa', 'cef'],
  itau: ['itau', 'itau unibanco'],
  bradesco: ['bradesco'],
  santander: ['santander', 'san'],
  nubank: ['nubank', 'nu', 'roxinho'],
  inter: ['inter', 'banco inter'],
  cresol: ['cresol'],
  sicoob: ['sicoob'],
  sicredi: ['sicredi'],
  'c6 bank': ['c6', 'c6 bank'],
  'mercado pago': ['mercado pago', 'mp'],
  xp: ['xp', 'xp investimentos'],
  btg: ['btg', 'btg pactual'],
  picpay: ['picpay'],
};

function tokensFor(name: string, institution: string): string[] {
  const out = new Set<string>([
    fold(name),
    fold(institution),
    normalizeDescription(name),
    normalizeDescription(institution),
  ]);
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (out.has(canonical) || aliases.some((a) => out.has(a)))
      aliases.concat(canonical).forEach((a) => out.add(a));
  }
  return [...out].filter(Boolean);
}

export class AmbiguityError extends AppError {
  constructor(
    message: string,
    readonly options: string[],
  ) {
    super(409, message, 'ambiguous', { options });
  }
}

interface Named {
  id: string;
  name: string;
  institution?: string | null;
}

function pick<T extends Named>(items: T[], hint: string | null | undefined, what: string): T {
  if (hint && /^[0-9a-f-]{36}$/.test(hint)) {
    const byId = items.find((i) => i.id === hint);
    if (byId) return byId;
  }
  if (!hint) {
    if (items.length === 1) return items[0]!;
    if (items.length === 0)
      throw new AppError(422, `Nenhum(a) ${what} cadastrado(a). Cadastre antes de lançar.`, 'missing');
    throw new AmbiguityError(
      `Em qual ${what}?`,
      items.map((i) => i.name),
    );
  }
  const h = normalizeDescription(hint.replace(/^(conta|cartao|cartão)\s+/i, ''));
  const exact = items.filter((i) => tokensFor(i.name, i.institution ?? '').includes(h));
  if (exact.length === 1) return exact[0]!;
  const partial = (exact.length ? exact : items).filter((i) =>
    tokensFor(i.name, i.institution ?? '').some(
      (t) => t.includes(h) || (h.length >= 3 && h.includes(t) && t.length >= 2),
    ),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1)
    throw new AmbiguityError(
      `Encontrei mais de um(a) ${what} para "${hint}". Qual deles?`,
      partial.map((i) => i.name),
    );
  throw new AppError(
    422,
    `Não encontrei ${what} "${hint}". Opções: ${items.map((i) => i.name).join(', ') || 'nenhuma'}.`,
    'not_found',
  );
}

export async function resolveAccount(tx: Tx, ws: string, hint: string | null | undefined) {
  const accounts = await tx
    .selectFrom('accounts')
    .select(['id', 'name', 'institution', 'type'])
    .where('workspaceId', '=', ws)
    .where('archivedAt', 'is', null)
    .execute();
  return pick(accounts, hint, 'conta');
}

export async function resolveCard(tx: Tx, ws: string, hint: string | null | undefined) {
  const cards = await tx
    .selectFrom('cards')
    .select(['id', 'name', 'closingDay', 'dueDay', 'accountId', 'limitCents'])
    .where('workspaceId', '=', ws)
    .where('archivedAt', 'is', null)
    .execute();
  return pick(
    cards.map((c) => ({ ...c, institution: c.name })),
    hint,
    'cartão',
  );
}

/** Palavras-chave → categoria padrão (usadas quando não há regra aprendida). */
const KEYWORDS: Array<[RegExp, string]> = [
  [/\b(luz|energia|cemig|copel|celesc|enel|eletricidade)\b/, 'Energia'],
  [/\b(agua|saneamento|sabesp|casan|corsan)\b/, 'Água'],
  [/\b(internet|telefone|celular|claro|vivo|tim|oi)\b/, 'Internet e telefone'],
  [/\b(mercado|supermercado|atacad|hortifruti|feira|padaria|acougue)\b/, 'Mercado'],
  [/\b(restaurante|lanche|ifood|pizza|bar|cafe|almoco|jantar)\b/, 'Restaurantes'],
  [/\b(uber|99|onibus|metro|estacionamento|pedagio|taxi)\b/, 'Transporte'],
  [/\b(gasolina|combustivel|posto|etanol|diesel)\b/, 'Combustível'],
  [/\b(farmacia|drogaria|remedio|medicamento)\b/, 'Farmácia'],
  [/\b(medico|consulta|exame|hospital|plano de saude|dentista|unimed)\b/, 'Saúde'],
  [/\b(escola|faculdade|curso|mensalidade escolar|livro)\b/, 'Educação'],
  [/\b(netflix|spotify|prime|disney|hbo|assinatura|youtube|icloud|google one)\b/, 'Assinaturas'],
  [/\b(aluguel)\b/, 'Aluguel'],
  [/\b(condominio|iptu|moradia)\b/, 'Moradia'],
  [/\b(tv|televisao|notebook|celular novo|eletronico|computador|fone)\b/, 'Eletrônicos'],
  [/\b(roupa|calcado|tenis|vestuario)\b/, 'Vestuário'],
  [/\b(viagem|passagem|hotel|airbnb)\b/, 'Viagem'],
  [/\b(pet|racao|veterinario)\b/, 'Pets'],
  [/\b(seguro)\b/, 'Seguros'],
  [/\b(previdencia|previsc)\b/, 'Previdência'],
  [/\b(salario|pagamento empresa|folha)\b/, 'Salário'],
  [/\b(freela|freelance|bico|extra)\b/, 'Renda extra'],
  [/\b(rendimento|juros|dividendo)\b/, 'Rendimentos'],
  [/\b(reembolso|estorno)\b/, 'Reembolso'],
];

export async function resolveCategory(
  tx: Tx,
  ws: string,
  input: { hint?: string | null; description: string; direction: 'in' | 'out' },
): Promise<{ id: string; name: string; source: 'explicit' | 'rule' | 'keyword' | 'default' }> {
  const kind = input.direction === 'in' ? 'income' : 'expense';
  const cats = await tx
    .selectFrom('categories')
    .select(['id', 'name', 'kind'])
    .where('workspaceId', '=', ws)
    .execute();
  const ofKind = cats.filter((c) => c.kind === kind);
  if (input.hint) {
    const h = normalizeDescription(input.hint);
    const hit =
      ofKind.find((c) => normalizeDescription(c.name) === h) ??
      ofKind.find(
        (c) => normalizeDescription(c.name).includes(h) || h.includes(normalizeDescription(c.name)),
      );
    if (hit) return { id: hit.id, name: hit.name, source: 'explicit' };
  }
  const desc = normalizeDescription(input.description);
  if (desc) {
    const rules = await tx
      .selectFrom('categorizationRules as r')
      .innerJoin('categories as c', 'c.id', 'r.categoryId')
      .select(['r.pattern', 'c.id', 'c.name', 'c.kind'])
      .where('r.workspaceId', '=', ws)
      .orderBy('r.hits', 'desc')
      .execute();
    const rule = rules.find((r) => r.kind === kind && ` ${desc} `.includes(` ${r.pattern} `));
    if (rule) return { id: rule.id, name: rule.name, source: 'rule' };
    for (const [re, name] of KEYWORDS) {
      if (re.test(desc)) {
        const c = ofKind.find((x) => x.name === name);
        if (c) return { id: c.id, name: c.name, source: 'keyword' };
      }
    }
  }
  const fallback =
    ofKind.find((c) => c.name === (kind === 'income' ? 'Outras receitas' : 'Outras despesas')) ?? ofKind[0];
  if (!fallback) throw new AppError(500, 'Workspace sem categorias.');
  return { id: fallback.id, name: fallback.name, source: 'default' };
}
