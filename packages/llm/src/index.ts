export * from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { FakeProvider, route as fakeRoute } from './fake.js';
export { costMicroUsd } from './pricing.js';
export * from './transcribe.js';

import { AnthropicProvider } from './anthropic.js';
import { FakeProvider } from './fake.js';
import type { LLMProvider } from './types.js';

/** Seleciona o provedor pelo ambiente. Sem chave configurada, cai no modo demonstração. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const kind = env.LLM_PROVIDER ?? 'anthropic';
  if (kind === 'fake') return new FakeProvider();
  if (kind === 'anthropic') {
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      models: {
        small: env.LLM_MODEL_SMALL || 'claude-haiku-5-5',
        large: env.LLM_MODEL_LARGE || 'claude-opus-5-5',
      },
    });
  }
  throw new Error(`LLM_PROVIDER desconhecido: ${kind}`);
}
