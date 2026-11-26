// Static index check: applies every D1 migration to SQLite and asserts that the read paths of workers/api and the
// write/retention paths of workers/consumer never fall back to a full table or full index scan.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_SPECS } from '../workers/api/src/events';
import { RETAINED_TABLES } from '../workers/consumer/src/events';
import { retentionPlanSql } from '../workers/consumer/src/process';

const dir = join(import.meta.dir, '../workers/migrations');
const db = new Database(':memory:');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'));

const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
const scans = (sql: string) => plan(sql).filter((step) => /^SCAN \w+/.test(step));

// Both shapes of the project predicate the API emits (see `pf` in workers/api/src/index.ts).
const PROJECT = { scoped: (col = 'project_id') => `${col} = ?`, all: () => '? IS NULL' };

const queries: [string, string][] = [];
for (const [scope, pf] of Object.entries(PROJECT)) {
  queries.push(
    [`${scope} traces list`, `SELECT * FROM traces WHERE ${pf()} AND timestamp >= ? ORDER BY timestamp DESC, trace_id DESC LIMIT 51`],
    [`${scope} traces by source`, `SELECT * FROM traces WHERE ${pf()} AND execution_source = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 51`],
    [`${scope} trace detail`, `SELECT * FROM traces WHERE ${pf()} AND trace_id = ? LIMIT 1`],
    [`${scope} overview requests`, `SELECT name FROM traces WHERE ${pf()} AND timestamp >= ? AND execution_source = 'request'`],
    [`${scope} exception groups`, `SELECT group_hash, count(*) AS count, (SELECT trace_id FROM exceptions e2 WHERE e2.project_id = e.project_id AND e2.group_hash = e.group_hash ORDER BY timestamp DESC LIMIT 1) FROM exceptions e WHERE ${pf()} AND timestamp >= ? GROUP BY +group_hash`],
    [`${scope} exception stack`, `SELECT stack FROM exceptions WHERE ${pf()} AND group_hash = ? ORDER BY timestamp DESC LIMIT 1`],
    [`${scope} exception occurrences`, `SELECT e.trace_id, t.name FROM exceptions e LEFT JOIN traces t ON t.project_id = e.project_id AND t.trace_id = e.trace_id WHERE ${pf('e.project_id')} AND e.group_hash = ? ORDER BY e.timestamp DESC LIMIT 25`],
    [`${scope} query groups`, `SELECT sql_hash, sum(duration_ms) FROM queries WHERE ${pf()} AND timestamp >= ? GROUP BY +sql_hash`],
    [`${scope} query samples`, `SELECT q.trace_id, t.name FROM queries q LEFT JOIN traces t ON t.project_id = q.project_id AND t.trace_id = q.trace_id WHERE ${pf('q.project_id')} AND q.sql_hash = ? ORDER BY q.duration_ms DESC LIMIT 20`],
    [`${scope} slow queries`, `SELECT count(*) FROM queries WHERE ${pf()} AND timestamp >= ? AND duration_ms > 100`],
    [`${scope} usage`, `SELECT project_id, day, records FROM usage_daily WHERE ${pf()} AND day >= ? ORDER BY day DESC, project_id`],
  );
  // dead_letters only holds messages that failed every retry, so the all-projects form may walk its (small) index.
  if (scope === 'scoped') {
    queries.push(
      ['scoped dead letters list', `SELECT * FROM dead_letters WHERE ${pf()} ORDER BY failed_at DESC LIMIT 200`],
      ['scoped dead letters summary', `SELECT count(*), min(failed_at) FROM dead_letters WHERE ${pf()}`],
      ['scoped dead letters replay request', `UPDATE dead_letters SET replay_requested_at = ? WHERE ${pf()} AND replay_requested_at IS NULL`],
    );
  }
  for (const spec of EVENT_SPECS) {
    const where = `${pf()} AND timestamp >= ?${spec.where ? ` AND ${spec.where}` : ''}`;
    queries.push([
      `${scope} ${spec.path} list`,
      spec.group
        ? `SELECT ${spec.group} AS key, count(*) FROM ${spec.table} WHERE ${where} GROUP BY +${spec.group}`
        : `SELECT * FROM ${spec.table} WHERE ${where} ORDER BY timestamp DESC, id DESC LIMIT 200`,
    ]);
    if (spec.group) {
      queries.push([
        `${scope} ${spec.path} detail`,
        `SELECT e.*, t.name FROM ${spec.table} e LEFT JOIN traces t ON t.project_id = e.project_id AND t.trace_id = e.trace_id WHERE ${pf('e.project_id')} AND e.${spec.group} = ?${spec.where ? ` AND e.${spec.where}` : ''} ORDER BY e.timestamp DESC LIMIT 50`,
      ]);
    }
  }
}
queries.push(
  ['related traces', `SELECT trace_id FROM traces WHERE project_id = ? AND trace_id != ? AND (origin_trace_id = ? OR trace_id = ? OR (origin_trace_id IS NOT NULL AND origin_trace_id = ?)) ORDER BY timestamp LIMIT 50`],
  ['usage upsert quota lookup', 'SELECT daily_record_quota FROM projects WHERE id = ?'],
  ['usage today', 'SELECT records FROM usage_daily WHERE project_id = ? AND day = ?'],
  ['usage block', 'UPDATE usage_daily SET blocked_at = ? WHERE project_id = ? AND day = ?'],
  ['usage prune', 'DELETE FROM usage_daily WHERE day < ?'],
  ['pipeline minutes', 'SELECT * FROM pipeline_minutes WHERE minute >= ? ORDER BY minute'],
  ['pipeline minutes prune', 'DELETE FROM pipeline_minutes WHERE minute < ?'],
  ['dead letters to replay', 'SELECT id, r2_key FROM dead_letters WHERE replay_requested_at IS NOT NULL ORDER BY replay_requested_at LIMIT ?'],
  ['retention traces select', 'SELECT r2_key FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?'],
  ['retention traces', 'DELETE FROM traces WHERE rowid IN (SELECT rowid FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?)'],
  ...RETAINED_TABLES.flatMap((table): [string, string][] => [
    [`retention ${table}`, `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id = ? AND timestamp < ? LIMIT ?)`],
    [`rebuild ${table}`, `DELETE FROM ${table} WHERE project_id = ? AND trace_id = ?`],
  ]),
);

describe('D1 indexes', () => {
  test.each(queries)('%s uses an index', (_name, sql) => {
    expect(scans(sql)).toEqual([]);
  });

  test('the check catches a missing index', () => {
    expect(scans('SELECT * FROM traces WHERE name = ?')).toEqual(['SCAN traces']);
  });
});

describe('retention plan', () => {
  test('walks the (small) projects table once and probes every retained table by index', () => {
    expect(scans(retentionPlanSql())).toEqual([expect.stringMatching(/^SCAN p\b/)]);
  });
});
