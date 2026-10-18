import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '../../packages/db/src/index.js';
import { hasDb, insertAccount, insertTx, setupEnv, type TestEnv } from './helpers.js';

// Tabelas de domínio com workspace_id: nenhuma pode vazar entre tenants.
const DOMAIN_TABLES = [
  'accounts',
  'cards',
  'categories',
  'attachments',
  'card_statements',
  'recurrences',
  'transactions',
  'pension_plans',
  'pension_entries',
  'conversations',
  'messages',
  'drafts',
  'audit_log',
  'reminder_prefs',
  'retirement_profiles',
  'reminders',
  'projection_snapshots',
  'categorization_rules',
  'budgets',
  'goals',
  'planned_cashflows',
  'seasonal_items',
  'llm_usage',
  'trades',
  'allocation_targets',
  'insights',
  'insight_mutes',
  'workspace_settings',
  'memberships',
  'invites',
  'agent_memories',
  'user_financial_profiles',
  'agent_nudges',
  'agent_nudge_mutes',
] as const;

describe.skipIf(!hasDb)('RLS: isolamento entre tenants', () => {
  let env: TestEnv;
  let alice: string, bob: string, carol: string, victor: string;
  let wsA: string, wsB: string;
  let accA: string;

  beforeAll(async () => {
    env = setupEnv();
    alice = await env.createUser('Alice');
    bob = await env.createUser('Bob');
    carol = await env.createUser('Carol');
    victor = await env.createUser('Victor');
    wsA = await env.createWorkspace(alice, 'Família A');
    wsB = await env.createWorkspace(bob, 'Família B');
    await env.addMember(wsA, carol, 'member');
    await env.addMember(wsA, victor, 'viewer');

    // Popula o workspace A com uma linha em cada tabela (como superusuário)
    const o = env.owner.db;
    accA = await insertAccount(o, wsA, { openingBalanceCents: 100_000, openingDate: '2026-10-01' });
    const card = await o
      .insertInto('cards')
      .values({ workspaceId: wsA, name: 'Santander', closingDay: 5, dueDay: 12, accountId: accA })
      .returning('id')
      .executeTakeFirstOrThrow();
    const cat = await o
      .selectFrom('categories')
      .select('id')
      .where('workspaceId', '=', wsA)
      .executeTakeFirstOrThrow();
    const att = await o
      .insertInto('attachments')
      .values({
        workspaceId: wsA,
        storageKey: 'k',
        filename: 'f.pdf',
        mime: 'application/pdf',
        sizeBytes: 1,
        sha256: 'x',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await insertTx(o, wsA, { cardId: card.id, date: '2026-10-11', amountCents: 1000, direction: 'out' });
    await o
      .insertInto('recurrences')
      .values({
        workspaceId: wsA,
        accountId: accA,
        description: 'Salário',
        amountCents: 850_000,
        direction: 'in',
        rule: 'FREQ=MONTHLY;BYMONTHDAY=5',
        startDate: '2026-11-05',
      })
      .execute();
    const plan = await o
      .insertInto('pensionPlans')
      .values({ workspaceId: wsA, provider: 'Previsc', name: 'Plano' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await o
      .insertInto('pensionEntries')
      .values({ workspaceId: wsA, planId: plan.id, refMonth: '2026-09-01', balanceCents: 1 })
      .execute();
    const conv = await o
      .insertInto('conversations')
      .values({ workspaceId: wsA, userId: alice, channel: 'web' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await o
      .insertInto('messages')
      .values({ workspaceId: wsA, conversationId: conv.id, userId: alice, role: 'user', content: 'oi' })
      .execute();
    const draft = await o
      .insertInto('drafts')
      .values({ workspaceId: wsA, createdBy: alice, kind: 'transactions', payload: '{}', preview: '{}' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await o
      .insertInto('auditLog')
      .values({
        workspaceId: wsA,
        actorId: alice,
        action: 'create',
        entity: 'transactions',
        draftId: draft.id,
      })
      .execute();
    await o
      .insertInto('reminderPrefs')
      .values({ workspaceId: wsA, userId: alice, kind: 'weekly_summary' })
      .execute();
    await o
      .insertInto('retirementProfiles')
      .values({ workspaceId: wsA, userId: alice, birthDate: '1985-03-15' })
      .execute();
    await o
      .insertInto('seasonalItems')
      .values({ workspaceId: wsA, key: 'ipva', label: 'IPVA', kind: 'expense', direction: 'out' })
      .execute();
    await o
      .insertInto('reminders')
      .values({
        workspaceId: wsA,
        userId: alice,
        kind: 'due_bill',
        fireAt: new Date(),
        dedupeKey: `t-${wsA}`,
      })
      .execute();
    await o
      .insertInto('projectionSnapshots')
      .values({ workspaceId: wsA, userId: alice, months: '[]' })
      .execute();
    await o
      .insertInto('categorizationRules')
      .values({ workspaceId: wsA, pattern: 'padaria', categoryId: cat.id })
      .execute();
    await o
      .insertInto('budgets')
      .values({ workspaceId: wsA, categoryId: cat.id, amountCents: 100 })
      .execute();
    await o.insertInto('goals').values({ workspaceId: wsA, name: 'Reserva', targetCents: 100 }).execute();
    await o
      .insertInto('plannedCashflows')
      .values({ workspaceId: wsA, date: '2026-12-01', amountCents: 1, direction: 'in', source: 'manual' })
      .execute();
    await o
      .insertInto('llmUsage')
      .values({ workspaceId: wsA, provider: 'fake', model: 'm', purpose: 'chat' })
      .execute();
    const asset = await o
      .insertInto('assets')
      .values({ workspaceId: wsA, kind: 'fixed_income', name: 'CDB' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await o
      .insertInto('trades')
      .values({
        workspaceId: wsA,
        assetId: asset.id,
        date: '2026-10-01',
        kind: 'buy',
        qty: 1,
        priceCents: 100,
        totalCents: 100,
      })
      .execute();
    await o
      .insertInto('allocationTargets')
      .values({ workspaceId: wsA, assetClass: 'usd', targetPct: 10 })
      .execute();
    await o
      .insertInto('insights')
      .values({
        workspaceId: wsA,
        rule: 'usd_exposure',
        severity: 'info',
        title: 't',
        message: 'm',
        fingerprint: 'f',
      })
      .execute();
    await o.insertInto('insightMutes').values({ workspaceId: wsA, rule: 'fees' }).execute();
    await o
      .insertInto('invites')
      .values({
        workspaceId: wsA,
        email: 'x@example.test',
        role: 'member',
        tokenHash: `h-${wsA}`,
        invitedBy: alice,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .execute();
    await o
      .insertInto('agentMemories')
      .values([
        {
          workspaceId: wsA,
          userId: alice,
          category: 'objetivo',
          key: 'objetivo.carro',
          content: 'Quer trocar de carro',
        },
        {
          workspaceId: wsA,
          userId: alice,
          category: 'familia',
          key: 'familia.filho',
          content: 'Filho nasce em março',
          scope: 'household',
        },
        {
          workspaceId: wsA,
          userId: alice,
          category: 'perfil',
          key: 'perfil.saude',
          content: 'Sensível pendente',
          scope: 'household',
          status: 'pending',
          sensitive: true,
        },
      ])
      .execute();
    await o
      .insertInto('userFinancialProfiles')
      .values({ workspaceId: wsA, userId: alice, dependents: 1 })
      .execute();
    await o
      .insertInto('agentNudges')
      .values({
        workspaceId: wsA,
        userId: alice,
        kind: 'goal_behind',
        type: 'nudge',
        category: 'meta',
        fingerprint: 'f',
        title: 't',
        message: 'm',
      })
      .execute();
    await o
      .insertInto('agentNudgeMutes')
      .values({ workspaceId: wsA, userId: alice, kind: 'profile_gap' })
      .execute();
    void att;
  });

  it('sugestões do assistente: só o próprio usuário vê e altera', async () => {
    const n = (u: string) =>
      env.as(
        u,
        async (tx) =>
          (await tx.selectFrom('agentNudges').select('id').where('workspaceId', '=', wsA).execute()).length,
      );
    expect(await n(alice)).toBe(1);
    expect(await n(carol)).toBe(0);
    const upd = await env.as(carol, (tx) =>
      tx
        .updateTable('agentNudges')
        .set({ status: 'dismissed' })
        .where('workspaceId', '=', wsA)
        .executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    await expect(
      env.as(carol, (tx) =>
        tx.insertInto('agentNudgeMutes').values({ workspaceId: wsA, userId: alice, kind: 'x_y_z' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('inscrições de push: só o próprio usuário vê e apaga', async () => {
    const endpoint = `https://push.example.test/rls-${Date.now()}`;
    await env.as(alice, (tx) => sql`select claim_push_subscription(${endpoint}, 'p', 'a', null)`.execute(tx));
    const n = (u: string) =>
      env.as(u, async (tx) => (await tx.selectFrom('pushSubscriptions').select('id').execute()).length);
    expect(await n(alice)).toBe(1);
    expect(await n(carol)).toBe(0);
    const del = await env.as(carol, (tx) =>
      tx.deleteFrom('pushSubscriptions').where('endpoint', '=', endpoint).executeTakeFirst(),
    );
    expect(Number(del.numDeletedRows)).toBe(0);
    await expect(
      env.as(carol, (tx) =>
        tx
          .insertInto('pushSubscriptions')
          .values({ userId: alice, endpoint: `${endpoint}-x`, p256dh: 'p', auth: 'a' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      (await sql<{ n: number }>`select count(*)::int as n from push_subscriptions`.execute(env.app.db))
        .rows[0]!.n,
    ).toBe(0);
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it.each(DOMAIN_TABLES)('%s: usuário de outro tenant não lê nada do workspace A', async (table) => {
    const n = await env.as(bob, async (tx) => {
      const r = await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(table)} where workspace_id = ${wsA}::uuid`.execute(tx);
      return r.rows[0]!.n;
    });
    expect(n).toBe(0);
  });

  it.each(DOMAIN_TABLES)('%s: sem app.user_id nada é visível', async (table) => {
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(
      env.app.db,
    );
    expect(r.rows[0]!.n).toBe(0);
  });

  it('o dono enxerga os próprios dados', async () => {
    const n = await env.as(
      alice,
      async (tx) =>
        (await tx.selectFrom('transactions').select('id').where('workspaceId', '=', wsA).execute()).length,
    );
    expect(n).toBe(1);
  });

  it('outro tenant não consegue gravar no workspace A', async () => {
    await expect(
      env.as(bob, (tx) =>
        insertTx(tx, wsA, { accountId: accA, date: '2026-10-11', amountCents: 1, direction: 'out' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('viewer lê mas não grava', async () => {
    const n = await env.as(
      victor,
      async (tx) =>
        (await tx.selectFrom('accounts').select('id').where('workspaceId', '=', wsA).execute()).length,
    );
    expect(n).toBe(1);
    await expect(
      env.as(victor, (tx) =>
        insertTx(tx, wsA, { accountId: accA, date: '2026-10-11', amountCents: 1, direction: 'out' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('memória do agente: pessoal só para o dono, compartilhada ativa para o workspace; ninguém altera a alheia', async () => {
    const seen = (u: string) =>
      env.as(u, (tx) =>
        tx.selectFrom('agentMemories').select('key').where('workspaceId', '=', wsA).orderBy('key').execute(),
      );
    expect((await seen(alice)).map((r) => r.key)).toEqual([
      'familia.filho',
      'objetivo.carro',
      'perfil.saude',
    ]);
    expect((await seen(carol)).map((r) => r.key)).toEqual(['familia.filho']);
    expect((await seen(victor)).map((r) => r.key)).toEqual(['familia.filho']);
    const upd = await env.as(carol, (tx) =>
      tx.updateTable('agentMemories').set({ content: 'x' }).where('workspaceId', '=', wsA).executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    await expect(
      env.as(carol, (tx) =>
        tx
          .insertInto('agentMemories')
          .values({ workspaceId: wsA, userId: alice, category: 'contexto', key: 'contexto.x', content: 'xx' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // leitor tem memória e perfil próprios
    await env.as(victor, (tx) =>
      tx
        .insertInto('agentMemories')
        .values({
          workspaceId: wsA,
          userId: victor,
          category: 'contexto',
          key: 'contexto.v',
          content: 'Leitor',
        })
        .execute(),
    );
    const prof = await env.as(carol, (tx) =>
      tx.selectFrom('userFinancialProfiles').select('userId').where('workspaceId', '=', wsA).execute(),
    );
    expect(prof).toHaveLength(0);
  });

  it('perfil de aposentadoria: só o próprio usuário lê e grava; leitor não grava o seu', async () => {
    const carolSees = await env.as(
      carol,
      async (tx) =>
        (await tx.selectFrom('retirementProfiles').select('userId').where('workspaceId', '=', wsA).execute())
          .length,
    );
    expect(carolSees).toBe(0);
    const aliceSees = await env.as(
      alice,
      async (tx) =>
        (await tx.selectFrom('retirementProfiles').select('userId').where('workspaceId', '=', wsA).execute())
          .length,
    );
    expect(aliceSees).toBe(1);
    await expect(
      env.as(carol, (tx) =>
        tx
          .insertInto('retirementProfiles')
          .values({ workspaceId: wsA, userId: alice, birthDate: '1990-01-01' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      env.as(victor, (tx) =>
        tx
          .insertInto('retirementProfiles')
          .values({ workspaceId: wsA, userId: victor, birthDate: '1990-01-01' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('conta privada só é visível para o dono, com suas transações', async () => {
    const priv = await env.as(carol, (tx) =>
      insertAccount(tx, wsA, {
        name: 'Privada',
        openingBalanceCents: 1,
        openingDate: '2026-10-01',
        isPrivate: true,
        ownerUserId: carol,
      }),
    );
    await env.as(carol, (tx) =>
      insertTx(tx, wsA, { accountId: priv, date: '2026-10-10', amountCents: 500, direction: 'out' }),
    );
    const aliceSees = await env.as(alice, async (tx) => ({
      acc: (await tx.selectFrom('accounts').select('id').where('id', '=', priv).execute()).length,
      txs: (await tx.selectFrom('transactions').select('id').where('accountId', '=', priv).execute()).length,
    }));
    expect(aliceSees).toEqual({ acc: 0, txs: 0 });
    const carolSees = await env.as(
      carol,
      async (tx) =>
        (await tx.selectFrom('transactions').select('id').where('accountId', '=', priv).execute()).length,
    );
    expect(carolSees).toBe(1);
  });

  it('membro não pode criar conta privada em nome de outro', async () => {
    await expect(
      env.as(carol, (tx) =>
        insertAccount(tx, wsA, {
          openingBalanceCents: 1,
          openingDate: '2026-10-01',
          isPrivate: true,
          ownerUserId: alice,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('app_user não consegue desligar a RLS', async () => {
    await expect(
      env.as(bob, async (tx) => {
        await sql`set local row_security = off`.execute(tx);
        await sql`select count(*) from transactions`.execute(tx);
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('não é possível chamar seed_workspace diretamente', async () => {
    await expect(env.as(bob, (tx) => sql`select seed_workspace(${wsA}::uuid)`.execute(tx))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('membro comum não altera papéis; só o owner', async () => {
    const r = await env.as(carol, (tx) =>
      tx
        .updateTable('memberships')
        .set({ role: 'owner' })
        .where('userId', '=', carol)
        .where('workspaceId', '=', wsA)
        .executeTakeFirst(),
    );
    expect(r.numUpdatedRows).toBe(0n);
  });
});
