import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@sf/db';
import { addDays, todayISO } from '@sf/shared';
import { handleInbound } from '@sf/api/channels/whatsapp-handler';
import type { InboundMessage, MessagingChannel } from '@sf/api/channels/types';
import type { AppContext } from '@sf/api/context';
import { hasDb, makeApp, setupEnv } from '../../api/test/helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';
import { insertAccount, insertTx } from '../../../db/tests/helpers.js';
import type { WorkerContext } from '../src/context.js';
import { dispatchReminders, inQuietHours, scheduleReminders } from '../src/jobs/reminders.js';
import { refreshWorkspace } from '../src/jobs/projection.js';
import { purgeDeleted } from '../src/jobs/purge.js';

class FakeWhatsApp implements MessagingChannel {
  readonly name = 'fake';
  sent: Array<{ to: string; text: string }> = [];
  async sendText(to: string, text: string) {
    this.sent.push({ to, text });
  }
  async sendOptions(to: string, text: string, options: string[]) {
    this.sent.push({ to, text: `${text}\n${options.join('/')}` });
  }
  async downloadMedia(): Promise<never> {
    throw new Error('n/a');
  }
  parseWebhook() {
    return null;
  }
}

describe('inQuietHours', () => {
  it('janela que cruza a meia-noite', () => {
    expect(inQuietHours('22:30', '21:00', '08:00')).toBe(true);
    expect(inQuietHours('07:59', '21:00', '08:00')).toBe(true);
    expect(inQuietHours('08:00', '21:00', '08:00')).toBe(false);
    expect(inQuietHours('12:00', '21:00', '08:00')).toBe(false);
  });
  it('janela vazia (início = fim) nunca silencia', () => {
    expect(inQuietHours('03:00', '00:00', '00:00')).toBe(false);
  });
});

describe.skipIf(!hasDb)('Worker: lembrete acionável pelo WhatsApp', () => {
  let env: TestEnv;
  let app: AppContext;
  let wa: FakeWhatsApp;
  let ctx: WorkerContext;
  let userId: string;
  let ws: string;
  const phone = `5548${Math.floor(100000000 + Math.random() * 899999999)}`;

  beforeAll(async () => {
    env = setupEnv();
    wa = new FakeWhatsApp();
    app = { ...makeApp(env), whatsapp: wa };
    ctx = { app, sys: env.owner.db, close: async () => {} };
    userId = await env.createUser('Ana');
    ws = await env.createWorkspace(userId, 'Casa Ana');
    // lembretes a qualquer hora (sem horário silencioso) para o teste
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ reminderTime: '00:00', quietStart: '00:00', quietEnd: '00:00', balanceFloorCents: 1_000_000 })
      .where('workspaceId', '=', ws)
      .execute();
    await env.owner.db
      .insertInto('userChannels')
      .values({ userId, kind: 'whatsapp', address: phone, verifiedAt: new Date(), defaultWorkspaceId: ws })
      .execute();
  });
  afterAll(async () => env?.cleanup());

  it('agenda D-1, envia "já pagou?" e "sim" registra o pagamento', async () => {
    const today = (await sql<{ d: string }>`select ws_today(${ws}::uuid)::text as d`.execute(env.owner.db))
      .rows[0]!.d;
    const acc = await env.as(userId, (tx) =>
      insertAccount(tx, ws, { openingBalanceCents: 500_000, openingDate: addDays(today, -1) }),
    );
    const bill = await env.as(userId, (tx) =>
      insertTx(tx, ws, {
        accountId: acc,
        date: addDays(today, 1),
        amountCents: 23_000,
        direction: 'out',
        status: 'scheduled',
        description: 'Conta de luz',
      }),
    );

    await scheduleReminders(ctx);
    const rem = await env.owner.db
      .selectFrom('reminders')
      .select(['kind', 'dedupeKey'])
      .where('userId', '=', userId)
      .execute();
    expect(rem.map((r) => r.dedupeKey)).toContain(`due_bill:${bill.id}:${userId}:D-1`);

    // idempotente
    await scheduleReminders(ctx);
    expect(
      (
        await env.owner.db
          .selectFrom('reminders')
          .select('id')
          .where('userId', '=', userId)
          .where('kind', '=', 'due_bill')
          .execute()
      ).length,
    ).toBe(rem.filter((r) => r.kind === 'due_bill').length);

    await dispatchReminders(ctx);
    const msg = wa.sent.find((m) => m.text.includes('Conta de luz'));
    expect(msg?.text).toMatch(/vence amanhã\. Já pagou\?/);

    const inbound: InboundMessage = {
      messageId: `m-${Date.now()}`,
      from: phone,
      timestamp: Date.now() / 1000,
      kind: 'text',
      text: 'sim',
      raw: {},
    };
    await handleInbound(app, inbound);
    const after = await env.as(userId, (tx) =>
      tx
        .selectFrom('transactions')
        .select(['status', 'date'])
        .where('id', '=', bill.id)
        .executeTakeFirstOrThrow(),
    );
    expect(after.status).toBe('posted');
    expect(wa.sent.at(-1)?.text).toMatch(/Marcado como pago/);
  });

  it('alerta de saldo abaixo do piso no máximo 1 por dia', async () => {
    await refreshWorkspace(ctx, ws);
    await refreshWorkspace(ctx, ws);
    const alerts = await env.owner.db
      .selectFrom('reminders')
      .select('id')
      .where('userId', '=', userId)
      .where('kind', '=', 'balance_alert')
      .execute();
    expect(alerts.length).toBe(1);
    await dispatchReminders(ctx);
    expect(wa.sent.some((m) => m.text.includes('abaixo do piso'))).toBe(true);
  });

  it('opt-out pula o envio', async () => {
    await env.owner.db
      .insertInto('reminderPrefs')
      .values({ workspaceId: ws, userId, kind: 'import_reminder', enabled: false })
      .execute();
    await env.owner.db
      .insertInto('reminders')
      .values({
        workspaceId: ws,
        userId,
        kind: 'import_reminder',
        fireAt: new Date(),
        dedupeKey: `t-import-${ws}`,
      })
      .execute();
    const before = wa.sent.length;
    await dispatchReminders(ctx);
    expect(wa.sent.length).toBe(before);
    const r = await env.owner.db
      .selectFrom('reminders')
      .select(['status', 'lastError'])
      .where('dedupeKey', '=', `t-import-${ws}`)
      .executeTakeFirstOrThrow();
    expect(r).toMatchObject({ status: 'skipped', lastError: 'opt-out' });
  });

  it('número não vinculado recebe só o convite', async () => {
    const before = wa.sent.length;
    await handleInbound(app, {
      messageId: 'x1',
      from: '5511900000000',
      timestamp: 0,
      kind: 'text',
      text: 'paguei 10',
      raw: {},
    });
    expect(wa.sent.length).toBe(before + 1);
    expect(wa.sent.at(-1)!.text).toMatch(/não está vinculado/);
  });

  it('expurgo LGPD apaga workspace excluído', async () => {
    const u = await env.createUser('Tchau');
    const w2 = await env.createWorkspace(u, 'Excluir');
    await env.owner.db
      .updateTable('workspaces')
      .set({ deletedAt: new Date(), purgeAfter: new Date() })
      .where('id', '=', w2)
      .execute();
    await purgeDeleted(ctx);
    expect(
      await env.owner.db.selectFrom('workspaces').select('id').where('id', '=', w2).executeTakeFirst(),
    ).toBeUndefined();
    void todayISO;
  });
});
