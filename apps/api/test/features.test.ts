import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@sf/db';
import { FakeProvider, FakeTranscriber } from '@sf/llm';
import { addDays, crc16, diffDays, formatDateBR, mod10, mod11Boleto, type DraftDTO } from '@sf/shared';
import { handleMessage } from '../src/agent/orchestrator.js';
import { draftGoalTool } from '../src/agent/tools-finance.js';
import { handleInbound } from '../src/channels/whatsapp-handler.js';
import type { InboundMessage, MessagingChannel } from '../src/channels/types.js';
import type { Actor, AppContext } from '../src/context.js';
import { accountShortfalls, emergencyReserve, safeToSpend } from '../src/domain/forecast.js';
import { workspaceToday } from '../src/domain/ledger.js';
import { computeProjection } from '../src/domain/projection.js';
import { upcoming } from '../src/domain/queries.js';
import { transcribeAudio } from '../src/import/audio.js';
import { saveAttachment } from '../src/import/service.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import { insertAccount, insertTx, type TestEnv } from '../../../db/tests/helpers.js';

/** Linha digitável válida (DVs FEBRABAN) para um vencimento qualquer. */
function boletoLine(bank: string, amountCents: number, due: string): string {
  const factor = diffDays(due, '2025-02-22') + 1000;
  const body = `${bank}9${String(factor).padStart(4, '0')}${String(amountCents).padStart(10, '0')}1757000123456789012345678`;
  const bar = `${body.slice(0, 4)}${mod11Boleto(body)}${body.slice(4)}`;
  const [f1, f2, f3] = [bar.slice(0, 4) + bar.slice(19, 24), bar.slice(24, 34), bar.slice(34, 44)];
  const l = `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${bar[4]}${bar.slice(5, 19)}`;
  return `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`;
}
const CONVENIO_ENERGIA = '836900000016873400572020610150000004000000000018'; // R$ 187,34
const PIX_SEM_VALOR =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
function pixWithAmount(amount: string) {
  const at = PIX_SEM_VALOR.indexOf('5802BR');
  const body = `${PIX_SEM_VALOR.slice(0, at)}54${String(amount.length).padStart(2, '0')}${amount}${PIX_SEM_VALOR.slice(at, -4)}`;
  return body + crc16(body);
}

class StubWhatsApp implements MessagingChannel {
  readonly name = 'stub';
  sent: string[] = [];
  async sendText(_to: string, text: string) {
    this.sent.push(text);
  }
  async sendOptions(_to: string, text: string, options: string[]) {
    this.sent.push(`${text}\n${options.join('/')}`);
  }
  async downloadMedia() {
    return { data: Buffer.alloc(6000, 1), mime: 'audio/ogg; codecs=opus', filename: 'x.bin' };
  }
  parseWebhook() {
    return null;
  }
}

