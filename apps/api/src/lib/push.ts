import webpush from 'web-push';
import { withUserContext, type Db } from '@sf/db';
import type { Logger } from 'pino';

export interface PushMessage {
  title: string;
  body?: string;
  /** Rota do app aberta no clique (ex.: /assistente). */
  url?: string;
  /** Notificações com a mesma tag se substituem no aparelho. */
  tag?: string;
}

/** Web Push para todos os aparelhos de um usuário. */
export interface PushSender {
  readonly publicKey: string;
  /** Devolve quantos aparelhos aceitaram a notificação. */
  sendToUser(userId: string, msg: PushMessage): Promise<number>;
}

type Transport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<unknown>;

const statusOf = (err: unknown) =>
  typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 0;

export class WebPushSender implements PushSender {
  private readonly transport: Transport;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    opts: { publicKey: string; privateKey: string; subject: string; transport?: Transport },
  ) {
    this.publicKey = opts.publicKey;
    const details = { subject: opts.subject, publicKey: opts.publicKey, privateKey: opts.privateKey };
    this.transport =
      opts.transport ??
      ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 24 * 3600, vapidDetails: details }));
  }

  readonly publicKey: string;

  async sendToUser(userId: string, msg: PushMessage): Promise<number> {
    return withUserContext(this.db, userId, async (tx) => {
      const subs = await tx
        .selectFrom('pushSubscriptions')
        .select(['id', 'endpoint', 'p256dh', 'auth'])
        .execute();
      if (!subs.length) return 0;
      const payload = JSON.stringify(msg);
      const ok: string[] = [];
      const gone: string[] = [];
      await Promise.all(
        subs.map(async (s) => {
          try {
            await this.transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
            ok.push(s.id);
          } catch (err) {
            // 404/410: o navegador revogou a inscrição
            if ([404, 410].includes(statusOf(err))) gone.push(s.id);
            else this.log.warn({ err, status: statusOf(err) }, 'push falhou');
          }
        }),
      );
      if (gone.length) await tx.deleteFrom('pushSubscriptions').where('id', 'in', gone).execute();
      if (ok.length)
        await tx
          .updateTable('pushSubscriptions')
          .set({ lastUsedAt: new Date().toISOString() })
          .where('id', 'in', ok)
          .execute();
      return ok.length;
    });
  }
}

/** Remove marcação do WhatsApp (*negrito*, _itálico_) e corta para caber na notificação. */
export function pushText(text: string, max = 200) {
  const plain = text.replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
