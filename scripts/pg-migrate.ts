#!/usr/bin/env bun
/**
 * Applies workers/migrations to Postgres (translated from D1's SQLite dialect), tracking applied files in
 * `_edgewatch_migrations`. Usage: bun scripts/pg-migrate.ts [--fresh] <postgres-url>   (or EDGEWATCH_POSTGRES_URL)
 * --fresh drops and recreates the `public` schema first (tests only: it deletes all data).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSTGRES_COMPAT, toPostgresSchema } from '../packages/shared/src/sql-dialect';
import postgres from '../packages/shared/node_modules/postgres';

export const MIGRATIONS_DIR = join(import.meta.dir, '../workers/migrations');

export async function migrate(url: string, { dir = MIGRATIONS_DIR, fresh = false, log = console.log as (line: string) => void } = {}): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (fresh) await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public').simple();
    await sql.unsafe('CREATE TABLE IF NOT EXISTS _edgewatch_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    await sql.unsafe(POSTGRES_COMPAT).simple();
    const done = new Set((await sql.unsafe<{ name: string }[]>('SELECT name FROM _edgewatch_migrations')).map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const ddl = toPostgresSchema(readFileSync(join(dir, file), 'utf8'));
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl).simple();
        await tx.unsafe('INSERT INTO _edgewatch_migrations (name, applied_at) VALUES ($1, $2)', [file, Date.now()]);
      });
      applied.push(file);
      log(`applied ${file}`);
    }
    if (!applied.length) log('no pending migrations');
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const url = args.find((a) => !a.startsWith('--')) ?? process.env.EDGEWATCH_POSTGRES_URL;
  if (!url) {
    console.error('usage: bun scripts/pg-migrate.ts [--fresh] <postgres-url>  (or set EDGEWATCH_POSTGRES_URL)');
    process.exit(2);
  }
  await migrate(url, { fresh }).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
