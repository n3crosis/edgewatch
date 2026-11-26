import postgres from 'postgres';
import { type PgClient, type PgRows, postgresDatabase } from './postgres';
import type { SqlDatabase } from './storage';

export interface PostgresConnection {
  db: SqlDatabase;
  close(): Promise<void>;
}

type Driver = postgres.Sql | postgres.TransactionSql;

function client(sql: Driver, begin?: postgres.Sql['begin']): PgClient {
  return {
    query: async (text, params) => (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as PgRows,
    transaction: async <T>(fn: (tx: PgClient) => Promise<T>) => (begin ? ((await begin((tx) => fn(client(tx)))) as T) : fn(client(sql))),
  };
}

/**
 * Opens Postgres through postgres.js, e.g. with a Hyperdrive binding's `connectionString`. Counts (int8) and numerics
 * are parsed to numbers like D1 returns them. Call `close()` when the request or batch is done.
 */
export function connectPostgres(url: string, options: { max?: number } = {}): PostgresConnection {
  const sql = postgres(url, {
    max: options.max ?? 5,
    fetch_types: false,
    onnotice: () => {},
    types: { number: { to: 20, from: [20, 1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
  });
  return { db: postgresDatabase(client(sql, sql.begin.bind(sql))), close: () => sql.end({ timeout: 5 }) };
}
