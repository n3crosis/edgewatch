import type { SqlDatabase, SqlResult, SqlStatement } from './storage';

/** The values libSQL binds (a subset of `@libsql/client`'s InValue). */
export type LibsqlValue = null | string | number | bigint | ArrayBuffer | Uint8Array;

/** Binds like D1: booleans as 1/0, `undefined` rejected. */
export function toLibsqlValue(value: unknown): LibsqlValue {
  if (value === undefined) throw new TypeError('Type undefined is not supported as a SQL parameter');
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return value;
  throw new TypeError(`Type ${typeof value} is not supported as a SQL parameter`);
}

/** The parts of a libSQL result the adapter reads (`@libsql/client` ResultSet). */
export interface LibsqlResultSet {
  columns: string[];
  rows: ArrayLike<unknown>[];
  rowsAffected: number;
}

/** The two calls the adapter needs from `@libsql/client` (see `./libsql-client`). */
export interface LibsqlClient {
  execute(stmt: { sql: string; args: LibsqlValue[] }): Promise<LibsqlResultSet>;
  batch(stmts: { sql: string; args: LibsqlValue[] }[], mode: 'write'): Promise<LibsqlResultSet[]>;
}

/** libSQL can return BigInt for integers outside the safe range; D1 returns numbers. */
function toObjects(rs: LibsqlResultSet): Record<string, unknown>[] {
  return Array.from(rs.rows, (row) => {
    const out: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      const v = row[i];
      out[c] = typeof v === 'bigint' ? Number(v) : v;
    });
    return out;
  });
}

const toResult = <T>(rs: LibsqlResultSet): SqlResult<T> => ({ results: toObjects(rs) as T[], meta: { changes: rs.rowsAffected } });

class LibsqlStatement implements SqlStatement {
  constructor(
    readonly client: LibsqlClient,
    readonly sql: string,
    readonly args: LibsqlValue[] = [],
  ) {}

  bind(...values: unknown[]): LibsqlStatement {
    return new LibsqlStatement(this.client, this.sql, values.map(toLibsqlValue));
  }

  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(column?: string): Promise<T | null> {
    const row = toObjects(await this.client.execute({ sql: this.sql, args: this.args }))[0];
    if (!row) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return toResult<T>(await this.client.execute({ sql: this.sql, args: this.args }));
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.all<T>();
  }
}

/** A `SqlDatabase` over libSQL / Turso. It speaks SQLite, so queries run untranslated; `batch` is one write transaction. */
export function libsqlDatabase(client: LibsqlClient): SqlDatabase {
  return {
    prepare: (sql) => new LibsqlStatement(client, sql),
    batch: async <T>(statements: SqlStatement[]) => {
      const stmts = statements.map((s) => {
        if (!(s instanceof LibsqlStatement)) throw new TypeError('batch() only accepts statements from the same database');
        return { sql: s.sql, args: s.args };
      });
      return (await client.batch(stmts, 'write')).map((rs) => toResult<T>(rs));
    },
  };
}
