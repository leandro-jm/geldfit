import nodemailer from 'nodemailer';

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

export function createMailer(opts: { host: string; port: number; from: string }): Mailer {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: false,
    ignoreTLS: opts.port === 1025 || opts.port === 1026,
  });
  return {
    async send(to, subject, text, html) {
      await transport.sendMail({ from: opts.from, to, subject, text, html });
    },
  };
}
