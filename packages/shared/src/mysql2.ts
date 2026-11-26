import type { FieldPacket, Pool, PoolConnection, QueryResult } from 'mysql2/promise';
import { type MysqlClient, type MysqlResult, mysqlDatabase } from './mysql';
import { MYSQL_SESSION } from './sql-dialect';
import type { SqlDatabase } from './storage';

export interface MysqlConnection {
  db: SqlDatabase;
  close(): Promise<void>;
}

type Query = (text: string, params: unknown[]) => Promise<[QueryResult, FieldPacket[]]>;

function result([rows]: [QueryResult, FieldPacket[]]): MysqlResult {
  if (Array.isArray(rows)) return { rows: rows as Record<string, unknown>[], affectedRows: 0 };
  return { rows: [], affectedRows: 'affectedRows' in rows ? rows.affectedRows : 0 };
}

function client(query: Query, begin?: () => Promise<PoolConnection>): MysqlClient {
  return {
    query: async (text, params) => result(await query(text, params)),
    transaction: async <T>(fn: (tx: MysqlClient) => Promise<T>) => {
      if (!begin) return fn(client(query));
      const conn = await begin();
      try {
        await conn.beginTransaction();
        const out = await fn(client((t, p) => conn.query(t, p)));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
  };
}

/**
 * Opens MySQL 8.0.19+ through mysql2, e.g. with a Hyperdrive binding's `connectionString`. Each connection runs
 * MYSQL_SESSION first; DECIMAL and BIGINT results are numbers like D1 returns them. Call `close()` when done.
 */
export function connectMysql(url: string, options: { max?: number } = {}): MysqlConnection {
  // Loaded on first use so Workers on D1 or Postgres never evaluate the Node-only mysql2 module.
  const pool: Promise<Pool> = import('mysql2/promise').then(({ createPool }) => {
    const p = createPool({
      uri: url,
      connectionLimit: options.max ?? 5,
      decimalNumbers: true,
      supportBigNumbers: false,
      dateStrings: true,
      disableEval: true,
    });
    p.pool.on('connection', (conn) => {
      conn.query(MYSQL_SESSION);
    });
    return p;
  });
  pool.catch(() => {});
  return {
    db: mysqlDatabase(client(async (t, p) => (await pool).query(t, p), async () => (await pool).getConnection())),
    close: async () => (await pool).end(),
  };
}
