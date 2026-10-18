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
        // relógio do Node pode estar à frente do Postgres (VM do Docker): garante que já venceu
        fireAt: new Date(Date.now() - 60_000),
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

describe.skipIf(!hasDb)('Worker: alerta de conta que vai ficar negativa', () => {
  let env: TestEnv;
  let app: AppContext;
  let wa: FakeWhatsApp;
  let ctx: WorkerContext;
  let userId: string;
  let ws: string;
  const phone = `5547${Math.floor(100000000 + Math.random() * 899999999)}`;

  beforeAll(async () => {
    env = setupEnv();
    wa = new FakeWhatsApp();
    app = { ...makeApp(env), whatsapp: wa };
    ctx = { app, sys: env.owner.db, close: async () => {} };
    userId = await env.createUser('Bia');
    ws = await env.createWorkspace(userId, 'Casa Bia');
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ reminderTime: '00:00', quietStart: '00:00', quietEnd: '00:00' })
      .where('workspaceId', '=', ws)
      .execute();
    await env.owner.db
      .insertInto('userChannels')
      .values({ userId, kind: 'whatsapp', address: phone, verifiedAt: new Date(), defaultWorkspaceId: ws })
      .execute();
  });
  afterAll(async () => env?.cleanup());

  it('avisa a data e a causa, propõe a transferência e "sim" registra agendada', async () => {
    const today = (await sql<{ d: string }>`select ws_today(${ws}::uuid)::text as d`.execute(env.owner.db))
      .rows[0]!.d;
    const bb = await env.as(userId, (tx) =>
      insertAccount(tx, ws, { name: 'BB', openingBalanceCents: 100_000, openingDate: addDays(today, -1) }),
    );
    const cresol = await env.as(userId, (tx) =>
      insertAccount(tx, ws, {
        name: 'Cresol',
        openingBalanceCents: 800_000,
        openingDate: addDays(today, -1),
      }),
    );
    await env.as(userId, (tx) =>
      insertTx(tx, ws, {
        accountId: bb,
        date: addDays(today, 6),
        amountCents: 250_000,
        direction: 'out',
        status: 'scheduled',
        description: 'Aluguel',
      }),
    );

    await refreshWorkspace(ctx, ws);
    await refreshWorkspace(ctx, ws); // idempotente: um alerta por conta e data
    const alerts = await env.owner.db
      .selectFrom('reminders')
      .select(['dedupeKey'])
      .where('userId', '=', userId)
      .where('kind', '=', 'balance_alert')
      .execute();
    expect(alerts.map((a) => a.dedupeKey)).toEqual([
      `account_shortfall:${bb}:${addDays(today, 6)}:${userId}`,
    ]);

    await dispatchReminders(ctx);
    const msg = wa.sent.at(-1)!.text;
    expect(msg).toContain('a conta BB fica em −R$ 1.500,00');
    expect(msg).toContain('(Aluguel R$ 2.500,00)');
    expect(msg).toContain('R$ 1.500,00 da Cresol');
    expect(msg).toMatch(/Responda \*sim\*/);

    await handleInbound(app, {
      messageId: `s-${Date.now()}`,
      from: phone,
      timestamp: 0,
      kind: 'text',
      text: 'sim',
      raw: {},
    });
    const transfer = await env.as(userId, (tx) =>
      tx
        .selectFrom('transactions')
        .select(['accountId', 'direction', 'amountCents', 'status', 'date'])
        .where('kind', '=', 'transfer')
        .orderBy('direction')
        .execute(),
    );
    expect(transfer).toEqual([
      { accountId: bb, direction: 'in', amountCents: 150_000, status: 'scheduled', date: addDays(today, 5) },
      {
        accountId: cresol,
        direction: 'out',
        amountCents: 150_000,
        status: 'scheduled',
        date: addDays(today, 5),
      },
    ]);
    // coberto: o próximo recálculo não acusa mais nada
    const { accountShortfalls } = await import('@sf/api/domain/forecast');
    expect(await env.as(userId, (tx) => accountShortfalls(tx, ws, today))).toEqual([]);
  });
});

