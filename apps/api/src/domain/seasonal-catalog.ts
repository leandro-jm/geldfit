/**
 * Catálogo do calendário financeiro brasileiro: o que procurar no histórico e quando costuma cair.
 * Os padrões rodam sobre a descrição normalizada (normalizeDescription: sem acento, só [a-z0-9]).
 */
export interface CatalogEntry {
  key: string;
  label: string;
  kind: 'expense' | 'income';
  direction: 'in' | 'out';
  pattern: RegExp;
  leadDays: number;
  /** Mais meses com pagamento que isso numa temporada não é item anual (é gasto mensal). */
  maxMonths: number;
}

export const CATALOG: CatalogEntry[] = [
  {
    key: 'ipva',
    label: 'IPVA',
    kind: 'expense',
    direction: 'out',
    pattern: /\b(ipva|licenciamento)\b/,
    leadDays: 60,
    maxMonths: 6,
  },
  {
    key: 'iptu',
    label: 'IPTU',
    kind: 'expense',
    direction: 'out',
    pattern: /\biptu\b/,
    leadDays: 60,
    maxMonths: 11,
  },
  {
    key: 'matricula',
    label: 'Matrícula escolar',
    kind: 'expense',
    direction: 'out',
    pattern: /\b(matricula|rematricula)\b/,
    leadDays: 60,
    maxMonths: 3,
  },
  {
    key: 'material_escolar',
    label: 'Material escolar',
    kind: 'expense',
    direction: 'out',
    pattern: /\b(material escolar|lista escolar|uniforme escolar|livros? didaticos?)\b/,
    leadDays: 45,
    maxMonths: 3,
  },
  {
    key: 'decimo_terceiro',
    label: '13º salário',
    kind: 'income',
    direction: 'in',
    pattern: /\b(13 ?o? salario|decimo terceiro|gratificacao natalina|adiant\w* (do )?13|13o)\b/,
    leadDays: 30,
    maxMonths: 3,
  },
  {
    key: 'irpf',
    label: 'IRPF a pagar',
    kind: 'expense',
    direction: 'out',
    pattern: /\b(irpf|imposto de renda|darf 0211)\b/,
    leadDays: 60,
    maxMonths: 8,
  },
  {
    key: 'irpf_restituicao',
    label: 'Restituição do IR',
    kind: 'income',
    direction: 'in',
    pattern: /\b(restituicao|restit irpf|rest irpf)\b/,
    leadDays: 30,
    maxMonths: 2,
  },
];

export const CATALOG_BY_KEY = new Map(CATALOG.map((c) => [c.key, c]));

/** Recorrências cujo reajuste anual vale sugerir mesmo com um único degrau no histórico. */
export const ADJUSTABLE_RE =
  /\b(plano|saude|unimed|amil|hapvida|sulamerica|notredame|escola|colegio|mensalidade|faculdade|aluguel|condominio)\b/;

/** Salário com 13º (pró-labore não tem). */
export const SALARY_13_RE = /\b(salario|holerite|folha)\b/;

export const COME_COTAS = {
  key: 'come_cotas',
  label: 'Come-cotas',
  schedule: [
    { month: 5, day: 31, amountCents: 0 },
    { month: 11, day: 30, amountCents: 0 },
  ],
};
