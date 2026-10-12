import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { DB } from './generated.js';

export type { DB } from './generated.js';
export { sql } from 'kysely';
export type { Kysely, Transaction, Selectable, Insertable, Updateable } from 'kysely';

// int8 → number (centavos cabem com folga em 2^53), numeric → number, date → string ISO.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(
  connectionString: string,
  opts: { max?: number; applicationName?: string } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'saude-financeira',
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
  return { db, pool, close: () => db.destroy() };
}

/**
 * Executa `fn` numa transação com `app.user_id` definido, para que a RLS do Postgres
 * filtre tudo pelo usuário autenticado. É o único caminho de acesso a dados de domínio.
 */
export async function withUserContext<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!userId) throw new Error('withUserContext: userId obrigatório');
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** Erros do Postgres que viram respostas 4xx. */
export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