describe.skipIf(!hasDb)('Worker: calendário anual', () => {
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
    userId = await env.createUser('Bia');
    ws = await env.createWorkspace(userId, 'Casa Bia');
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ reminderTime: '00:00', quietStart: '00:00', quietEnd: '00:00' })
      .where('workspaceId', '=', ws)
      .execute();
    await env.owner.db
      .insertInto('userChannels')
      .values({ userId, kind: 'whatsapp', address: phone, verifiedAt: new Date(), defaultWorkspaceId: ws })
      .execute();
  });
  afterAll(async () => env?.cleanup());

  it('avisa 60 dias antes, "sim" confirma e o item entra na projeção', async () => {
    const today = (await sql<{ d: string }>`select ws_today(${ws}::uuid)::text as d`.execute(env.owner.db))
      .rows[0]!.d;
    const due = addDays(today, 40);
    const [y, m, d] = due.split('-').map(Number) as [number, number, number];
    const item = (lead: number, key: string, label: string) =>
      env.owner.db
        .insertInto('seasonalItems')
        .values({
          workspaceId: ws,
          key,
          label,
          kind: 'expense',
          direction: 'out',
          schedule: JSON.stringify([{ month: m, day: d, amountCents: 234_000 }]),
          evidence: JSON.stringify([{ year: y - 1, totalCents: 220_000, months: [m], n: 1 }]),
          leadDays: lead,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const ipva = await item(60, 'ipva', 'IPVA');
    const later = await item(30, 'annual:seguro auto porto', 'Seguro Auto Porto');

    await scheduleReminders(ctx);
    await scheduleReminders(ctx); // idempotente
    const rem = await env.owner.db
      .selectFrom('reminders')
      .select(['dedupeKey', 'targetId'])
      .where('userId', '=', userId)
      .where('kind', '=', 'seasonal')
      .execute();
    // o seguro (30 dias de antecedência) ainda não; o IPVA (60) sim, uma vez
    expect(rem).toEqual([{ dedupeKey: `seasonal:${ipva.id}:${y}:${userId}`, targetId: ipva.id }]);
    expect(rem.some((r) => r.targetId === later.id)).toBe(false);

    await dispatchReminders(ctx);
    const msg = wa.sent.find((s) => s.text.includes('IPVA'));
    expect(msg?.text).toContain('Daqui a 40 dias');
    expect(msg?.text).toContain('R$ 2.340,00 em cota única');
    expect(msg?.text).toContain('Responda *sim*');

    await handleInbound(app, {
      messageId: `c-${Date.now()}`,
      from: phone,
      timestamp: Date.now() / 1000,
      kind: 'text',
      text: 'sim',
      raw: {},
    });
    const after = await env.owner.db
      .selectFrom('seasonalItems')
      .select('status')
      .where('id', '=', ipva.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('confirmed');
    const planned = await env.owner.db
      .selectFrom('plannedCashflows')
      .select(['date', 'amountCents', 'source'])
      .where('refId', '=', ipva.id)
      .orderBy('date')
      .execute();
    // esta temporada e a seguinte (horizonte de 24 meses)
    expect(planned).toHaveLength(2);
    expect(planned[0]).toEqual({ date: due, amountCents: 234_000, source: 'seasonal' });
    expect(wa.sent.at(-1)?.text).toMatch(/Calendário atualizado/);
  });
});

describe.skipIf(!hasDb)('Worker: push quando não há WhatsApp', () => {
  let env: TestEnv;
  let ctx: WorkerContext;
  let userId: string;
  let ws: string;
  const pushes: Array<{ userId: string; title: string; body?: string; url?: string }> = [];
  let emails = 0;

  beforeAll(async () => {
    env = setupEnv();
    const app: AppContext = {
      ...makeApp(env),
      mailer: { send: async () => void emails++ },
      push: {
        publicKey: 'chave',
        sendToUser: async (uid, msg) => {
          pushes.push({ userId: uid, ...msg });
          return 1;
        },
      },
    };
    ctx = { app, sys: env.owner.db, close: async () => {} };
    userId = await env.createUser('Gil');
    ws = await env.createWorkspace(userId, 'Casa Gil');
    await env.owner.db
      .updateTable('workspaceSettings')
      .set({ reminderTime: '00:00', quietStart: '00:00', quietEnd: '00:00' })
      .where('workspaceId', '=', ws)
      .execute();
  });
  afterAll(async () => env?.cleanup());

  it('lembrete vai por push (sem e-mail) e abre a página certa', async () => {
    await env.owner.db
      .insertInto('reminders')
      .values({
        workspaceId: ws,
        userId,
        kind: 'import_reminder',
        fireAt: new Date(Date.now() - 60_000),
        dedupeKey: `t-push-import-${ws}`,
      })
      .execute();
    await dispatchReminders(ctx);
    const r = await env.owner.db
      .selectFrom('reminders')
      .select(['status', 'channel'])
      .where('dedupeKey', '=', `t-push-import-${ws}`)
      .executeTakeFirstOrThrow();
    expect(r).toEqual({ status: 'sent', channel: 'push' });
    expect(emails).toBe(0);
    expect(pushes.at(-1)).toMatchObject({ userId, title: 'Hora de importar o extrato', url: '/importacoes' });
    expect(pushes.at(-1)!.body).not.toMatch(/\*/);
  });
});
