import { describe, expect, it } from 'vitest';
import { describeBackends, openBackends } from './backends';
import { type LibsqlClient, type LibsqlValue, libsqlDatabase, toLibsqlValue } from './libsql';

function fake(rows: unknown[][] = [], columns: string[] = []) {
  const calls: { sql: string; args: LibsqlValue[]; mode?: string }[] = [];
  const rs = { columns, rows, rowsAffected: rows.length };
  const client: LibsqlClient = {
    execute: async (stmt) => {
      calls.push(stmt);
      return rs;
    },
    batch: async (stmts, mode) => {
      for (const s of stmts) calls.push({ ...s, mode });
      return stmts.map(() => rs);
    },
  };
  return { db: libsqlDatabase(client), calls };
}

describe('libSQL adapter', () => {
  it('passes SQLite SQL through and binds like D1', async () => {
    const { db, calls } = fake([[1, 2n]], ['a', 'b']);
    const sql = 'SELECT ?1 AS a, ?2 AS b WHERE x = ?1';
    expect(await db.prepare(sql).bind(true, null).first()).toEqual({ a: 1, b: 2 });
    expect(calls).toEqual([{ sql, args: [1, null] }]);
    expect(await db.prepare(sql).first<number>('b')).toBe(2);
    expect(await db.prepare(sql).first<number>('missing')).toBeNull();
  });

  it('returns null for no row and rowsAffected as meta.changes', async () => {
    const { db } = fake();
    expect(await db.prepare('SELECT 1').first()).toBeNull();
    expect((await db.prepare('DELETE FROM t').run()).meta.changes).toBe(0);
  });

  it('runs batch as one write transaction and rejects foreign statements', async () => {
    const { db, calls } = fake([[5]], ['n']);
    const out = await db.batch([db.prepare('INSERT INTO t VALUES (?)').bind('a'), db.prepare('SELECT n FROM t')]);
    expect(out.map((r) => r.results)).toEqual([[{ n: 5 }], [{ n: 5 }]]);
    expect(calls.map((c) => c.mode)).toEqual(['write', 'write']);
    const other = fake().db;
    await expect(db.batch([other.prepare('SELECT 1'), { bind: () => other.prepare('x') } as never])).rejects.toThrow(TypeError);
  });

  it('rejects values D1 would not bind', () => {
    expect(() => toLibsqlValue(undefined)).toThrow(TypeError);
    expect(() => toLibsqlValue({})).toThrow(TypeError);
    expect(toLibsqlValue(false)).toBe(0);
    const bytes = new Uint8Array([1]);
    expect(toLibsqlValue(bytes)).toBe(bytes);
  });

  it('is selected by LIBSQL_URL, and not together with HYPERDRIVE', async () => {
    expect(describeBackends({ LIBSQL_URL: 'libsql://db.turso.io' }).events).toBe('libsql');
    expect(describeBackends({}).events).toBe('d1');
    const opened = openBackends({ LIBSQL_URL: 'http://127.0.0.1:1', KEY_STORE: 'sql' });
    expect(opened.connected).toBe(true);
    expect(() => openBackends({ LIBSQL_URL: 'libsql://x', HYPERDRIVE: { connectionString: 'postgres://u:p@h/d' } })).toThrow(/not both/);
  });
});
