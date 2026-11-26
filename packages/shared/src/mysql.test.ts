import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type MysqlClient, mysqlDatabase } from './mysql';
import { mysqlKeyColumns, toMysql, toMysqlSchema } from './sql-dialect';

describe('toMysql', () => {
  it('maps bare and indexed parameters to positional ones', () => {
    expect(toMysql('SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?')).toEqual({ text: 'SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?', order: [0, 1, 2] });
    expect(toMysql('VALUES (?1, ?2), (?2, ?), (?1)')).toEqual({ text: 'VALUES (?, ?), (?, ?), (?)', order: [0, 1, 1, 2, 0] });
  });

  it('leaves literals alone except doubling backslashes, and quotes reserved column names', () => {
    expect(toMysql(`SELECT 'a?\\b' AS "user", key, sql, sql_hash, k.key FROM t WHERE x LIKE '%\\%' ESCAPE '\\'`).text).toBe(
      `SELECT 'a?\\\\b' AS "user", "key", "sql", sql_hash, k."key" FROM t WHERE x COLLATE utf8mb4_0900_ai_ci LIKE '%\\\\%' ESCAPE '\\\\'`,
    );
  });

  it('turns SQLite conflict clauses into INSERT IGNORE and ON DUPLICATE KEY UPDATE', () => {
    expect(toMysql('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').text).toBe('INSERT IGNORE INTO projects (id, name) VALUES (?, ?)');
    expect(toMysql('INSERT INTO e (id) VALUES (?) ON CONFLICT DO NOTHING').text).toBe('INSERT IGNORE INTO e (id) VALUES (?)');
    expect(toMysql('INSERT INTO m (minute, n) VALUES (?, ?) ON CONFLICT (minute) DO UPDATE SET n = m.n + excluded.n, x = max(m.x, excluded.x)').text).toBe(
      'INSERT INTO m (minute, n) VALUES (?, ?) AS excluded ON DUPLICATE KEY UPDATE n = m.n + excluded.n, x = GREATEST(m.x, excluded.x)',
    );
  });

  it('rewrites chunked rowid deletes, group_concat, GROUP BY hints, CAST and NOT LIKE', () => {
    expect(toMysql('DELETE FROM traces WHERE rowid IN (SELECT rowid FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?)').text).toBe(
      'DELETE FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp LIMIT ?',
    );
    expect(toMysql('SELECT r2_key FROM traces ORDER BY timestamp, rowid LIMIT ?').text).toBe('SELECT r2_key FROM traces ORDER BY timestamp LIMIT ?');
    expect(toMysql('SELECT group_concat(DISTINCT method), group_concat(x, ?) FROM t GROUP BY +route').text).toBe(
      "SELECT GROUP_CONCAT(DISTINCT method SEPARATOR ','), GROUP_CONCAT(x SEPARATOR ?) FROM t GROUP BY route",
    );
    expect(toMysql('SELECT CAST((timestamp - ?) / ? AS INTEGER), CAST(x AS REAL), CAST(y AS TEXT), min(a, b) FROM t WHERE u NOT LIKE ?').text).toBe(
      'SELECT CAST(TRUNCATE((timestamp - ?) / ?, 0) AS SIGNED), CAST(x AS DOUBLE), CAST(y AS CHAR), LEAST(a, b) FROM t WHERE u COLLATE utf8mb4_0900_ai_ci NOT LIKE ?',
    );
  });
});

describe('toMysqlSchema', () => {
  const dir = join(__dirname, '../../../workers/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(dir, f), 'utf8'));
  const keyed = mysqlKeyColumns(files);

  it('bounds indexed TEXT columns and maps the other types', () => {
    const sql = `CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects (id), key TEXT, body TEXT DEFAULT 'x', d REAL, at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));`;
    const [stmt] = toMysqlSchema(sql, mysqlKeyColumns([sql, 'CREATE INDEX t_key ON t (key, d);']));
    expect(stmt).toContain('id BIGINT PRIMARY KEY AUTO_INCREMENT');
    expect(stmt).toContain('project_id VARCHAR(255) NOT NULL REFERENCES projects (id)');
    expect(stmt).toContain('"key" VARCHAR(255)');
    expect(stmt).toContain("body MEDIUMTEXT DEFAULT ('x')");
    expect(stmt).toContain('d DOUBLE');
    expect(stmt).toContain("at MEDIUMTEXT DEFAULT (CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z'))");
    expect(stmt).toMatch(/COLLATE=utf8mb4_bin$/);
  });

  it('drops IF NOT EXISTS and partial-index WHERE clauses from indexes', () => {
    expect(toMysqlSchema("CREATE INDEX IF NOT EXISTS u ON traces (user, timestamp DESC) WHERE user > '';", keyed)).toEqual(['CREATE INDEX u ON traces (user, timestamp DESC)']);
  });

  it('finds key columns across every migration, including ones indexed in later files', () => {
    for (const k of ['projects.id', 'traces.project_id', 'traces.trace_id', 'traces.user', 'traces.origin_trace_id', 'exceptions.group_hash', 'kv_store.name']) expect(keyed).toContain(k);
    expect(keyed).not.toContain('exceptions.message');
    for (const sql of files) for (const s of toMysqlSchema(sql, keyed)) expect(s).not.toMatch(/\bTEXT\b(?! *\()|\bstrftime\b|\bIF NOT EXISTS\b.*\bINDEX\b/i);
  });
});

describe('mysqlDatabase', () => {
  const calls: [string, unknown[]][] = [];
  const client: MysqlClient = {
    query: async (text, params) => {
      calls.push([text, params]);
      return { rows: [{ n: 1 }], affectedRows: 3 };
    },
    transaction: async (fn) => fn(client),
  };
  const db = mysqlDatabase(client);

  it('reorders bound values for repeated ?N and converts booleans like D1', async () => {
    await db.prepare('SELECT ?2 AS a, ?1 AS b, ?2 AS c').bind(true, 'x').all();
    expect(calls.at(-1)).toEqual(['SELECT ? AS a, ? AS b, ? AS c', ['x', 1, 'x']]);
    expect(() => db.prepare('SELECT ?, ?').bind(1)).toThrow(RangeError);
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow(TypeError);
  });

  it('returns rows, first() columns and affected rows as changes', async () => {
    expect(await db.prepare('SELECT 1 AS n').first<number>('n')).toBe(1);
    expect((await db.prepare('DELETE FROM t').run()).meta.changes).toBe(3);
    const [r] = await db.batch([db.prepare('SELECT ?').bind(5)]);
    expect(r?.results).toEqual([{ n: 1 }]);
  });
});
