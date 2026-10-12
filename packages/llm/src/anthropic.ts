import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type * as BM from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta';
import { costMicroUsd } from './pricing.js';
import {
  LLMError,
  type ChatRequest,
  type ChatResponse,
  type ExtractRequest,
  type ExtractResponse,
  type LLMContent,
  type LLMMessage,
  type LLMProvider,
  type ModelTier,
  type StopReason,
  type Usage,
} from './types.js';

export interface AnthropicProviderOptions {
  apiKey?: string;
  models: Record<ModelTier, string>;
}

// Modelos que aceitam o fallback server-side por categoria de recusa.
const FALLBACK_MODELS = /^claude-(opus|sonnet|fable)-/;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private opts: AnthropicProviderOptions) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async chat(req: ChatRequest, onTextDelta?: (text: string) => void): Promise<ChatResponse> {
    const model = this.opts.models[req.tier];
    const started = Date.now();
    const tools: BM.BetaToolUnion[] | undefined = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BM.BetaTool.InputSchema,
      // inputs chegam conforme gerados; o orquestrador valida cada um com zod antes de executar
      eager_input_streaming: true,
    }));

    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.beta.messages.stream(
          {
            model,
            max_tokens: req.maxTokens ?? 16_000,
            // prefixo estável primeiro (tools → system estável) para o cache de prompt
            system: [
              { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
              ...(req.systemDynamic ? [{ type: 'text' as const, text: req.systemDynamic }] : []),
            ],
            messages: req.messages.map(toAnthropicMessage),
            ...(tools?.length ? { tools } : {}),
            output_config: { effort: req.effort ?? (req.tier === 'small' ? 'low' : 'medium') },
            // cacheia automaticamente o último bloco cacheável (histórico do loop de tools)
            cache_control: { type: 'ephemeral' },
            ...fallbackParams(model),
          },
          { signal: req.signal },
        );
        if (onTextDelta) stream.on('text', (delta) => onTextDelta(delta));
        const message = await stream.finalMessage();
        return {
          content: message.content.flatMap(fromAnthropicBlock),
          stopReason: mapStop(message.stop_reason),
          usage: toUsage(message.model, message.usage),
          model: message.model,
          provider: this.name,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        // Input de tool que nem chega a ser JSON válido: reemite o turno (até 2 vezes)
        if (!(err instanceof Anthropic.APIError) && err instanceof SyntaxError && attempt < 2) continue;
        throw mapError(err);
      }
    }
  }

  async extract<T extends z.ZodType>(req: ExtractRequest<T>): Promise<ExtractResponse<z.infer<T>>> {
    const model = this.opts.models[req.tier];
    const started = Date.now();
    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: req.maxTokens ?? 32_000,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.content.flatMap(toAnthropicContent) }],
          output_config: { format: betaZodOutputFormat(req.schema), effort: 'medium' },
          ...fallbackParams(model),
        },
        { signal: req.signal },
      );
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new LLMError('O modelo recusou a extração.', 'refusal');
      if (message.stop_reason === 'max_tokens')
        throw new LLMError('Documento grande demais para extrair de uma vez.', 'invalid_output');
      const parsed = (message as unknown as { parsed_output?: unknown }).parsed_output;
      const data =
        parsed ?? JSON.parse(message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
      const check = req.schema.safeParse(data);
      if (!check.success)
        throw new LLMError('Saída do modelo não corresponde ao schema.', 'invalid_output', check.error);
      return {
        data: check.data,
        usage: toUsage(message.model, message.usage),
        model: message.model,
        provider: this.name,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      throw err instanceof LLMError ? err : mapError(err);
    }
  }
}

function fallbackParams(model: string): { betas?: AnthropicBeta[]; fallbacks?: BM.BetaFallbacksParam } {
  // Em recusa, a própria API reexecuta a requisição num modelo de fallback escolhido pela categoria.
  return FALLBACK_MODELS.test(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : {};
}

function toAnthropicMessage(m: LLMMessage): BM.BetaMessageParam {
  return { role: m.role, content: m.content.flatMap(toAnthropicContent) };
}

function toAnthropicContent(c: LLMContent): BM.BetaContentBlockParam[] {
  switch (c.type) {
    case 'text':
      return c.text ? [{ type: 'text', text: c.text }] : [];
    case 'image':
      return [{ type: 'image', source: { type: 'base64', media_type: c.mime, data: c.dataB64 } }];
    case 'document':
      return [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: c.dataB64 },
          ...(c.title ? { title: c.title } : {}),
        },
      ];
    case 'tool_call':
      return [{ type: 'tool_use', id: c.id, name: c.name, input: c.input as Record<string, unknown> }];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: c.toolCallId,
          content: c.content,
          ...(c.isError ? { is_error: true } : {}),
        },
      ];
    case 'provider_opaque':
      return c.provider === 'anthropic' ? [c.block as BM.BetaContentBlockParam] : [];
  }
}

function fromAnthropicBlock(b: BM.BetaContentBlock): LLMContent[] {
  switch (b.type) {
    case 'text':
      return [{ type: 'text', text: b.text }];
    case 'tool_use':
      return [{ type: 'tool_call', id: b.id, name: b.name, input: b.input }];
    case 'thinking':
    case 'redacted_thinking':
      // volta intacto no próximo turno do mesmo loop de tools
      return [{ type: 'provider_opaque', provider: 'anthropic', block: b }];
    default:
      return [];
  }
}

function mapStop(s: string | null): StopReason {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toUsage(model: string, u: BM.BetaUsage): Usage {
  const base = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  return { ...base, costMicroUsd: costMicroUsd(model, base) };
}

function mapError(err: unknown): LLMError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new LLMError('Credencial do provedor de LLM inválida.', 'auth', err);
  if (err instanceof Anthropic.RateLimitError)
    return new LLMError('Limite de requisições do LLM atingido.', 'rate_limit', err);
  if (err instanceof Anthropic.BadRequestError)
    return new LLMError(`Requisição inválida ao LLM: ${err.message}`, 'bad_request', err);
  if (
    err instanceof Anthropic.APIConnectionError ||
    (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)
  )
    return new LLMError('Provedor de LLM indisponível.', 'unavailable', err);
  if (err instanceof Anthropic.APIUserAbortError)
    return new LLMError('Requisição cancelada.', 'unknown', err);
  return new LLMError(err instanceof Error ? err.message : String(err), 'unknown', err);
}
