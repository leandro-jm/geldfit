/** Mensagem recebida de um canal de mensageria, já normalizada. */
export interface InboundMessage {
  messageId: string;
  from: string; // número em E.164 sem "+", ex.: 5548999990000
  pushName?: string;
  timestamp: number;
  kind: 'text' | 'audio' | 'image' | 'document' | 'button' | 'other';
  text?: string;
  media?: { mime: string; filename?: string; caption?: string };
  raw: unknown;
}

/**
 * Canal de mensageria (WhatsApp). Hoje implementado pela Evolution API; a Cloud API oficial
 * da Meta pode implementar a mesma interface.
 */
export interface MessagingChannel {
  readonly name: string;
  sendText(to: string, text: string): Promise<void>;
  /** Lista de opções numeradas; implementações sem suporte caem para texto. */
  sendOptions(to: string, text: string, options: string[]): Promise<void>;
  downloadMedia(msg: InboundMessage): Promise<{ data: Buffer; mime: string; filename: string }>;
  /** Normaliza o payload do webhook; null para eventos que não são mensagens recebidas. */
  parseWebhook(body: unknown): InboundMessage | null;
}

/** "+55 (48) 99999-0000" → "5548999990000" */
export function normalizePhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d;
}
