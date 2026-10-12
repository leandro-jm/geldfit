import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '@sf/llm';
import { handleMessage } from '../src/agent/orchestrator.js';
import { computeHoldings } from '../src/domain/portfolio.js';
import { applyMapping, guessMapping, readCsv } from '../src/import/csv.js';
import { parseOfx } from '../src/import/ofx.js';
import { saveAttachment } from '../src/import/service.js';
import type { Actor, AppContext } from '../src/context.js';
import { hasDb, makeApp, newActor, setupEnv } from './helpers.js';
import type { TestEnv } from '../../../db/tests/helpers.js';

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));

describe('Parsers', () => {
  it('CSV de banco com cabeçalho após linhas de título; ignora saldos', () => {
    const rows = readCsv(fixture('extrato-bb.csv').toString('utf8'));
    const map = guessMapping(rows)!;
    expect(map).toMatchObject({ dateCol: 0, descriptionCol: 1, amountCol: 2, headerRow: 2 });
    const { items, skipped } = applyMapping(rows, map);
    expect(items).toHaveLength(4);
    expect(skipped).toBe(2);
    expect(items[0]).toEqual({
      date: '2026-10-02',
      amountCents: 120_000,
      direction: 'in',
      description: 'PIX RECEBIDO FREELA',
    });
    expect(items[1]).toMatchObject({ amountCents: 31_245, direction: 'out' });
  });
  it('OFX SGML com vírgula decimal e saldo', () => {
    const st = parseOfx(fixture('extrato.ofx').toString('latin1'));
    expect(st.kind).toBe('bank');
    expect(st.transactions).toEqual([
      { date: '2026-10-03', amountCents: 15_000, direction: 'out', description: 'POSTO SHELL', fitId: '1' },
      {
        date: '2026-10-05',
        amountCents: 850_000,
        direction: 'in',
        description: 'SALARIO EMPRESA X',
        fitId: '2',
      },
    ]);
    expect(st.ledgerBalanceCents).toBe(1_035_000);
  });
  it('preço médio: compras com taxas, venda mantém o médio', () => {
    const h = computeHoldings([
      {
        assetId: 'a',
        date: '2026-01-10',
        kind: 'buy',
        qty: 100,
        priceCents: 3000,
        feesCents: 500,
        totalCents: 300_500,
        fxRate: null,
      },
      {
        assetId: 'a',
        date: '2026-02-10',
        kind: 'buy',
        qty: 100,
        priceCents: 3400,
        feesCents: 500,
        totalCents: 340_500,
        fxRate: null,
      },
      {
        assetId: 'a',
        date: '2026-03-10',
        kind: 'sell',
        qty: 50,
        priceCents: 3600,
        feesCents: 300,
        totalCents: 179_700,
        fxRate: null,
      },
    ]).get('a')!;
    expect(h.qty).toBe(150);
    expect(h.avgPriceCents).toBeCloseTo(3205, 0); // (300500 + 340500) / 200
    expect(Math.round(h.investedBRLCents)).toBe(480_750);
  });
});

