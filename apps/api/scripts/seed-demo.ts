/**
 * Cria um usuário de demonstração com 6 meses de histórico, cartão com parcelas, recorrências,
 * previdência e carteira — para ver o painel preenchido.
 *   pnpm seed:demo   →  demo@saudefinanceira.local / demo12345
 */
import { sql, withUserContext } from '@sf/db';
import { addDays, addMonths, startOfMonth, todayISO } from '@sf/shared';
import { createAuth } from '../src/auth/auth.js';
import { createAppContext } from '../src/bootstrap.js';
import type { Actor } from '../src/context.js';
import { confirmDraft, createDraft, type DraftKind } from '../src/domain/drafts.js';
import { resolveAsset } from '../src/domain/portfolio.js';

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@saudefinanceira.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo12345';

const { app, handle } = createAppContext({ name: 'seed' });
const auth = createAuth({
  config: app.config,
  pool: handle.pool,
  db: app.db,
  mailer: { send: async () => {} },
});

const existing = await app.db
  .selectFrom('authUser')
  .select('id')
  .where('email', '=', EMAIL)
  .executeTakeFirst();
if (existing) {
  console.log(`Usuário ${EMAIL} já existe. Remova-o para recriar.`);
  process.exit(0);
}
const res = await auth.api.signUpEmail({ body: { name: 'Demonstração', email: EMAIL, password: PASSWORD } });
const userId = res.user.id;
const ws = await withUserContext(
  app.db,
  userId,
  async (tx) =>
    (
      await tx
        .selectFrom('memberships')
        .select('workspaceId')
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow()
    ).workspaceId,
);
const actor: Actor = { userId, workspaceId: ws, role: 'owner', channel: 'web' };
await withUserContext(app.db, userId, async (tx) => {
  for (const kind of ['terms', 'privacy', 'llm_processing'] as const)
    await tx.insertInto('consents').values({ userId, kind, version: '2026-10' }).execute();
  await tx.updateTable('workspaces').set({ name: 'Casa' }).where('id', '=', ws).execute();
  await tx
    .updateTable('workspaceSettings')
    .set({ balanceFloorCents: 200_000, variableMonthlyCents: 250_000, usdMinPct: 10, usdMaxPct: 15 })
    .where('workspaceId', '=', ws)
    .execute();
});

const act = async (kind: DraftKind, payload: unknown) =>
  withUserContext(app.db, userId, async (tx) => {
    const d = await createDraft(
      tx,
      actor,
      kind,
      payload as never,
      { title: kind, summary: '', lines: [], warnings: [] },
      null,
      { computeImpact: false },
    );
    return confirmDraft(tx, actor, d.id);
  });
const cat = async (name: string) =>
  withUserContext(
    app.db,
    userId,
    async (tx) =>
      (
        await tx
          .selectFrom('categories')
          .select('id')
          .where('workspaceId', '=', ws)
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
      ).id,
  );

const today = todayISO();
const start = addMonths(startOfMonth(today), -6);
const bb = (
  await act('account', {
    mode: 'create',
    fields: {
      institution: 'Banco do Brasil',
      name: 'BB',
      type: 'checking',
      openingBalanceCents: 820_000,
      openingDate: addDays(start, -1),
      isPrivate: false,
    },
  })
).ids[0]!;
const cresol = (
  await act('account', {
    mode: 'create',
    fields: {
      institution: 'Cresol',
      name: 'Cresol',
      type: 'checking',
      openingBalanceCents: 310_000,
      openingDate: addDays(start, -1),
      isPrivate: false,
    },
  })
).ids[0]!;
await act('account', {
  mode: 'create',
  fields: {
    institution: 'Santander',
    name: 'Santander Poupança',
    type: 'savings',
    openingBalanceCents: 1_250_000,
    openingDate: addDays(start, -1),
    isPrivate: false,
  },
});
// Conta em dólar: a conversão usa a PTAX, que o worker carrega ao subir
const hasPtax = await app.db
  .selectFrom('benchmarks')
  .select('date')
  .where('series', '=', 'PTAX_USD')
  .executeTakeFirst();
