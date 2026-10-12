import type { InboundMessage, MessagingChannel } from './types.js';

interface EvolutionOptions {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

type EvoMessage = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Adaptador da Evolution API v2 (WhatsApp não oficial). */
export class EvolutionChannel implements MessagingChannel {
  readonly name = 'evolution';
  constructor(private opts: EvolutionOptions) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: { apikey: this.opts.apiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Evolution ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.call('POST', `/message/sendText/${this.opts.instance}`, {
      number: to,
      text,
      linkPreview: false,
    });
  }

  async sendOptions(to: string, text: string, options: string[]): Promise<void> {
    // Listas/botões são instáveis em contas não-Business; opções numeradas funcionam sempre.
    const body = `${text}\n\n${options.map((o, i) => `${i + 1} - ${o}`).join('\n')}`;
    await this.sendText(to, body);
  }

  async downloadMedia(msg: InboundMessage): Promise<{ data: Buffer; mime: string; filename: string }> {
    const raw = msg.raw as EvoMessage;
    const r = await this.call<{ base64: string; mimetype?: string; fileName?: string }>(
      'POST',
      `/chat/getBase64FromMediaMessage/${this.opts.instance}`,
      {
        message: { key: raw.key },
        convertToMp4: false,
      },
    );
    const mime = r.mimetype ?? msg.media?.mime ?? 'application/octet-stream';
    const ext =
      mime === 'application/pdf'
        ? 'pdf'
        : mime.startsWith('image/')
          ? mime.split('/')[1]!.replace('jpeg', 'jpg')
          : mime.includes('csv')
            ? 'csv'
            : 'bin';
    return {
      data: Buffer.from(r.base64, 'base64'),
      mime,
      filename: msg.media?.filename ?? r.fileName ?? `anexo-${msg.messageId}.${ext}`,
    };
  }

  parseWebhook(body: unknown): InboundMessage | null {
    const b = body as EvoMessage;
    const event = String(b?.event ?? '')
      .toLowerCase()
      .replace('_', '.');
    if (event !== 'messages.upsert') return null;
    const data = (Array.isArray(b.data) ? b.data[0] : b.data) as EvoMessage | undefined;
    if (!data?.key || data.key.fromMe) return null;
    const jid: string = data.key.remoteJidAlt ?? data.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return null; // ignora grupos e status
    const from = jid.split('@')[0]!.replace(/\D/g, '');
    const m: EvoMessage = data.message ?? {};
    const base = {
      messageId: String(data.key.id),
      from,
      pushName: data.pushName,
      timestamp: Number(data.messageTimestamp ?? Date.now() / 1000),
      raw: data,
    };

    const text = m.conversation ?? m.extendedTextMessage?.text;
    if (text) return { ...base, kind: 'text', text };
    const reply =
      m.listResponseMessage?.singleSelectReply?.selectedRowId ??
      m.buttonsResponseMessage?.selectedButtonId ??
      m.templateButtonReplyMessage?.selectedId;
    if (reply) return { ...base, kind: 'button', text: String(reply) };
    if (m.audioMessage)
      return { ...base, kind: 'audio', media: { mime: m.audioMessage.mimetype ?? 'audio/ogg' } };
    if (m.imageMessage)
      return {
        ...base,
        kind: 'image',
        text: m.imageMessage.caption ?? '',
        media: { mime: m.imageMessage.mimetype ?? 'image/jpeg', caption: m.imageMessage.caption },
      };
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
    if (doc)
      return {
        ...base,
        kind: 'document',
        text: doc.caption ?? '',
        media: {
          mime: doc.mimetype ?? 'application/octet-stream',
          filename: doc.fileName,
          caption: doc.caption,
        },
      };
    return { ...base, kind: 'other' };
  }

  // --- Administração da instância (usada pelo script de setup e pela tela de status) ---

  async ensureInstance(webhookUrl: string): Promise<void> {
    const list = await this.call<Array<{ name?: string; instance?: { instanceName?: string } }>>(
      'GET',
      '/instance/fetchInstances',
    ).catch(() => []);
    const exists = list.some(
      (i) => i.name === this.opts.instance || i.instance?.instanceName === this.opts.instance,
    );
    if (!exists) {
      await this.call('POST', '/instance/create', {
        instanceName: this.opts.instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
      });
    }
    await this.call('POST', `/webhook/set/${this.opts.instance}`, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    });
  }

  async connectionState(): Promise<string> {
    const r = await this.call<{ instance?: { state?: string } }>(
      'GET',
      `/instance/connectionState/${this.opts.instance}`,
    );
    return r.instance?.state ?? 'unknown';
  }

  async qrCode(): Promise<string | null> {
    const r = await this.call<{ base64?: string; code?: string }>(
      'GET',
      `/instance/connect/${this.opts.instance}`,
    );
    return r.base64 ?? null;
  }
}
