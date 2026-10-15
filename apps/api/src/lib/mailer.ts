import nodemailer from 'nodemailer';
import type { Logger } from 'pino';

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

export interface MailerOptions {
  host: string;
  port: number;
  from: string;
  user?: string;
  pass?: string;
  secure?: boolean;
}

export function createMailer(opts: MailerOptions, log?: Pick<Logger, 'warn'>): Mailer {
  // Sem SMTP configurado (ex.: primeiro deploy) o e-mail só é registrado, sem derrubar o fluxo
  if (!opts.host) {
    return {
      async send(to, subject) {
        log?.warn({ to, subject }, 'SMTP_HOST não definido: e-mail não enviado');
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure ?? false,
    ignoreTLS: opts.port === 1025 || opts.port === 1026,
    ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? '' } } : {}),
  });
  return {
    async send(to, subject, text, html) {
      await transport.sendMail({ from: opts.from, to, subject, text, html });
    },
  };
}