describe.skipIf(!hasDb)('Primeira onda: boleto/Pix, folga, alerta de conta negativa, compra e áudio', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;
  let today: string;
  let extractDue: string;
  const say = (text: string, a = actor) => handleMessage(app, a, { text });

  beforeAll(async () => {
    env = setupEnv();
    // Foto de conta de luz: o extrator devolve a linha de convênio e o vencimento impresso
    const fake = new FakeProvider(() => ({
      doc_type: 'boleto',
      institution: 'Celesc',
      account_hint: null,
      period_from: null,
      period_to: null,
      closing_balance_cents: null,
      card_bill: null,
      transactions: [],
      pension: null,
      trades: [],
      notes: null,
      payment: {
        barcode_line: CONVENIO_ENERGIA,
        pix_code: null,
        amount_cents: 18_734,
        due_date: extractDue,
        payee: 'Celesc',
      },
    }));
    app = makeApp(env, fake);
    actor = await newActor(env);
    today = await env.as(actor.userId, (tx) => workspaceToday(tx, actor.workspaceId));
    extractDue = addDays(today, 5);
    await say('abri uma conta no BB com 1.000');
    await say('sim');
    await say('abri uma conta na Cresol com 5.000');
    await say('sim');
  });
  afterAll(async () => {
    await env?.owner.db
      .deleteFrom('benchmarks')
      .where('series', '=', 'CDI')
      .where('source', '=', 'test')
      .execute();
    await env?.cleanup();
  });

  it('boleto colado no chat vira conta agendada com lembrete (valor, banco e vencimento do código)', async () => {
    const due = addDays(today, 8);
    const r = await say(`${boletoLine('341', 23_050, due)} no BB`);
    expect(r.drafts).toHaveLength(1);
    const p = r.drafts[0]!.preview;
    expect(p.title).toMatch(/Boleto Itaú/);
    expect(p.summary).toContain('R$ 230,50');
    expect(p.summary).toContain(`vence ${formatDateBR(due)}`);
    expect(
      await env.as(actor.userId, (tx) => tx.selectFrom('transactions').select('id').execute()),
    ).toHaveLength(0);
    await say('sim');
    const rows = await env.as(actor.userId, (tx) =>
      tx.selectFrom('transactions').select(['status', 'date', 'amountCents', 'description']).execute(),
    );
    expect(rows).toEqual([expect.objectContaining({ status: 'scheduled', date: due, amountCents: 23_050 })]);
    const next = await env.as(actor.userId, (tx) => upcoming(tx, actor.workspaceId, today, 15));
    expect(next.some((u) => u.amountCents === 23_050 && u.date === due)).toBe(true);
  });

  it('código com dígito errado é recusado sem gerar prévia', async () => {
    const line = boletoLine('341', 10_000, addDays(today, 3)).replace(/^(\d{4})\d/, (_, a) => `${a}0`);
    const wrong =
      line === boletoLine('341', 10_000, addDays(today, 3)) ? line.replace(/^(\d{4})0/, '$11') : line;
    const r = await say(`${wrong} no BB`);
    expect(r.drafts).toHaveLength(0);
    expect(r.text).toMatch(/dígito/);
  });

  it('Pix copia e cola: com valor vira prévia; sem valor pergunta o valor', async () => {
    const semValor = await say(`${PIX_SEM_VALOR} no BB`);
    expect(semValor.drafts).toHaveLength(0);
    expect(semValor.text).toMatch(/valor/);
    // Pix não traz vencimento: sem data, a ferramenta pergunta
    const comValor = await say(`${pixWithAmount('89.90')} no BB`);
    expect(comValor.text).toMatch(/vencimento|data/);
  });

  it('foto de conta de luz: convênio validado, vencimento lido do documento, categoria Energia', async () => {
    const solo = await newActor(env);
    await say('abri uma conta no Inter com 2.000', solo);
    await say('sim', solo);
    const att = await saveAttachment(app, solo, {
      data: Buffer.from('foto-luz'),
      filename: 'luz.jpg',
      mime: 'image/jpeg',
    });
    const r = await handleMessage(app, solo, { text: 'paga essa conta', attachmentIds: [att.id] });
    expect(r.drafts).toHaveLength(1);
    const p = r.drafts[0]!.preview;
    expect(p.title).toContain('Celesc (energia elétrica e gás)');
    expect(p.summary).toContain('R$ 187,34');
    expect(p.summary).toContain(formatDateBR(extractDue));
    expect(p.items?.[0]?.category).toBe('Energia');
    expect(p.warnings).toHaveLength(0);
  });

  it('folga: menor saldo dos 24 meses menos o piso; resposta pelo chat', async () => {
    const s = await env.as(actor.userId, (tx) => safeToSpend(tx, actor.workspaceId, today));
    const proj = await env.as(actor.userId, (tx) => computeProjection(tx, actor.workspaceId));
    const min = Math.min(...proj.months.map((m) => m.closingCents));
    expect(s.extraCents).toBe(Math.max(0, min - proj.floorCents));
    expect(s.extraCents).toBe(600_000 - 23_050); // contas 1.000 + 5.000, boleto agendado
    expect(s.status).toBe('ok');
    const r = await say('quanto posso gastar?');
    expect(r.text).toContain('Folga para gastos extras: R$ 5.769,50');
  });

  it('conta que vai ficar negativa: data, causa e transferência sugerida de outra conta', async () => {
    const bb = await env.as(actor.userId, (tx) =>
      tx.selectFrom('accounts').select('id').where('name', 'ilike', '%bb%').executeTakeFirstOrThrow(),
    );
    await env.as(actor.userId, (tx) =>
      insertTx(tx, actor.workspaceId, {
        accountId: bb.id,
        date: addDays(today, 10),
        amountCents: 250_000,
        direction: 'out',
        status: 'scheduled',
        description: 'Aluguel',
      }),
    );
    const [f, ...rest] = await env.as(actor.userId, (tx) => accountShortfalls(tx, actor.workspaceId, today));
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({
      accountId: bb.id,
      date: addDays(today, 10),
      balanceCents: 100_000 - 23_050 - 250_000,
      cause: { description: 'Aluguel', amountCents: 250_000 },
      // R$ 1.730,50 arredondado para cima em múltiplos de R$ 10
      suggestion: {
        fromAccountName: expect.stringMatching(/Cresol/i),
        amountCents: 174_000,
        date: addDays(today, 9),
      },
    });
    // a folga consolidada continua positiva: o problema é a conta, não o total
    const s = await env.as(actor.userId, (tx) => safeToSpend(tx, actor.workspaceId, today));
    expect(s.shortfalls).toHaveLength(1);
  });

  it('"posso comprar?": compara à vista com desconto e 10x pelo CDI líquido, sem gravar nada', async () => {
    await say('cartão Nubank fecha dia 5 e vence dia 12, limite 10 mil');
    await say('sim');
    // CDI de ~14,9% a.a. (0,055131% a.d.) numa data futura para ser o mais recente
    await sql`insert into benchmarks (series, date, value, source) values ('CDI', '2099-12-31', 0.055131, 'test')
      on conflict (series, date) do update set value = excluded.value, source = excluded.source`.execute(
      env.owner.db,
    );
    const before = await env.as(actor.userId, (tx) => tx.selectFrom('transactions').select('id').execute());
    // saldo projetado neste ponto: 6.000 − 230,50 (boleto) − 2.500 (aluguel) = 3.269,50
    const r = await say('posso comprar uma TV de 2.000 em 10x com 8% de desconto à vista?');
    expect(r.drafts).toHaveLength(0);
    expect(r.text).toContain('À vista com desconto (R$ 1.840,00): cabe');
    expect(r.text).toContain('10x de R$ 200,00 no cartão Nubank: cabe');
    expect(r.text).toMatch(/CDI líquido de IR \(14,9\d% ao ano bruto\)/);
    // 10x sem juros contra 8% de desconto: com CDI ~15% a.a., o desconto vale mais
    expect(r.text).toMatch(/pagar R\$ 1\.840,00 à vista sai R\$ [\d.,]+ mais barato/);
    expect(r.text).toMatch(/embute juros de 1,\d\d% ao mês/);

    // compra que não cabe à vista
    const big = await say('posso comprar uma TV de 4.000 em 10x');
    expect(big.text).toMatch(/À vista \(R\$ 4\.000,00\): fura o piso de R\$ 0,00/);
    const after = await env.as(actor.userId, (tx) => tx.selectFrom('transactions').select('id').execute());
    expect(after).toHaveLength(before.length);
  });

  it('áudio: transcrição mascarada, uso registrado e limite diário', async () => {
    const audioApp: AppContext = {
      ...app,
      transcriber: new FakeTranscriber(() => 'paguei 50 de padaria no BB, meu CPF é 529.982.247-25'),
    };
    const text = await transcribeAudio(audioApp, actor, { data: Buffer.alloc(8000, 1), mime: 'audio/webm' });
    expect(text).toContain('***.***.***-25');
    expect(text).not.toContain('529.982');
    const usage = await env.as(actor.userId, (tx) =>
      tx
        .selectFrom('llmUsage')
        .select(['purpose', 'costMicroUsd'])
        .where('purpose', '=', 'transcribe')
        .execute(),
    );
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]!.costMicroUsd)).toBeGreaterThan(0);
    await expect(
      transcribeAudio(audioApp, actor, { data: Buffer.from('x'), mime: 'application/pdf' }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('áudio no WhatsApp: repete o que entendeu e devolve a prévia com as opções', async () => {
    const wa = new StubWhatsApp();
    const phone = `5548${Math.floor(100000000 + Math.random() * 899999999)}`;
    await env.owner.db
      .insertInto('userChannels')
      .values({
        userId: actor.userId,
        kind: 'whatsapp',
        address: phone,
        verifiedAt: new Date(),
        defaultWorkspaceId: actor.workspaceId,
      })
      .execute();
    const waApp: AppContext = {
      ...app,
      whatsapp: wa,
      transcriber: new FakeTranscriber(() => 'paguei 50 de padaria no BB'),
    };
    const msg: InboundMessage = {
      messageId: `a-${Date.now()}`,
      from: phone,
      timestamp: 0,
      kind: 'audio',
      media: { mime: 'audio/ogg' },
      raw: {},
    };
    await handleInbound(waApp, msg);
    const reply = wa.sent.at(-1)!;
    expect(reply).toContain('🎤 _"paguei 50 de padaria no BB"_');
    expect(reply).toContain('R$ 50,00');
    expect(reply).toMatch(/Confirmar\/Editar\/Cancelar/);

    // sem transcrição configurada, mantém a resposta antiga
    const off = new StubWhatsApp();
    await handleInbound({ ...app, whatsapp: off }, { ...msg, messageId: `b-${Date.now()}` });
    expect(off.sent).toEqual(['Ainda não entendo áudio. Pode mandar por texto?']);
  });

  it('reserva de emergência: salário para, aluguel recebido continua, aporte para, conta de investimento conta', async () => {
    const a = await newActor(env);
    const sayA = (t: string) => handleMessage(app, a, { text: t });
    await sayA('abri uma conta no BB com 12.000');
    await sayA('sim');
    await sayA('todo dia 5 entra 8.500 de salário no BB');
    await sayA('sim');
    await sayA('todo dia 10 pago 2.000 de aluguel no BB');
    await sayA('sim');
    await sayA('todo dia 20 recebo 1.000 de aluguel da sala no BB');
    await sayA('sim');
    const bb = await env.as(a.userId, (tx) =>
      tx.selectFrom('accounts').select('id').executeTakeFirstOrThrow(),
    );

    const r1 = await env.as(a.userId, (tx) => emergencyReserve(tx, a.workspaceId, today));
    // o provedor fake tira os acentos da frase ao montar a descrição
    expect(r1.salaries).toEqual([{ description: 'Salario', amountCents: 850_000 }]);
    expect(r1.monthlyCostCents).toBe(200_000);
    expect(r1.otherIncomeCents).toBe(100_000);
    expect(r1.reserveCents).toBe(1_200_000);
    expect(r1.breakdown).toEqual({ accountsCents: 1_200_000, investmentsCents: 0 });
    // perde 1.000 por mês: 12.000 (+ eventual aluguel recebido ainda neste mês) dura 12 a 14 meses
    expect(r1.months).toBeGreaterThanOrEqual(12);
    expect(r1.months).toBeLessThanOrEqual(14);
    expect(r1.runsOutMonth).not.toBeNull();
    expect(r1.status).toBe('ok');
    // com salário, a projeção normal nunca zera: o cenário é que tira a renda
    const proj = await env.as(a.userId, (tx) => computeProjection(tx, a.workspaceId));
    expect(proj.minClosing!.cents).toBeGreaterThan(0);

    // Conta de investimento entra na reserva; aporte mensal agendado para ela não é custo no cenário
    const xp = await env.as(a.userId, (tx) =>
      insertAccount(tx, a.workspaceId, {
        name: 'XP',
        type: 'investment',
        openingBalanceCents: 600_000,
        openingDate: addDays(today, -1),
      }),
    );
    const transferId = crypto.randomUUID();
    for (const [accountId, direction] of [
      [bb.id, 'out'],
      [xp, 'in'],
    ] as const)
      await env.as(a.userId, (tx) =>
        insertTx(tx, a.workspaceId, {
          accountId,
          date: addDays(today, 40),
          amountCents: 100_000,
          direction,
          status: 'scheduled',
          kind: 'transfer',
          transferId,
          description: 'Aporte XP',
        }),
      );
    const r2 = await env.as(a.userId, (tx) => emergencyReserve(tx, a.workspaceId, today));
    expect(r2.breakdown).toEqual({ accountsCents: 1_200_000, investmentsCents: 600_000 });
    expect(r2.monthlyCostCents).toBe(200_000);
    expect(r2.months! - r1.months!).toBeCloseTo(6, 0);

    const chat = await sayA('quanto tempo aguento se eu for demitido?');
    expect(chat.text).toContain('Sem salário, sua reserva de R$ 18.000,00 paga as contas por');
    expect(chat.text).toContain('Salario (R$ 8.500,00)');
    expect(chat.text).toContain('Não inclui FGTS');
  });

  it('meta com prazo: prévia traz o aporte para o prazo e avisa quando o aporte pedido não chega', async () => {
    const drafts: DraftDTO[] = [];
    const run = (input: Record<string, unknown>) =>
      env.as(actor.userId, (tx) =>
        draftGoalTool.run(
          {
            tx,
            actor,
            app,
            conversationId: null as unknown as string,
            today: '2026-10-13',
            attachmentIds: [],
            emitDraft: (d) => drafts.push(d),
          },
          draftGoalTool.schema.parse(input),
        ),
      );
    // início padrão no chat: mês seguinte → nov/2026 a ago/2027 = 10 aportes
    await run({
      name: 'Orlando 2027',
      kind: 'travel',
      target: '30 mil',
      monthly: '1.000',
      target_date: '2027-08-31',
    });
    const p = drafts.at(-1)!.preview;
    expect(p.lines).toContainEqual({
      label: 'Aporte para o prazo',
      value: 'R$ 3.000,00/mês (10 aportes até 31/08/2027)',
    });
    expect(p.warnings).toContainEqual(
      'Com R$ 1.000,00/mês a meta não fica pronta até 31/08/2027: faltariam R$ 20.000,00.',
    );
    await run({
      name: 'Orlando 2027',
      kind: 'travel',
      target: '30 mil',
      monthly: '3.000',
      target_date: '2027-08-31',
    });
    expect(drafts.at(-1)!.preview.warnings).toEqual([]);
  });
});
