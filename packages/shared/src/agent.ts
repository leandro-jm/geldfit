/** Catálogos do agente proativo (memória e perfil financeiro), com rótulos pt-BR. */

export const MEMORY_CATEGORIES = [
  'objetivo',
  'compromisso',
  'familia',
  'renda',
  'preferencia',
  'restricao',
  'perfil',
  'contexto',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABEL: Record<MemoryCategory, string> = {
  objetivo: 'Objetivos',
  compromisso: 'Compromissos',
  familia: 'Família',
  renda: 'Renda e trabalho',
  preferencia: 'Preferências',
  restricao: 'Restrições',
  perfil: 'Perfil',
  contexto: 'Contexto',
};

export const MEMORY_STATUSES = ['active', 'pending', 'archived', 'rejected'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const LIFE_STAGES = {
  estudante: 'Estudante',
  inicio_carreira: 'Início de carreira',
  familia_formando: 'Formando família',
  familia_filhos: 'Família com filhos',
  pre_aposentadoria: 'Perto de aposentar',
  aposentado: 'Aposentado(a)',
} as const;
export type LifeStage = keyof typeof LIFE_STAGES;

export const INCOME_STABILITY = {
  clt: 'CLT',
  servidor: 'Servidor público',
  autonomo: 'Autônomo',
  empresario: 'Empresário',
  aposentado: 'Aposentado(a)',
  misto: 'Misto',
} as const;
export type IncomeStability = keyof typeof INCOME_STABILITY;

export const RISK_SELF = {
  conservador: 'Conservador',
  moderado: 'Moderado',
  arrojado: 'Arrojado',
} as const;
export type RiskSelf = keyof typeof RISK_SELF;

export const OBJECTIVES = {
  reserva: 'Montar reserva de emergência',
  quitar_dividas: 'Quitar dívidas',
  casa_propria: 'Casa própria',
  carro: 'Trocar ou comprar carro',
  viagem: 'Viajar',
  estudos: 'Estudos (meus ou dos filhos)',
  aposentadoria: 'Aposentadoria',
  independencia: 'Independência financeira',
  negocio: 'Abrir um negócio',
  organizar: 'Organizar as contas',
} as const;
export type Objective = keyof typeof OBJECTIVES;

/** Temas que o agente acompanha no mercado e nas regras (Fases 3 e 4). */
export const INTERESTS = {
  selic: 'Selic e juros',
  ipca: 'Inflação (IPCA)',
  tesouro: 'Tesouro Direto',
  dolar: 'Dólar',
  carteira: 'Minha carteira',
  ir: 'Imposto de renda',
  inss: 'INSS',
  fgts: 'FGTS',
  previdencia: 'Previdência privada',
  tarifas: 'Tarifas bancárias',
} as const;
export type Interest = keyof typeof INTERESTS;

export const NUDGE_FREQUENCY = {
  off: 'Desligado',
  baixa: 'Baixa (1 por semana)',
  normal: 'Normal (até 3 por semana)',
  alta: 'Alta (até 1 por dia)',
} as const;
export type NudgeFrequency = keyof typeof NUDGE_FREQUENCY;
export const NUDGES_PER_WEEK: Record<NudgeFrequency, number> = { off: 0, baixa: 1, normal: 3, alta: 7 };

export const UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;

/** Slug estável para a chave de uma memória ("Trocar de carro" → "objetivo.trocar_de_carro"). */
export function memoryKey(category: string, text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `${category}.${slug || 'item'}`;
}
