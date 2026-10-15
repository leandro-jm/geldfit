import { randomUUID } from 'node:crypto';
import {
  createDb,
  sql,
  withUserContext,
  type Db,
  type DbHandle,
  type Tx,
} from '../../packages/db/src/index.js';

export const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL_OWNER);

export interface TestEnv {
  owner: DbHandle; // superusuário (setup/cleanup)
  app: DbHandle; // app_user (sujeito a RLS)
  users: string[];
  workspaces: string[];
  createUser(name?: string): Promise<string>;
  createWorkspace(userId: string, name?: string): Promise<string>;
  addMember(ws: string, userId: string, role: 'member' | 'viewer' | 'owner'): Promise<void>;
  as<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  cleanup(): Promise<void>;
}

export function setupEnv(): TestEnv {
  const owner = createDb(process.env.DATABASE_URL_OWNER!.replace('?sslmode=disable', ''), { max: 2 });
  const app = createDb(process.env.DATABASE_URL!, { max: 4 });
  const env: TestEnv = {
    owner,
    app,
    users: [],
    workspaces: [],
    async createUser(name = 'Teste') {
      const id = `test_${randomUUID()}`;
      await owner.db
        .insertInto('authUser')
        .values({ id, name, email: `${id}@example.test`, emailVerified: true })
        .execute();
      env.users.push(id);
      return id;
    },
    async createWorkspace(userId, name = 'WS') {
      const ws = await withUserContext(app.db, userId, async (tx) => {
        const r = await sql<{ id: string }>`select create_workspace(${name}) as id`.execute(tx);
        return r.rows[0]!.id;
      });
      env.workspaces.push(ws);
      return ws;
    },
    async addMember(ws, userId, role) {
      await owner.db.insertInto('memberships').values({ workspaceId: ws, userId, role }).execute();
    },
    as(userId, fn) {
      return withUserContext(app.db, userId, fn);
    },
    async cleanup() {
      if (env.workspaces.length)
        await owner.db.deleteFrom('workspaces').where('id', 'in', env.workspaces).execute();
      if (env.users.length) await owner.db.deleteFrom('authUser').where('id', 'in', env.users).execute();
      await app.close();
      await owner.close();
    },
  };
  return env;
}

export async function insertAccount(
  tx: Tx | Db,
  ws: string,
  v: {
    name?: string;
    openingBalanceCents: number;
    openingDate: string;
    isPrivate?: boolean;
    ownerUserId?: string | null;
    type?: 'checking' | 'savings' | 'investment' | 'cash';
    currency?: 'BRL' | 'USD';
  },
) {
  const r = await tx
    .insertInto('accounts')
    .values({
      workspaceId: ws,
      institution: 'Banco do Brasil',
      type: v.type ?? 'checking',
      currency: v.currency ?? 'BRL',
      name: v.name ?? 'BB',
      openingBalanceCents: v.openingBalanceCents,
      openingDate: v.openingDate,
      isPrivate: v.isPrivate ?? false,
      ownerUserId: v.ownerUserId ?? null,
      // conta criada "antes" dos lançamentos do dia de abertura
      createdAt: new Date('2000-01-01T00:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

/** PTAX de teste (tabela global, sem workspace): apague com `clearTestPtax` ao final. */
export async function insertPtax(owner: Db, date: string, value: number) {
  await sql`insert into benchmarks (series, date, value, source) values ('PTAX_USD', ${date}::date, ${value}, 'test')
    on conflict (series, date) do update set value = excluded.value, source = excluded.source`.execute(owner);
}

export async function clearTestPtax(owner: Db) {
  await sql`delete from benchmarks where series = 'PTAX_USD' and source = 'test'`.execute(owner);
}

export async function insertTx(
  tx: Tx | Db,
  ws: string,
  v: {
    accountId?: string | null;
    cardId?: string | null;
    date: string;
    amountCents: number;
    direction: 'in' | 'out';
    status?: 'posted' | 'scheduled';
    description?: string;
    recurrenceId?: string | null;
    installmentGroupId?: string | null;
    installmentN?: number | null;
    installmentTotal?: number | null;
    kind?: 'regular' | 'transfer' | 'card_payment';
    transferId?: string | null;
    paysStatementId?: string | null;
  },
) {
  const r = await tx
    .insertInto('transactions')
    .values({
      workspaceId: ws,
      accountId: v.accountId ?? null,
      cardId: v.cardId ?? null,
      date: v.date,
      amountCents: v.amountCents,
      direction: v.direction,
      status: v.status ?? 'posted',
      description: v.description ?? 'teste',
      recurrenceId: v.recurrenceId ?? null,
      installmentGroupId: v.installmentGroupId ?? null,
      installmentN: v.installmentN ?? null,
      installmentTotal: v.installmentTotal ?? null,
      kind: v.kind ?? 'regular',
      transferId: v.transferId ?? null,
      paysStatementId: v.paysStatementId ?? null,
    })
    .returning(['id', 'cardStatementId'])
    .executeTakeFirstOrThrow();
  return r;
}

export async function project(tx: Tx, ws: string, today: string, account: string | null = null) {
  const r = await sql<{
    month: string;
    openingCents: number;
    incomeCents: number;
    expenseCents: number;
    cardBillsCents: number;
    variableCents: number;
    goalsCents: number;
    closingCents: number;
    closingOptimisticCents: number;
    closingPessimisticCents: number;
    belowFloor: boolean;
  }>`select * from project(${ws}::uuid, 24, ${account}::uuid, ${today}::date)`.execute(tx);
  return r.rows;
}
