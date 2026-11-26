#!/usr/bin/env bun
/**
 * Applies workers/migrations to MySQL 8.0.19+ (translated from D1's SQLite dialect), tracking applied files in
 * `_edgewatch_migrations`. Usage: bun scripts/mysql-migrate.ts [--fresh] <mysql-url>   (or EDGEWATCH_MYSQL_URL)
 * --fresh drops every table in the database first (tests only: it deletes all data).
 * MySQL commits each DDL statement on its own, so a file that fails halfway stays half-applied; fix and rerun by hand.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MYSQL_SESSION, mysqlKeyColumns, toMysqlSchema } from '../packages/shared/src/sql-dialect';
import { createConnection } from '../packages/shared/node_modules/mysql2/promise';

export const MIGRATIONS_DIR = join(import.meta.dir, '../workers/migrations');

export async function migrate(url: string, { dir = MIGRATIONS_DIR, fresh = false, log = console.log as (line: string) => void } = {}): Promise<string[]> {
  const conn = await createConnection({ uri: url });
  try {
    await conn.query(MYSQL_SESSION);
    if (fresh) {
      const [tables] = await conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const { t } of tables as { t: string }[]) await conn.query(`DROP TABLE "${t.replaceAll('"', '""')}"`);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    await conn.query('CREATE TABLE IF NOT EXISTS _edgewatch_migrations (name VARCHAR(255) PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const [rows] = await conn.query('SELECT name FROM _edgewatch_migrations');
    const done = new Set((rows as { name: string }[]).map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const sources = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
    const keyed = mysqlKeyColumns([...sources.values()]);
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      for (const statement of toMysqlSchema(sources.get(file) ?? '', keyed)) await conn.query(statement);
      await conn.query('INSERT INTO _edgewatch_migrations (name, applied_at) VALUES (?, ?)', [file, Date.now()]);
      applied.push(file);
      log(`applied ${file}`);
    }
    if (!applied.length) log('no pending migrations');
    return applied;
  } finally {
    await conn.end();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const url = args.find((a) => !a.startsWith('--')) ?? process.env.EDGEWATCH_MYSQL_URL;
  if (!url) {
    console.error('usage: bun scripts/mysql-migrate.ts [--fresh] <mysql-url>  (or set EDGEWATCH_MYSQL_URL)');
    process.exit(2);
  }
  await migrate(url, { fresh }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
