import { toParam } from './postgres';
import { toMysql, type MysqlQuery } from './sql-dialect';
import type { SqlDatabase, SqlResult, SqlStatement } from './storage';

export interface MysqlResult {
  rows: Record<string, unknown>[];
  /** Rows a write affected (an upsert that updates counts 2, as MySQL reports it). */
  affectedRows: number;
}

/** The two calls the adapter needs from a MySQL driver (mysql2 in `./mysql2`). */
export interface MysqlClient {
  query(text: string, params: unknown[]): Promise<MysqlResult>;
  transaction<T>(fn: (tx: MysqlClient) => Promise<T>): Promise<T>;
}

const translations = new Map<string, MysqlQuery>();
function translate(sql: string): MysqlQuery {
  let query = translations.get(sql);
  if (query === undefined) {
    query = toMysql(sql);
    if (translations.size >= 1000) translations.clear();
    translations.set(sql, query);
  }
  return query;
}

class MysqlStatement implements SqlStatement {
  constructor(
    readonly client: MysqlClient,
    readonly query: MysqlQuery,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): MysqlStatement {
    const bound = values.map(toParam);
    const params = this.query.order.map((i) => {
      if (i >= bound.length) throw new RangeError(`Missing SQL parameter ${i + 1} (got ${bound.length})`);
      return bound[i];
    });
    return new MysqlStatement(this.client, this.query, params);
  }

  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(column?: string): Promise<T | null> {
    const row = (await this.client.query(this.query.text, this.params)).rows[0];
    if (!row) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const { rows, affectedRows } = await this.client.query(this.query.text, this.params);
    return { results: rows as T[], meta: { changes: affectedRows } };
  }

  run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.all<T>();
  }
}

/** A `SqlDatabase` over MySQL 8.0.19+: queries are translated from SQLite syntax and `batch` runs in one transaction. */
export function mysqlDatabase(client: MysqlClient): SqlDatabase {
  return {
    prepare: (sql) => new MysqlStatement(client, translate(sql)),
    batch: <T>(statements: SqlStatement[]) =>
      client.transaction(async (tx) => {
        const results: SqlResult<T>[] = [];
        for (const s of statements) {
          if (!(s instanceof MysqlStatement)) throw new TypeError('batch() only accepts statements from the same database');
          results.push(await new MysqlStatement(tx, s.query, s.params).all<T>());
        }
        return results;
      }),
  };
}
