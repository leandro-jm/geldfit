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
  SMTP_FROM: z.string().default('Saúde Financeira <nao-responda@localhost>'),
  LLM_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  EVOLUTION_URL: z.string().default('http://localhost:8085'),
  EVOLUTION_API_KEY: z.string().default(''),
  EVOLUTION_INSTANCE: z.string().default('saude-financeira'),
  EVOLUTION_WEBHOOK_SECRET: z.string().default(''),
  EVOLUTION_WEBHOOK_URL: z.string().default('http://host.docker.internal:4000'),
  BRAPI_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuração inválida:\n  ${issues}`);
  }
  return parsed.data;
}
