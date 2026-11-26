import { toPostgres } from './sql-dialect';
import type { SqlDatabase, SqlResult, SqlStatement } from './storage';

/** Rows from a Postgres driver; `count` is the number of rows a write affected. */
export type PgRows = Record<string, unknown>[] & { count?: number | null };

/** The two calls the adapter needs from a Postgres driver (postgres.js in `./postgres-js`). */
export interface PgClient {
  query(text: string, params: unknown[]): Promise<PgRows>;
  transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;
}

/** D1 converts booleans to 1/0 and rejects undefined; match it so both stores accept the same binds. */
export function toParam(value: unknown): unknown {
  if (value === undefined) throw new TypeError('Type undefined is not supported as a SQL parameter');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const translations = new Map<string, string>();
function translate(sql: string): string {
  let text = translations.get(sql);
  if (text === undefined) {
    text = toPostgres(sql);
    if (translations.size >= 1000) translations.clear();
    translations.set(sql, text);
  }
  return text;
}

class PgStatement implements SqlStatement {
  constructor(
    readonly client: PgClient,
    readonly text: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): PgStatement {
    return new PgStatement(this.client, this.text, values.map(toParam));
  }

  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(column?: string): Promise<T | null> {
    const row = (await this.client.query(this.text, this.params))[0];
    if (!row) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = await this.client.query(this.text, this.params);
    return { results: [...rows] as T[], meta: { changes: rows.count ?? 0 } };
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.all<T>();
  }
}

/** A `SqlDatabase` over Postgres: queries are translated from SQLite syntax and `batch` runs in one transaction. */
export function postgresDatabase(client: PgClient): SqlDatabase {
  return {
    prepare: (sql) => new PgStatement(client, translate(sql)),
    batch: <T>(statements: SqlStatement[]) =>
      client.transaction(async (tx) => {
        const results: SqlResult<T>[] = [];
        for (const s of statements) {
          if (!(s instanceof PgStatement)) throw new TypeError('batch() only accepts statements from the same database');
          results.push(await new PgStatement(tx, s.text, s.params).all<T>());
        }
        return results;
      }),
  };
}
