#!/usr/bin/env bun
/**
 * Applies workers/migrations to libSQL / Turso as written (it speaks SQLite), tracking applied files in
 * `_edgewatch_migrations`. Each file runs in one transaction with its tracking row.
 * Usage: bun scripts/libsql-migrate.ts [--fresh] <libsql-url>   (or EDGEWATCH_LIBSQL_URL; token in LIBSQL_AUTH_TOKEN)
 * --fresh drops every table first (tests only: it deletes all data).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLibsqlClient } from '../packages/shared/src/libsql-client';

export const MIGRATIONS_DIR = join(import.meta.dir, '../workers/migrations');

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function migrate(
  url: string,
  { dir = MIGRATIONS_DIR, fresh = false, authToken = undefined as string | undefined, log = console.log as (line: string) => void } = {},
): Promise<string[]> {
  const client = await openLibsqlClient(url, authToken);
  try {
    if (fresh) {
      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'");
      const drops = tables.rows.map((r) => `DROP TABLE IF EXISTS ${quote(String(r.name))};`).join('\n');
      if (drops) await client.executeMultiple(`PRAGMA foreign_keys = OFF;\n${drops}`);
    }
    await client.execute('CREATE TABLE IF NOT EXISTS _edgewatch_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set((await client.execute('SELECT name FROM _edgewatch_migrations')).rows.map((r) => String(r.name)));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const tx = await client.transaction('write');
      try {
        await tx.executeMultiple(readFileSync(join(dir, file), 'utf8'));
        await tx.execute({ sql: 'INSERT INTO _edgewatch_migrations (name, applied_at) VALUES (?, ?)', args: [file, Date.now()] });
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        tx.close();
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (!applied.length) log('no pending migrations');
    return applied;
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const url = args.find((a) => !a.startsWith('--')) ?? process.env.EDGEWATCH_LIBSQL_URL;
  if (!url) {
    console.error('usage: bun scripts/libsql-migrate.ts [--fresh] <libsql-url>  (or set EDGEWATCH_LIBSQL_URL; token in LIBSQL_AUTH_TOKEN)');
    process.exit(2);
  }
  await migrate(url, { fresh, authToken: process.env.LIBSQL_AUTH_TOKEN }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