if (hasPtax) {
  const nomad = (
    await act('account', {
      mode: 'create',
      fields: {
        institution: 'Nomad',
        name: 'Nomad',
        type: 'checking',
        currency: 'USD',
        openingBalanceCents: 85_000,
        openingDate: addDays(start, -1),
        isPrivate: false,
      },
    })
  ).ids[0]!;
  await act('transfer', {
    fromAccountId: bb,
    toAccountId: nomad,
    amountCents: 280_000,
    toAmountCents: 50_000,
    date: addDays(start, 20),
    description: 'Envio para a Nomad',
  });
} else {
  console.log(
    'PTAX ainda não carregada: a conta Nomad (dólar) não foi criada. Suba o worker e rode de novo.',
  );
}
const card = (
  await act('card', {
    mode: 'create',
    fields: {
      name: 'Santander',
      accountId: bb,
      last4: '4321',
      limitCents: 1_500_000,
      closingDay: 5,
      dueDay: 12,
      isPrivate: false,
    },
  })
).ids[0]!;

// Recorrências (materializam 24+ meses à frente)
const recur = (
  description: string,
  amountCents: number,
  direction: 'in' | 'out',
  day: number,
  category: string,
  accountId: string | null,
  cardId: string | null,
  opts: Record<string, unknown> = {},
) =>
  cat(category).then((categoryId) =>
    act('recurrence', {
      mode: 'create',
      fields: {
        accountId,
        cardId,
        description,
        amountCents,
        direction,
        categoryId,
        rule: `FREQ=MONTHLY;BYMONTHDAY=${day}`,
        startDate: addDays(today, 1),
        autoPost: direction === 'in' || Boolean(cardId),
        isBill: direction === 'out' && !cardId,
        ...opts,
      },
    }),
  );
await recur('Salário', 850_000, 'in', 5, 'Salário', bb, null);
await recur('Aluguel', 250_000, 'out', 10, 'Aluguel', bb, null);
await recur('Conta de luz', 23_000, 'out', 15, 'Energia', bb, null, {
  amountMode: 'average_n_months',
  averageMonths: 3,
});
await recur('Internet', 11_990, 'out', 20, 'Internet e telefone', cresol, null);
await recur('Netflix', 5_590, 'out', 8, 'Assinaturas', null, card);
await recur('Previsc (participante)', 45_000, 'out', 25, 'Previdência', bb, null);

// Histórico de 6 meses: salário, aluguel e gastos variáveis
const items: unknown[] = [];
const variable: Array<[string, string, number]> = [
  ['Supermercado Bom Preço', 'Mercado', 68_000],
  ['Padaria', 'Mercado', 9_500],
  ['Posto Shell', 'Combustível', 25_000],
  ['iFood', 'Restaurantes', 14_000],
  ['Farmácia São João', 'Farmácia', 7_800],
  ['Cinema', 'Lazer', 9_000],
];
for (let m = 0; m < 6; m++) {
  const month = addMonths(start, m);
  items.push({
    accountId: bb,
    date: addDays(month, 4),
    amountCents: 850_000,
    direction: 'in',
    categoryId: await cat('Salário'),
    description: 'Salário',
  });
  items.push({
    accountId: bb,
    date: addDays(month, 9),
    amountCents: 250_000,
    direction: 'out',
    categoryId: await cat('Aluguel'),
    description: 'Aluguel',
  });
  items.push({
    accountId: bb,
    date: addDays(month, 14),
    amountCents: 21_000 + m * 900,
    direction: 'out',
    categoryId: await cat('Energia'),
    description: 'Conta de luz',
  });
  for (const [i, [desc, c, base]] of variable.entries()) {
    const wobble = Math.round(base * (0.8 + ((m * 7 + i * 3) % 5) / 10));
    items.push({
      cardId: i % 2 === 0 ? card : null,
      accountId: i % 2 === 0 ? null : cresol,
      date: addDays(month, 3 + i * 4),
      amountCents: wobble,
      direction: 'out',
      categoryId: await cat(c),
      description: desc,
    });
  }
}
await act('transactions', { items: items.filter((i) => (i as { date: string }).date <= today) });
// Compra parcelada recente
await act('transactions', {
  items: [
    {
      cardId: card,
      date: addDays(today, -20),
      amountCents: 360_000,
      direction: 'out',
      categoryId: await cat('Eletrônicos'),
      description: 'TV 55"',
      installments: 10,
    },
  ],
});

// Faturas passadas pagas pela conta BB
const pastStatements = await withUserContext(app.db, userId, (tx) =>
  tx
    .selectFrom('cardStatementTotals')
    .select(['id', 'totalCents', 'dueDate'])
    .where('workspaceId', '=', ws)
    .where('dueDate', '<', today)
    .execute(),
);
for (const st of pastStatements) {
  if (Number(st.totalCents) > 0)
    await act('card_payment', {
      statementId: st.id,
      accountId: bb,
      amountCents: Number(st.totalCents),
      date: st.dueDate,
    });
}

