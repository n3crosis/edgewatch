import { checkInvestigations } from './investigation-check';
/**
 * libSQL integration checks for the event-store adapter and migrations. They need a real libSQL server (sqld or Turso):
 *   EDGEWATCH_TEST_LIBSQL_URL=http://... bun test scripts/libsql.test.ts   (bun run test:libsql starts one)
 * Without the variable they are skipped; `bun run e2e:libsql` covers the full pipeline.
 */
import { describe, expect, it } from 'bun:test';
import { recordUsage } from '../workers/consumer/src/usage';
import type { Env } from '../workers/consumer/src/process';
import { connectLibsql } from '../packages/shared/src/libsql-client';
import { migrate } from './libsql-migrate';

const url = process.env.EDGEWATCH_TEST_LIBSQL_URL;
const token = process.env.LIBSQL_AUTH_TOKEN;

describe.skipIf(!url)('libSQL event store', () => {
  const libUrl = url ?? '';

  it('applies every migration once', async () => {
    const lines: string[] = [];
    const first = await migrate(libUrl, { fresh: true, authToken: token, log: (l) => lines.push(l) });
    expect(first.length).toBeGreaterThanOrEqual(15);
    expect(await migrate(libUrl, { authToken: token, log: (l) => lines.push(l) })).toEqual([]);
    expect(lines.at(-1)).toBe('no pending migrations');
  });

  it('runs the queries the Workers use, unchanged', async () => {
    const lib = connectLibsql(libUrl, token);
    try {
      const { db } = lib;
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').bind('p1', 'p1'),
        db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').bind('p1', 'again'),
      ]);
      expect(await db.prepare('SELECT name FROM projects WHERE id = ?').bind('p1').first<string>('name')).toBe('p1');
      const insert = db.prepare(
        `INSERT INTO pipeline_minutes (minute, batches, messages, retried, max_lag_ms) VALUES (?, 1, ?, ?, ?)
         ON CONFLICT (minute) DO UPDATE SET batches = pipeline_minutes.batches + 1, messages = pipeline_minutes.messages + excluded.messages,
           retried = pipeline_minutes.retried + excluded.retried, max_lag_ms = max(pipeline_minutes.max_lag_ms, excluded.max_lag_ms)`,
      );
      await insert.bind(60_000, 2, 0, 50).run();
      await insert.bind(60_000, 3, 1, 20).run();
      expect(await db.prepare('SELECT batches, messages, retried, max_lag_ms FROM pipeline_minutes WHERE minute = ?').bind(60_000).first()).toEqual({
        batches: 2,
        messages: 5,
        retried: 1,
        max_lag_ms: 50,
      });
      expect(await db.prepare('SELECT count(*) AS n FROM projects WHERE ? IS NULL').bind(null).first<number>('n')).toBe(1);
      for (const n of [1, 2, 3]) {
        await db.prepare('INSERT INTO usage_daily (project_id, day, records) VALUES (?, ?, ?)').bind('p1', `2026-01-0${n}`, n).run();
      }
      const del = await db.prepare('DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE project_id = ? LIMIT ?)').bind('p1', 2).run();
      expect(del.meta.changes).toBe(2);
      expect(await db.prepare('SELECT ?1 AS x, ?1 AS y, ?2 AS z').bind('v', true).first()).toEqual({ x: 'v', y: 'v', z: 1 });
      expect(await db.prepare('SELECT 9007199254740993 AS big').first<number>('big')).toBe(9007199254740992);
    } finally {
      await lib.close();
    }
  });

  it('counts usage receipts atomically and only once', async () => {
    const store = connectLibsql(libUrl, token);
    try {
      const env = { DB: store.db } as Env;
      await recordUsage(env, new Map([['receipt-project', 3]]), Date.now(), 'receipt-one');
      await recordUsage(env, new Map([['receipt-project', 3]]), Date.now(), 'receipt-one');
      expect(await store.db.prepare('SELECT records FROM usage_daily WHERE project_id = ?').bind('receipt-project').first('records')).toBe(3);
    } finally {
      await store.close();
    }
  });

  it('rolls back a failed batch', async () => {
    const lib = connectLibsql(libUrl, token);
    try {
      const { db } = lib;
      const before = await db.prepare('SELECT count(*) AS n FROM projects').first<number>('n');
      await expect(
        db.batch([db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind('p2', 'p2'), db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind('p1', 'dup')]),
      ).rejects.toThrow();
      expect(await db.prepare('SELECT count(*) AS n FROM projects').first<number>('n')).toBe(before);
    } finally {
      await lib.close();
    }
  });
  it('runs Requests, Logs and issue regression across consumer and API', async () => {
    const store = connectLibsql(libUrl, token);
    try { await checkInvestigations(store.db); } finally { await store.close(); }
  });

});
