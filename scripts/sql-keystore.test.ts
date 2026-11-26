import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqlKeyStore } from '../packages/shared/src/sql-keystore';
import { BunSqliteDatabase } from '../apps/server/src/sqlite';

function migrated(): BunSqliteDatabase {
  const db = new BunSqliteDatabase();
  const dir = join(import.meta.dir, '../workers/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.raw.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}

describe('SqlKeyStore on the D1 schema (migration 0016)', () => {
  test('put/get/delete round-trips JSON like KV', async () => {
    let now = 1_000_000;
    const store = new SqlKeyStore(migrated(), () => now);
    expect(await store.get('apikey:x', { type: 'json' })).toBeNull();
    await store.put('apikey:x', JSON.stringify({ project_id: 'p', scopes: ['ingest'] }));
    expect(await store.get<{ project_id: string }>('apikey:x', { type: 'json' })).toEqual({ project_id: 'p', scopes: ['ingest'] });
    await store.put('apikey:x', JSON.stringify({ project_id: 'q' }));
    expect(await store.get('apikey:x', { type: 'json' })).toEqual({ project_id: 'q' });
    await store.delete('apikey:x');
    expect(await store.get('apikey:x', { type: 'json' })).toBeNull();
    now += 1;
  });

  test('expirationTtl hides and purges expired values', async () => {
    let now = 1_000_000;
    const store = new SqlKeyStore(migrated(), () => now);
    await store.put('project:p', '{"over_quota_until":1}', { expirationTtl: 60 });
    await store.put('apikey:keep', '{}');
    expect(await store.get('project:p', { type: 'json' })).toEqual({ over_quota_until: 1 });
    now += 60_000;
    expect(await store.get('project:p', { type: 'json' })).toBeNull();
    expect(await store.list('project:')).toEqual([]);
    expect(await store.purgeExpired()).toBe(1);
    expect(await store.list('')).toEqual(['apikey:keep']);
  });

  test('cacheTtl serves a cached value until it lapses; writes through the same store invalidate it', async () => {
    let now = 1_000_000;
    const db = migrated();
    const store = new SqlKeyStore(db, () => now);
    const other = new SqlKeyStore(db, () => now);
    await store.put('apikey:c', '{"v":1}');
    expect(await store.get('apikey:c', { type: 'json', cacheTtl: 60 })).toEqual({ v: 1 });
    await other.put('apikey:c', '{"v":2}');
    expect(await store.get('apikey:c', { type: 'json', cacheTtl: 60 })).toEqual({ v: 1 });
    now += 60_001;
    expect(await store.get('apikey:c', { type: 'json', cacheTtl: 60 })).toEqual({ v: 2 });
    await store.delete('apikey:c');
    expect(await store.get('apikey:c', { type: 'json', cacheTtl: 60 })).toBeNull();
  });

  test('list matches the prefix literally (no LIKE wildcards)', async () => {
    const store = new SqlKeyStore(migrated());
    for (const k of ['audit:1', 'audit:2', 'audit_x', 'apikey:a', 'a%dit:3']) await store.put(k, '{}');
    expect(await store.list('audit:')).toEqual(['audit:1', 'audit:2']);
    expect(await store.list('a%')).toEqual(['a%dit:3']);
  });
});

describe('keys CLI on the SQL key store (--postgres / KEY_STORE=sql)', () => {
  test('create, list, rotate, revoke and audit work against kv_store', async () => {
    const { main, sqlStore } = await import('./keys');
    const kv = new SqlKeyStore(migrated());
    const store = sqlStore(kv);
    const lines: string[] = [];
    expect(await main(['create', 'shop', 'ingest', 'ci'], store, (l) => lines.push(l))).toBe(0);
    const id = lines[0].slice(4, 16);
    expect(await main(['rotate', id, '--grace', '0'], store, (l) => lines.push(l))).toBe(0);
    expect(await main(['list'], store, (l) => lines.push(l))).toBe(0);
    expect(lines.filter((l) => l.includes('  revoked') || l.includes('  active'))).toHaveLength(2);
    expect(await main(['audit'], store, (l) => lines.push(l))).toBe(0);
    expect(lines.slice(-2).map((l) => l.split(/\s+/)[1])).toEqual(['rotate', 'create']);
    expect((await kv.list('apikey:')).length).toBe(2);
  });
});
