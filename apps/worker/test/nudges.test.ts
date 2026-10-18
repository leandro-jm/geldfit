import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@sf/db';
import { handleInbound } from '@sf/api/channels/whatsapp-handler';
import type { InboundMessage, MessagingChannel } from '@sf/api/channels/types';
import type { AppContext } from '@sf/api/context';
import { hasDb, makeApp, setupEnv } from '../../api/test/helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';
import type { WorkerContext } from '../src/context.js';
import { nudgesDaily } from '../src/jobs/nudges.js';
import { dispatchReminders } from '../src/jobs/reminders.js';

class FakeWhatsApp implements MessagingChannel {
  readonly name = 'fake';
  sent: Array<{ to: string; text: string; options?: string[] }> = [];
  async sendText(to: string, text: string) {
    this.sent.push({ to, text });
  }
  async sendOptions(to: string, text: string, options: string[]) {
    this.sent.push({ to, text, options });
  }
  async downloadMedia(): Promise<never> {
    throw new Error('n/a');
  }
  parseWebhook() {
    return null;
  }
}

const phoneOf = () => `5548${Math.floor(100000000 + Math.random() * 899999999)}`;

describe.skipIf(!hasDb)('Worker: agente proativo (sugestões e perguntas)', () => {
  let env: TestEnv;
  let app: AppContext;
  let wa: FakeWhatsApp;
  let ctx: WorkerContext;
  let emails = 0;
  const pushes: Array<{ userId: string; url?: string }> = [];

  async function user(name: string, opts: { whatsapp: boolean }) {
    const userId = await env.createUser(name);
    const ws = await env.createWorkspace(userId, `Casa ${name}`);
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ reminderTime: '00:00', quietStart: '00:00', quietEnd: '00:00' })
      .where('workspaceId', '=', ws)
      .execute();
    const phone = phoneOf();
    if (opts.whatsapp)
      await env.owner.db
        .insertInto('userChannels')
        .values({ userId, kind: 'whatsapp', address: phone, verifiedAt: new Date(), defaultWorkspaceId: ws })
        .execute();
    return { userId, ws, phone };
  }
  const say = (phone: string, text: string): Promise<void> =>
    handleInbound(app, {
      messageId: `m-${Date.now()}-${Math.random()}`,
      from: phone,
      timestamp: Date.now() / 1000,
      kind: 'text',
      text,
      raw: {},
    } satisfies InboundMessage);
  const nudgesOf = (userId: string) =>
    env.owner.db.selectFrom('agentNudges').selectAll().where('userId', '=', userId).execute();

  beforeAll(async () => {
    env = setupEnv();
    wa = new FakeWhatsApp();
    app = {
      ...makeApp(env),
      whatsapp: wa,
      mailer: { send: async () => void emails++ },
      push: {
        publicKey: 'chave',
        sendToUser: async (userId, msg) => {
          pushes.push({ userId, url: msg.url });
          return 1;
        },
      },
    };
    // redação por LLM fica de fora (FakeProvider não reescreve): vale o template
    app.config.AGENT_PROACTIVE = 'deterministic';
    ctx = { app, sys: env.owner.db, close: async () => {} };
  });
  afterAll(async () => env?.cleanup());

  it('meta atrasada: chega no WhatsApp com a prévia, "sim" ajusta a meta e no mesmo dia não manda outra', async () => {
    const u = await user('Bia', { whatsapp: true });
    const goal = await env.owner.db
      .insertInto('goals')
      .values({
        workspaceId: u.ws,
        name: 'Intercâmbio',
        kind: 'travel',
        targetCents: 3_000_000,
        monthlyContributionCents: 10_000,
        startMonth: '2026-01-01',
        targetDate: '2027-12-31',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const r = await nudgesDaily(ctx, { jitter: false });
    expect(r.scheduled).toBeGreaterThanOrEqual(1);
    const scheduled = (await nudgesOf(u.userId)).filter((n) => n.status === 'scheduled');
    expect(scheduled.map((n) => n.kind)).toEqual(['goal_behind']);

    await dispatchReminders(ctx);
    const msg = wa.sent.find((m) => m.to === u.phone)!;
    expect(msg.text).toContain('*Intercâmbio*');
    expect(msg.text).toContain('Responda *sim*');
    const delivered = (await nudgesOf(u.userId)).find((n) => n.kind === 'goal_behind')!;
    expect(delivered).toMatchObject({ status: 'delivered', deliveredChannel: 'whatsapp' });
    expect(delivered.draftId).toBeTruthy();

    await say(u.phone, 'sim');
    const g = await env.owner.db
      .selectFrom('goals')
      .selectAll()
      .where('id', '=', goal.id)
      .executeTakeFirstOrThrow();
    expect(g.monthlyContributionCents).toBeGreaterThan(10_000);
    expect((await nudgesOf(u.userId)).find((n) => n.id === delivered.id)!.status).toBe('accepted');

    // já recebeu um hoje: o próximo ciclo grava na caixa, mas não agenda envio
    const sentBefore = wa.sent.length;
    await nudgesDaily(ctx, { jitter: false });
    await dispatchReminders(ctx);
    expect(wa.sent.filter((m) => m.to === u.phone).length).toBe(
      wa.sent.slice(0, sentBefore).filter((m) => m.to === u.phone).length,
    );
  });

  it('pergunta com opções: "1" grava o perfil; "parar" silencia o tipo', async () => {
    const u = await user('Caio', { whatsapp: true });
    await nudgesDaily(ctx, { jitter: false });
    await dispatchReminders(ctx);
    const q = wa.sent.find((m) => m.to === u.phone)!;
    expect(q.options).toEqual([
      'CLT',
      'Servidor público',
      'Autônomo',
      'Empresário',
      'Aposentado(a)',
      'Agora não',
    ]);
    await say(u.phone, '1');
    expect(wa.sent.at(-1)!.text).toContain('Anotado: clt');
    const p = await env.owner.db
      .selectFrom('userFinancialProfiles')
      .select('incomeStability')
      .where('userId', '=', u.userId)
      .executeTakeFirstOrThrow();
    expect(p.incomeStability).toBe('clt');

    // próxima pergunta (outro dia): simula que a anterior foi entregue há 4 dias
    await env.owner.db
      .updateTable('agentNudges')
      .set({ deliveredAt: new Date(Date.now() - 4 * 86_400_000) })
      .where('userId', '=', u.userId)
      .execute();
    await nudgesDaily(ctx, { jitter: false });
    await dispatchReminders(ctx);
    expect(wa.sent.at(-1)!.options).toContain('Nenhuma');
    await say(u.phone, 'parar');
    expect(wa.sent.at(-1)!.text).toContain('não mando mais avisos desse tipo');
    const mutes = await env.owner.db
      .selectFrom('agentNudgeMutes')
      .select('kind')
      .where('userId', '=', u.userId)
      .execute();
    expect(mutes.map((m) => m.kind)).toEqual(['profile_gap']);
  });

  it('sem WhatsApp: a sugestão fica na caixa da web e avisa por push (sem e-mail)', async () => {
    const u = await user('Duda', { whatsapp: false });
    const sent = wa.sent.length;
    const mails = emails;
    await nudgesDaily(ctx, { jitter: false });
    await dispatchReminders(ctx);
    expect(wa.sent.length).toBe(sent);
    expect(emails).toBe(mails);
    const n = (await nudgesOf(u.userId)).find((x) => x.deliveredAt);
    expect(n).toMatchObject({ status: 'delivered', deliveredChannel: 'web' });
    const rem = await sql<{ status: string; channel: string }>`
      select status, channel from reminders where user_id = ${u.userId} and kind in ('nudge', 'question')`.execute(
      env.owner.db,
    );
    expect(rem.rows).toEqual([{ status: 'sent', channel: 'web' }]);
    expect(pushes).toContainEqual({ userId: u.userId, url: '/assistente' });
  });

  it('frequência desligada e AGENT_PROACTIVE=off não geram nada', async () => {
    const u = await user('Edu', { whatsapp: true });
    await env.owner.db
      .insertInto('userFinancialProfiles')
      .values({ workspaceId: u.ws, userId: u.userId, nudgeFrequency: 'off' })
      .execute();
    await nudgesDaily(ctx, { jitter: false });
    expect(await nudgesOf(u.userId)).toHaveLength(0);
    app.config.AGENT_PROACTIVE = 'off';
    const r = await nudgesDaily(ctx, { jitter: false });
    app.config.AGENT_PROACTIVE = 'deterministic';
    expect(r).toEqual({ created: 0, scheduled: 0 });
  });
});
