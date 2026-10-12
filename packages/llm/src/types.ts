import type { z } from 'zod';

/** Conteúdo neutro de provedor. O orquestrador só conhece estes tipos. */
export type LLMContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; dataB64: string }
  | { type: 'document'; mime: 'application/pdf'; dataB64: string; title?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  /** Bloco opaco do provedor (ex.: thinking) que precisa voltar intacto no próximo turno. */
  | { type: 'provider_opaque'; provider: string; block: unknown };

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: LLMContent[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema do input. */
  inputSchema: Record<string, unknown>;
}

/** small: intenção e lançamentos simples; large: documentos, análises, simulações. */
export type ModelTier = 'small' | 'large';

export interface ChatRequest {
  tier: ModelTier;
  /** Parte estável do prompt de sistema (cacheável). */
  system: string;
  /** Parte volátil do prompt de sistema (data de hoje, contexto do workspace). */
  systemDynamic?: string;
  messages: LLMMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Rótulo para métricas de custo (chat, extract, classify...). */
  purpose: string;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
}

export interface ChatResponse {
  content: LLMContent[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
  provider: string;
  latencyMs: number;
}

export interface ExtractRequest<T extends z.ZodType> {
  tier: ModelTier;
  system: string;
  content: LLMContent[];
  schema: T;
  /** Nome curto do schema (alguns provedores exigem). */
  schemaName: string;
  maxTokens?: number;
  purpose: string;
  signal?: AbortSignal;
}

export interface ExtractResponse<T> {
  data: T;
  usage: Usage;
  model: string;
  provider: string;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest, onTextDelta?: (text: string) => void): Promise<ChatResponse>;
  extract<T extends z.ZodType>(req: ExtractRequest<T>): Promise<ExtractResponse<z.infer<T>>>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind:
      'refusal' | 'rate_limit' | 'unavailable' | 'invalid_output' | 'auth' | 'bad_request' | 'unknown',
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function textOf(content: LLMContent[]): string {
  return content
    .filter((c): c is Extract<LLMContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

export function toolCallsOf(content: LLMContent[]) {
  return content.filter((c): c is Extract<LLMContent, { type: 'tool_call' }> => c.type === 'tool_call');
}
