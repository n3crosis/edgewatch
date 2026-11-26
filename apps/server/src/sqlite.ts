import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { SqlDatabase, SqlResult, SqlStatement } from '@edgewatch/shared';

type Bind = SQLQueryBindings;
const toBind = (v: unknown): Bind => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as Bind));

class BunStatement implements SqlStatement {
  constructor(readonly db: BunSqliteDatabase, readonly sql: string, readonly params: Bind[] = []) {}
  bind(...values: unknown[]): SqlStatement {
    return new BunStatement(this.db, this.sql, values.map(toBind));
  }
  first<T>(column?: string): Promise<T | null> {
    const row = this.db.raw.query(this.sql).get(...this.params) as Record<string, unknown> | null;
    return Promise.resolve((row ? (column ? row[column] : row) : null) as T | null);
  }
  all<T>(): Promise<SqlResult<T>> {
    return Promise.resolve({ results: this.db.raw.query(this.sql).all(...this.params) as T[], meta: {} });
  }
  run<T>(): Promise<SqlResult<T>> {
    return Promise.resolve(this.exec<T>());
  }
  exec<T>(): SqlResult<T> {
    const q = this.db.raw.query(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) return { results: q.all(...this.params) as T[], meta: {} };
    const r = q.run(...this.params);
    return { results: [], meta: { changes: r.changes } };
  }
}

/** SqlDatabase on a bun:sqlite file (D1's dialect), with `batch` in one transaction like D1. */
export class BunSqliteDatabase implements SqlDatabase {
  readonly raw: Database;
  constructor(path = ':memory:') {
    this.raw = new Database(path, { create: true });
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  prepare(sql: string): SqlStatement {
    return new BunStatement(this, sql);
  }
  batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    const own = statements.map((s) => {
      if (!(s instanceof BunStatement) || s.db !== this) throw new TypeError('batch() statements must come from this database');
      return s;
    });
    return Promise.resolve(this.raw.transaction(() => own.map((s) => s.exec<T>()))());
  }
}

/** Applies workers/migrations (D1's dialect) in order, recording each file in `_edgewatch_migrations`. */
export function migrateSqlite(db: BunSqliteDatabase, dir: string, log: (line: string) => void = () => {}): string[] {
  db.raw.exec('CREATE TABLE IF NOT EXISTS _edgewatch_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.raw.query('SELECT name FROM _edgewatch_migrations').all().map((r) => (r as { name: string }).name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.raw.transaction(() => {
      db.raw.exec(sql);
      db.raw.query('INSERT INTO _edgewatch_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    })();
    applied.push(file);
    log(`applied ${file}`);
  }
  return applied;
}
