import { checkInvestigations } from './investigation-check';
/**
 * MySQL integration checks for the event-store adapter and migrations. They need a real MySQL 8.0.19+:
 *   EDGEWATCH_TEST_MYSQL_URL=mysql://... bun test scripts/mysql.test.ts   (bun run test:mysql starts one)
 * Without the variable they are skipped; `bun run e2e:mysql` covers the full pipeline.
 */
import { describe, expect, it } from 'bun:test';
import { connectMysql } from '../packages/shared/src/mysql2';
import { recordUsage } from '../workers/consumer/src/usage';
import type { Env } from '../workers/consumer/src/process';
import { migrate } from './mysql-migrate';

const url = process.env.EDGEWATCH_TEST_MYSQL_URL;

describe.skipIf(!url)('MySQL event store', () => {
  const myUrl = url ?? '';

  it('applies every migration once', async () => {
    const lines: string[] = [];
    const first = await migrate(myUrl, { fresh: true, log: (l) => lines.push(l) });
    expect(first.length).toBeGreaterThanOrEqual(15);
    expect(await migrate(myUrl, { log: (l) => lines.push(l) })).toEqual([]);
    expect(lines.at(-1)).toBe('no pending migrations');
  });

  it('runs the SQLite-dialect queries the Workers use', async () => {
    const my = connectMysql(myUrl);
    try {
      const { db } = my;
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
      // Counts come back as numbers, like D1; a null project filter keeps the bind list identical.
      expect(await db.prepare('SELECT count(*) AS n FROM projects WHERE ? IS NULL').bind(null).first<number>('n')).toBe(1);
      // Retention deletes by rowid (DELETE ... LIMIT in MySQL) in bounded chunks.
      for (const n of [1, 2, 3]) {
        await db.prepare('INSERT INTO usage_daily (project_id, day, records) VALUES (?, ?, ?)').bind('p1', `2026-01-0${n}`, n).run();
      }
      const del = await db.prepare('DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE project_id = ? LIMIT ?)').bind('p1', 2).run();
      expect(del.meta.changes).toBe(2);
      expect(await db.prepare('SELECT sum(records > 0) AS n, round(avg(records) * 1.0, 2) AS a FROM usage_daily').first()).toEqual({ n: 1, a: expect.any(Number) });
      // SQLite semantics MySQL differs on: truncating CAST, binary keys with case-insensitive LIKE, backslashes, ?N reuse.
      expect(await db.prepare('SELECT CAST((7 - ?) / ? AS INTEGER) AS b, CAST(-7 / 2 AS INTEGER) AS c').bind(0, 2).first()).toEqual({ b: 3, c: -3 });
      await db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind('P1', 'upper').run();
      expect(await db.prepare("SELECT count(*) AS n FROM projects WHERE name LIKE 'UPP%'").first<number>('n')).toBe(1);
      expect(await db.prepare('SELECT name FROM projects WHERE id = ?').bind('P1').first<string>('name')).toBe('upper');
      expect(await db.prepare("SELECT 'a\\b' AS s, ?1 AS x, ?1 AS y").bind('v').first()).toEqual({ s: 'a\\b', x: 'v', y: 'v' });
      await db.prepare('INSERT INTO kv_store (name, value, expires_at) VALUES (?, ?, NULL)').bind('k', 'v').run();
      expect(await db.prepare("SELECT group_concat(name, '|') AS g FROM kv_store").first<string>('g')).toBe('k');
    } finally {
      await my.close();
    }
  });

  it('counts usage receipts atomically and only once', async () => {
    const my = connectMysql(myUrl);
    try {
      const env = { DB: my.db } as Env;
      await recordUsage(env, new Map([['receipt-project', 3]]), Date.now(), 'receipt-one');
      await recordUsage(env, new Map([['receipt-project', 3]]), Date.now(), 'receipt-one');
      expect(await my.db.prepare('SELECT records FROM usage_daily WHERE project_id = ?').bind('receipt-project').first('records')).toBe(3);
    } finally {
      await my.close();
    }
  });

  it('rolls back a failed batch', async () => {
    const my = connectMysql(myUrl);
    try {
      const { db } = my;
      const before = await db.prepare('SELECT count(*) AS n FROM projects').first<number>('n');
      await expect(
        db.batch([db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind('p2', 'p2'), db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind('p1', 'dup')]),
      ).rejects.toThrow();
      expect(await db.prepare('SELECT count(*) AS n FROM projects').first<number>('n')).toBe(before);
    } finally {
      await my.close();
    }
  });
  it('runs Requests, Logs and issue regression across consumer and API', async () => {
    const store = connectMysql(myUrl);
    try { await checkInvestigations(store.db); } finally { await store.close(); }
  });

});
