/** Configurações de IA editáveis pela tela (admin). Valor salvo no banco > variável de ambiente > padrão. */

export type AiSettingGroup = 'llm' | 'transcribe' | 'voice';

export const CLAUDE_MODEL_SUGGESTIONS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

export interface AiSettingField {
  key: AiSettingKey;
  group: AiSettingGroup;
  label: string;
  hint?: string;
  secret?: boolean;
  kind: 'text' | 'url' | 'select';
  options?: string[];
  suggestions?: string[];
  /** Valor usado quando nem o banco nem o ambiente definem (só informativo na tela). */
  default?: string;
  /** Prefixos esperados da chave; fora deles a tela avisa, sem bloquear. */
  keyPrefixes?: string[];
}

export const AI_SETTING_KEYS = [
  'ANTHROPIC_API_KEY',
  'LLM_MODEL_SMALL',
  'LLM_MODEL_LARGE',
  'TRANSCRIBE_API_KEY',
  'TRANSCRIBE_URL',
  'TRANSCRIBE_MODEL',
  'VOICE_PROVIDER',
  'REALTIME_API_KEY',
  'REALTIME_URL',
  'REALTIME_MODEL',
  'REALTIME_VOICE',
  'REALTIME_TRANSCRIBE_MODEL',
  'LIVE_MODEL',
  'LIVE_VOICE',
] as const;
export type AiSettingKey = (typeof AI_SETTING_KEYS)[number];

export const AI_SETTING_FIELDS: AiSettingField[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    group: 'llm',
    label: 'Chave da API Anthropic',
    secret: true,
    kind: 'text',
    keyPrefixes: ['sk-ant-'],
  },
  {
    key: 'LLM_MODEL_SMALL',
    group: 'llm',
    label: 'Modelo pequeno',
    hint: 'Tarefas simples e em segundo plano: memória, avisos, mapeamento de CSV.',
    kind: 'text',
    suggestions: CLAUDE_MODEL_SUGGESTIONS,
    default: 'claude-haiku-5-5',
  },
  {
    key: 'LLM_MODEL_LARGE',
    group: 'llm',
    label: 'Modelo grande',
    hint: 'Conversas complexas e leitura de PDF/imagem.',
    kind: 'text',
    suggestions: CLAUDE_MODEL_SUGGESTIONS,
    default: 'claude-opus-5-5',
  },
  {
    key: 'TRANSCRIBE_API_KEY',
    group: 'transcribe',
    label: 'Chave da API de transcrição',
    hint: 'Pode ficar vazia num Whisper próprio sem autenticação.',
    secret: true,
    kind: 'text',
    keyPrefixes: ['sk-', 'gsk_'],
  },
  {
    key: 'TRANSCRIBE_URL',
    group: 'transcribe',
    label: 'URL do serviço',
    hint: 'Endpoint compatível com OpenAI (/audio/transcriptions).',
    kind: 'url',
    suggestions: ['https://api.openai.com/v1', 'https://api.groq.com/openai/v1'],
    default: 'https://api.openai.com/v1',
  },
  {
    key: 'TRANSCRIBE_MODEL',
    group: 'transcribe',
    label: 'Modelo de transcrição',
    kind: 'text',
    suggestions: ['whisper-1', 'gpt-4o-mini-transcribe', 'whisper-large-v3-turbo'],
    default: 'whisper-1',
  },
  {
    key: 'VOICE_PROVIDER',
    group: 'voice',
    label: 'Motor da conversa por voz',
    hint: 'realtime: o modelo de voz chama as ferramentas. live: a voz delega cada pedido ao chat.',
    kind: 'select',
    options: ['realtime', 'live'],
    default: 'realtime',
  },
  {
    key: 'REALTIME_API_KEY',
    group: 'voice',
    label: 'Chave da API OpenAI (voz)',
    hint: 'Vazia: reaproveita a chave da transcrição quando ela for da OpenAI.',
    secret: true,
    kind: 'text',
    keyPrefixes: ['sk-'],
  },
  {
    key: 'REALTIME_URL',
    group: 'voice',
    label: 'URL da API de voz',
    kind: 'url',
    default: 'https://api.openai.com/v1',
  },
  {
    key: 'REALTIME_MODEL',
    group: 'voice',
    label: 'Modelo realtime',
    kind: 'text',
    suggestions: ['gpt-realtime'],
    default: 'gpt-realtime',
  },
  {
    key: 'REALTIME_VOICE',
    group: 'voice',
    label: 'Voz (realtime)',
    kind: 'text',
    suggestions: ['marin', 'cedar', 'alloy', 'verse'],
    default: 'marin',
  },
  {
    key: 'REALTIME_TRANSCRIBE_MODEL',
    group: 'voice',
    label: 'Transcrição da fala (realtime)',
    kind: 'text',
    suggestions: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
    default: 'gpt-4o-mini-transcribe',
  },
  {
    key: 'LIVE_MODEL',
    group: 'voice',
    label: 'Modelo live',
    kind: 'text',
    suggestions: ['gpt-live-1'],
    default: 'gpt-live-1',
  },
  {
    key: 'LIVE_VOICE',
    group: 'voice',
    label: 'Voz (live)',
    hint: 'Vazia: voz padrão do modelo.',
    kind: 'text',
  },
];

export interface AiSettingValueDTO {
  key: AiSettingKey;
  /** Valor efetivo; sempre null em segredos (nunca saem da API). */
  value: string | null;
  isSet: boolean;
  /** Últimos 4 caracteres do segredo efetivo. */
  last4?: string;
  source: 'db' | 'env' | 'default';
}

export interface AiSettingsDTO {
  fields: AiSettingValueDTO[];
}

/** `null` (ou vazio) remove o valor salvo e volta para o .env/padrão. */
export type AiSettingsPatch = Partial<Record<AiSettingKey, string | null>>;

export interface AiTestResult {
  ok: boolean;
  provider: string;
  /** Modelos que responderam (pequeno e grande). */
  models?: string[];
  error?: string;
}