describe.skipIf(!hasDb)('Importação pelo chat', () => {
  let env: TestEnv;
  let app: AppContext;
  let actor: Actor;

  beforeAll(async () => {
    env = setupEnv();
    // Nota de corretagem simulada para o extrator (modelo grande)
    const fake = new FakeProvider(() => ({
      doc_type: 'brokerage_note',
      institution: 'XP',
      account_hint: null,
      period_from: '2026-10-08',
      period_to: '2026-10-08',
      closing_balance_cents: null,
      card_bill: null,
      transactions: [],
      pension: null,
      notes: null,
      trades: [
        {
          date: '2026-10-08',
          ticker: 'ITUB4',
          name: 'ITAU UNIBANCO PN',
          kind: 'buy',
          qty: 100,
          price_cents: 3250,
          fees_cents: 120,
          currency: 'BRL',
          asset_kind: 'stock',
        },
        {
          date: '2026-10-08',
          ticker: 'PETR4',
          name: 'PETROBRAS PN',
          kind: 'buy',
          qty: 50,
          price_cents: 3800,
          fees_cents: 70,
          currency: 'BRL',
          asset_kind: 'stock',
        },
        {
          date: '2026-10-08',
          ticker: 'TAEE11',
          name: 'TAESA UNT',
          kind: 'buy',
          qty: 30,
          price_cents: 3500,
          fees_cents: 40,
          currency: 'BRL',
          asset_kind: 'stock',
        },
        {
          date: '2026-10-08',
          ticker: 'HGLG11',
          name: 'CSHG LOGISTICA',
          kind: 'buy',
          qty: 10,
          price_cents: 16000,
          fees_cents: 60,
          currency: 'BRL',
          asset_kind: 'fii',
        },
        {
          date: '2026-10-08',
          ticker: 'ITUB4',
          name: 'ITAU UNIBANCO PN',
          kind: 'buy',
          qty: 100,
          price_cents: 3350,
          fees_cents: 120,
          currency: 'BRL',
          asset_kind: 'stock',
        },
      ],
    }));
    app = makeApp(env, fake);
    actor = await newActor(env);
    await handleMessage(app, actor, { text: 'abri uma conta no BB com 5.000' });
    await handleMessage(app, actor, { text: 'sim' });
  });
  afterAll(async () => env?.cleanup());

  it('CSV: prévia agregada, confirmação e reimportação marcada como duplicata', async () => {
    const att = await saveAttachment(app, actor, {
      data: fixture('extrato-bb.csv'),
      filename: 'extrato-bb.csv',
      mime: 'text/csv',
    });
    const r = await handleMessage(app, actor, {
      text: 'importa esse extrato do BB',
      attachmentIds: [att.id],
    });
    expect(r.drafts).toHaveLength(1);
    const p = r.drafts[0]!.preview;
    expect(p.totals).toMatchObject({ count: 4, duplicates: 0 });
    expect(p.summary).toMatch(/4 lançamentos/);
    await handleMessage(app, actor, { text: 'sim' });
    const n = await env.as(actor.userId, (tx) =>
      tx.selectFrom('transactions').select('id').where('source', '=', 'import').execute(),
    );
    expect(n).toHaveLength(4);

    // Mesmo conteúdo com outro nome → deduplicado
    const again = Buffer.concat([fixture('extrato-bb.csv'), Buffer.from('\n')]);
    const att2 = await saveAttachment(app, actor, {
      data: again,
      filename: 'extrato-de-novo.csv',
      mime: 'text/csv',
    });
    const r2 = await handleMessage(app, actor, { text: 'importa', attachmentIds: [att2.id] });
    expect(r2.drafts[0]!.preview.totals).toMatchObject({ count: 0, duplicates: 4 });
  });

  it('nota de corretagem com 5 operações: taxas e preço médio corretos', async () => {
    const att = await saveAttachment(app, actor, {
      data: Buffer.from('%PDF-1.4 nota'),
      filename: 'nota.png',
      mime: 'image/png',
    });
    const r = await handleMessage(app, actor, { text: 'importa minha nota', attachmentIds: [att.id] });
    const draft = r.drafts[0]!;
    expect(draft.kind).toBe('trades');
    expect(draft.preview.items).toHaveLength(5);
    await handleMessage(app, actor, { text: 'sim' });
    const trades = await env.as(actor.userId, (tx) =>
      tx
        .selectFrom('trades as t')
        .innerJoin('assets as a', 'a.id', 't.assetId')
        .select([
          'a.ticker',
          't.qty',
          't.priceCents',
          't.feesCents',
          't.totalCents',
          't.assetId',
          't.kind',
          't.date',
          't.fxRate',
        ])
        .execute(),
    );
    expect(trades).toHaveLength(5);
    const itub = trades.filter((t) => t.ticker === 'ITUB4');
    expect(itub.map((t) => t.totalCents).sort()).toEqual([325_120, 335_120]);
    const h = computeHoldings(itub.map((t) => ({ ...t, qty: Number(t.qty) }))).get(itub[0]!.assetId)!;
    expect(h.qty).toBe(200);
    expect(h.avgPriceCents).toBeCloseTo(3301.2, 1); // (325120 + 335120) / 200
  });

  it('arquivo é criptografado em repouso e o download exige assinatura válida', async () => {
    const att = await saveAttachment(app, actor, {
      data: Buffer.from('conteudo secreto do extrato'),
      filename: 'x.csv',
      mime: 'text/csv',
    });
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(`${app.config.FILES_DIR}/${att.storageKey}`);
    expect(raw.includes(Buffer.from('conteudo secreto'))).toBe(false);
    expect((await app.storage.get(att.storageKey)).toString()).toBe('conteudo secreto do extrato');
    const url = new URL(app.storage.signedUrl(att.id, 60));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(app.storage.verifySignature(att.id, exp, sig)).toBe(true);
    expect(app.storage.verifySignature(att.id, exp, `${sig.slice(0, -1)}x`)).toBe(false);
    expect(app.storage.verifySignature(att.id, Math.floor(Date.now() / 1000) - 1, sig)).toBe(false);
    expect(app.storage.verifySignature('00000000-0000-0000-0000-000000000000', exp, sig)).toBe(false);
  });

  it('outro tenant não enxerga o anexo', async () => {
    const other = await newActor(env);
    const att = await saveAttachment(app, actor, {
      data: Buffer.from('so meu'),
      filename: 'meu.csv',
      mime: 'text/csv',
    });
    const seen = await env.as(other.userId, (tx) =>
      tx.selectFrom('attachments').select('id').where('id', '=', att.id).execute(),
    );
    expect(seen).toHaveLength(0);
  });
});