// Previdência
for (let m = 0; m < 6; m++) {
  await act('pension_entry', {
    newPlan: m === 0 ? { provider: 'Previsc', name: 'Previsc Plano CD' } : null,
    planId:
      m === 0
        ? null
        : (
            await withUserContext(app.db, userId, (tx) =>
              tx
                .selectFrom('pensionPlans')
                .select('id')
                .where('workspaceId', '=', ws)
                .executeTakeFirstOrThrow(),
            )
          ).id,
    refMonth: addMonths(start, m),
    balanceCents: 18_500_000 + m * 140_000,
    participantCents: 45_000,
    sponsorCents: 45_000,
  });
}
await act('retirement_profile', {
  birthDate: '1986-07-20',
  retireAge: 60,
  endAge: 90,
  accumulationRate: 0.04,
  withdrawalRate: 0.03,
  contributionGrowth: 0,
  inssMonthlyCents: 350_000,
  targetIncomeCents: null,
  includeInvestments: false,
});

// Carteira
const asset = (ticker: string | null, name: string, kind: string, currency: 'BRL' | 'USD' = 'BRL') =>
  withUserContext(app.db, userId, (tx) => resolveAsset(tx, ws, { ticker, name, kind, currency }));
const itub = await asset('ITUB4', 'Itaú Unibanco PN', 'stock');
const taee = await asset('TAEE11', 'Taesa UNT', 'stock');
const hglg = await asset('HGLG11', 'CSHG Logística', 'fii');
const usd = await asset(null, 'Dólar', 'cash_usd', 'USD');
const cdb = await asset(null, 'CDB Cresol 110% CDI', 'fixed_income');
await act('trades', {
  trades: [
    {
      assetId: itub.id,
      broker: 'XP',
      date: addDays(start, 10),
      kind: 'buy',
      qty: 300,
      priceCents: 3120,
      feesCents: 150,
      totalCents: 936_150,
    },
    {
      assetId: taee.id,
      broker: 'XP',
      date: addDays(start, 40),
      kind: 'buy',
      qty: 100,
      priceCents: 3480,
      feesCents: 80,
      totalCents: 348_080,
    },
    {
      assetId: hglg.id,
      broker: 'XP',
      date: addDays(start, 70),
      kind: 'buy',
      qty: 20,
      priceCents: 15_900,
      feesCents: 60,
      totalCents: 318_060,
    },
    {
      assetId: usd.id,
      broker: 'Wise',
      date: addDays(start, 30),
      kind: 'buy',
      qty: 2000,
      priceCents: 100,
      feesCents: 0,
      totalCents: 1_084_000,
      fxRate: 5.42,
    },
    {
      assetId: cdb.id,
      broker: 'Cresol',
      date: addDays(start, 5),
      kind: 'contribution',
      qty: 1,
      priceCents: 2_000_000,
      feesCents: 0,
      totalCents: 2_000_000,
    },
    {
      assetId: cdb.id,
      broker: 'Cresol',
      date: addDays(today, -2),
      kind: 'valuation',
      qty: 1,
      priceCents: 2_106_000,
      feesCents: 0,
      totalCents: 2_106_000,
    },
  ],
});
await act('allocation_targets', {
  targets: [
    { assetClass: 'fixed_income', targetPct: 40 },
    { assetClass: 'equities', targetPct: 25 },
    { assetClass: 'usd', targetPct: 12 },
    { assetClass: 'pension', targetPct: 18 },
    { assetClass: 'cash', targetPct: 5 },
  ],
});
await act('goal', {
  mode: 'create',
  fields: {
    name: 'Viagem Europa',
    kind: 'travel',
    targetCents: 2_400_000,
    savedCents: 300_000,
    monthlyContributionCents: 150_000,
    startMonth: addMonths(startOfMonth(today), 1),
    targetDate: addMonths(today, 14),
  },
});
await act('budget', { categoryId: await cat('Mercado'), amountCents: 80_000, alertPct: 90 });
await act('budget', { categoryId: await cat('Restaurantes'), amountCents: 20_000, alertPct: 100 });

const { refreshInsights } = await import('../src/domain/insights.js');
await withUserContext(app.db, userId, (tx) => refreshInsights(tx, ws, today));
void sql;
console.log(`Pronto! Entre com ${EMAIL} / ${PASSWORD}`);
await handle.close();
