import { LLMError } from './types.js';

export interface TranscribeRequest {
  data: Buffer;
  mime: string;
  filename: string;
  /** ISO-639-1 (padrão: pt). */
  language?: string;
  /** Vocabulário que ajuda o modelo (nomes de bancos, termos financeiros). */
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscribeResponse {
  text: string;
  /** Duração do áudio em segundos (informada pelo provedor ou estimada pelo tamanho). */
  seconds: number;
  model: string;
  provider: string;
  latencyMs: number;
}

/** Transcrição de voz. Separada do LLMProvider: nem todo provedor de chat aceita áudio. */
export interface Transcriber {
  readonly name: string;
  transcribe(req: TranscribeRequest): Promise<TranscribeResponse>;
}

/** Áudio de voz em Opus fica em torno de 16 kbit/s (≈ 2 KB por segundo). */
const estimateSeconds = (bytes: number) => Math.max(1, Math.round(bytes / 2000));

/**
 * Endpoint compatível com OpenAI (`POST /audio/transcriptions`): serve para a própria OpenAI,
 * para a Groq e para servidores Whisper auto-hospedados (faster-whisper-server, speaches).
 */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly name = 'openai-compatible';
  constructor(private opts: { baseUrl: string; apiKey?: string; model: string }) {}

  async transcribe(req: TranscribeRequest): Promise<TranscribeResponse> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.data)], { type: req.mime }), req.filename);
    form.append('model', this.opts.model);
    form.append('language', req.language ?? 'pt');
    form.append('response_format', 'json');
    if (req.prompt) form.append('prompt', req.prompt);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        body: form,
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new LLMError('Serviço de transcrição indisponível.', 'unavailable', err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const kind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : res.status >= 500
              ? 'unavailable'
              : 'bad_request';
      throw new LLMError(`Transcrição falhou (${res.status}): ${body.slice(0, 200)}`, kind);
    }
    const json = (await res.json()) as { text?: string; duration?: number; usage?: { seconds?: number } };
    return {
      text: (json.text ?? '').trim(),
      seconds: Math.round(json.duration ?? json.usage?.seconds ?? estimateSeconds(req.data.length)),
      model: this.opts.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}

/** Transcrição determinística para testes. */
export class FakeTranscriber implements Transcriber {
  readonly name = 'fake';
  constructor(private reply: (req: TranscribeRequest) => string) {}
  async transcribe(req: TranscribeRequest): Promise<TranscribeResponse> {
    return {
      text: this.reply(req),
      seconds: estimateSeconds(req.data.length),
      model: 'fake',
      provider: this.name,
      latencyMs: 0,
    };
  }
}

/** Habilitada quando há chave ou URL de um serviço próprio; sem isso, o app segue sem áudio. */
export function transcriberFromEnv(env: NodeJS.ProcessEnv = process.env): Transcriber | null {
  if (!env.TRANSCRIBE_API_KEY && !env.TRANSCRIBE_URL) return null;
  return new OpenAICompatibleTranscriber({
    baseUrl: env.TRANSCRIBE_URL || 'https://api.openai.com/v1',
    apiKey: env.TRANSCRIBE_API_KEY || undefined,
    model: env.TRANSCRIBE_MODEL || 'whisper-1',
  });
}
