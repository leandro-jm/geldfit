import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
  BETTER_AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  FILES_DIR: z.string().default('./data/files'),
  FILES_ENCRYPTION_KEY: z
    .string()
    .min(40, 'FILES_ENCRYPTION_KEY: 32 bytes em base64 (openssl rand -base64 32)'),
  FILES_URL_SECRET: z.string().min(16),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** TLS direto (porta 465). Na 587 o STARTTLS é negociado automaticamente. */
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  SMTP_FROM: z.string().default('Saúde Financeira <nao-responda@localhost>'),
  /** E-mails (separados por vírgula) que podem editar as configurações globais, como as chaves de IA. */
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  LLM_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  // Chaves e modelos de IA: estes valores são o fallback; o admin pode sobrescrevê-los na tela
  // de Configurações (tabela app_settings), sem reiniciar.
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL_SMALL: z.string().default('claude-haiku-5-5'),
  LLM_MODEL_LARGE: z.string().default('claude-opus-5-5'),
  TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  /** Custo do provedor de transcrição em US$ por minuto (só para o registro de custo). */
  TRANSCRIBE_USD_PER_MIN: z.coerce.number().default(0.006),
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_URL: z.string().optional(),
  /** Conversa por voz (OpenAI Realtime). Sem chave própria, reaproveita a da transcrição se for da OpenAI. */
  REALTIME_API_KEY: z.string().optional(),
  REALTIME_URL: z.string().default('https://api.openai.com/v1'),
  REALTIME_MODEL: z.string().default('gpt-realtime'),
  REALTIME_VOICE: z.string().default('marin'),
  REALTIME_TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  /** Estimativa de custo em US$ por minuto de conversa (só para o registro de custo). */
  REALTIME_USD_PER_MIN: z.coerce.number().default(0.15),
  /** Duração máxima de uma conversa por voz, em minutos. */
  REALTIME_MAX_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /**
   * Motor da conversa por voz: `realtime` (gpt-realtime chama as ferramentas direto) ou
   * `live` (gpt-live-1, full duplex, que delega cada pedido ao orquestrador do chat).
   */
  VOICE_PROVIDER: z.enum(['realtime', 'live']).default('realtime'),
  LIVE_MODEL: z.string().default('gpt-live-1'),
  /** Vazio = voz padrão do GPT-Live. */
  LIVE_VOICE: z.string().optional(),
  LIVE_USD_PER_MIN: z.coerce.number().default(0.05),
  EVOLUTION_URL: z.string().default('http://localhost:8085'),
  EVOLUTION_API_KEY: z.string().default(''),
  EVOLUTION_INSTANCE: z.string().default('saude-financeira'),
  EVOLUTION_WEBHOOK_SECRET: z.string().default(''),
  EVOLUTION_WEBHOOK_URL: z.string().default('http://host.docker.internal:4000'),
  /** Web Push (gere com `npx web-push generate-vapid-keys`). Vazias = push desligado. */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** Contato exigido pelos serviços de push (mailto: ou https:). */
  VAPID_SUBJECT: z.string().default('mailto:nao-responda@localhost'),
  BRAPI_TOKEN: z.string().optional(),
  /**
   * Agente proativo em segundo plano: `off` (nada), `deterministic` (avisos por template, sem LLM)
   * ou `full` (LLM pequeno redige avisos e extrai memória, dentro dos limites abaixo).
   */
  AGENT_PROACTIVE: z.enum(['off', 'deterministic', 'full']).default('full'),
  /** Teto de gasto semanal com LLM em segundo plano, por usuário (US$). */
  AGENT_BG_WEEKLY_USD: z.coerce.number().min(0).default(0.5),
  /** Chamadas por dia, por usuário, para extrair memória das conversas. */
  AGENT_MEMORY_DAILY: z.coerce.number().int().min(0).default(10),
  /** Avisos proativos redigidos pelo LLM por dia, por usuário (os demais saem do template). */
  AGENT_PHRASE_DAILY: z.coerce.number().int().min(0).default(5),
  /** Pesquisas na web por semana, por usuário (preço de compras e mudanças de regras). */
  AGENT_WEB_WEEKLY: z.coerce.number().int().min(0).default(6),
  /** Libera as ferramentas de busca/leitura web do provedor de LLM (custo por busca). */
  AGENT_WEB_TOOLS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** false | true | lista de IPs/CIDR (ex.: "loopback,uniquelocal" atrás do nginx do compose) */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' || v === 'false' ? false : v === 'true' ? true : v)),
});

export type Config = z.infer<typeof schema>;

/** Campos de IA que a tela de Configurações pode sobrescrever (mesma validação do ambiente). */
export const aiConfigSchema = schema.pick({
  ANTHROPIC_API_KEY: true,
  LLM_MODEL_SMALL: true,
  LLM_MODEL_LARGE: true,
  TRANSCRIBE_API_KEY: true,
  TRANSCRIBE_URL: true,
  TRANSCRIBE_MODEL: true,
  VOICE_PROVIDER: true,
  REALTIME_API_KEY: true,
  REALTIME_URL: true,
  REALTIME_MODEL: true,
  REALTIME_VOICE: true,
  REALTIME_TRANSCRIBE_MODEL: true,
  LIVE_MODEL: true,
  LIVE_VOICE: true,
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuração inválida:\n  ${issues}`);
  }
  return parsed.data;
}
