import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeEach, beforeAll as vitestBeforeAll } from 'vitest';

/**
 * Stack-style storage isolation for Workers tests. The Vitest plugin only isolates storage per test file, so each test
 * (and each suite's beforeAll) rolls back the D1, KV and R2 writes it made: a test sees only what its enclosing
 * beforeAll hooks seeded.
 */
type Row = Record<string, unknown>;
interface Snapshot {
  tables: { name: string; rows: Row[] }[];
  kv: { name: string; value: ArrayBuffer; metadata: unknown; expiration?: number }[];
  r2: { key: string; body: ArrayBuffer; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }[];
}

const bindings = env as unknown as { DB?: D1Database; API_KEYS?: KVNamespace; TRACES?: R2Bucket };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('d1_migrations', 'sqlite_stat1')")
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function kvEntries(kv: KVNamespace): Promise<KVNamespaceListKey<unknown>[]> {
  const keys: KVNamespaceListKey<unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function r2Objects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, include: ['httpMetadata', 'customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function snapshot(): Promise<Snapshot> {
  const { DB, API_KEYS, TRACES } = bindings;
  const tables = DB
    ? await Promise.all((await tableNames(DB)).map(async (name) => ({ name, rows: (await DB.prepare(`SELECT * FROM ${quote(name)}`).all<Row>()).results })))
    : [];
  const kv = API_KEYS
    ? await Promise.all((await kvEntries(API_KEYS)).map(async (k) => {
        const { value, metadata } = await API_KEYS.getWithMetadata(k.name, 'arrayBuffer');
        return { name: k.name, value: value ?? new ArrayBuffer(0), metadata, expiration: k.expiration };
      }))
    : [];
  const r2 = TRACES
    ? await Promise.all((await r2Objects(TRACES)).map(async (o) => ({
        key: o.key,
        body: (await (await TRACES.get(o.key))?.arrayBuffer()) ?? new ArrayBuffer(0),
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
      })))
    : [];
  return { tables, kv, r2 };
}

async function restore(snap: Snapshot): Promise<void> {
  const { DB, API_KEYS, TRACES } = bindings;
  if (DB) {
    const statements = [DB.prepare('PRAGMA defer_foreign_keys = on')];
    for (const name of await tableNames(DB)) statements.push(DB.prepare(`DELETE FROM ${quote(name)}`));
    for (const { name, rows } of snap.tables) {
      for (const row of rows) {
        const columns = Object.keys(row);
        statements.push(
          DB.prepare(`INSERT INTO ${quote(name)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(...columns.map((c) => row[c])),
        );
      }
    }
    await DB.batch(statements);
  }
  if (API_KEYS) {
    await Promise.all((await kvEntries(API_KEYS)).map((k) => API_KEYS.delete(k.name)));
    const now = Date.now() / 1000;
    await Promise.all(snap.kv.map((k) =>
      API_KEYS.put(k.name, k.value, { metadata: k.metadata, ...(k.expiration && k.expiration > now + 60 ? { expiration: k.expiration } : {}) }),
    ));
  }
  if (TRACES) {
    const current = await r2Objects(TRACES);
    if (current.length) await TRACES.delete(current.map((o) => o.key));
    await Promise.all(snap.r2.map((o) => TRACES.put(o.key, o.body, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata })));
  }
}

/** Rolls back every test's storage writes. Call once from a setup file. */
export function isolateEachTest(): void {
  let snap: Snapshot;
  beforeEach(async () => { snap = await snapshot(); });
  afterEach(async () => { await restore(snap); });
}

/** Vitest's beforeAll, plus a rollback of the hook's storage writes once the enclosing suite finishes. */
export function beforeAll(fn: () => unknown, timeout?: number): void {
  let snap: Snapshot;
  vitestBeforeAll(async () => {
    snap = await snapshot();
    await fn();
  }, timeout);
  afterAll(async () => { await restore(snap); });
}
