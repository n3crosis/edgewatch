import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlKeyStore } from '@edgewatch/shared';
import { createEdgeWatch, memoryRateLimiter, type EdgeWatch } from '../src/app';
import { FsBlobStore } from '../src/fs-blob';
import { SqliteQueueStore } from '../src/queue-store';
import { LocalQueue, QueueFullError } from '../src/queue';
import { BunSqliteDatabase, migrateSqlite } from '../src/sqlite';

const MIGRATIONS = join(import.meta.dir, '../../../workers/migrations');
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ew-server-'));
  dirs.push(d);
  return d;
};
let open: EdgeWatch | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('FsBlobStore', () => {
  it('round-trips, overwrites atomically, deletes, and returns null for a missing key', async () => {
    const s = new FsBlobStore(tmp());
    await s.put('traces/p/2026-01-01/t.json', '{"a":1}');
    await s.put('traces/p/2026-01-01/t.json', '{"a":2}');
    const o = await s.get('traces/p/2026-01-01/t.json');
    expect(o?.size).toBe(7);
    expect(await o?.json<{ a: number }>()).toEqual({ a: 2 });
    expect(await new Response(o?.body).text()).toBe('{"a":2}');
    await s.delete(['traces/p/2026-01-01/t.json', 'missing']);
    expect(await s.get('traces/p/2026-01-01/t.json')).toBeNull();
  });

  it('rejects keys that could escape the directory', async () => {
    const s = new FsBlobStore(tmp());
    for (const key of ['../x', 'a/../../x', '/abs', 'a//b', 'a\\b', '', 'a/./b']) await expect(s.put(key, 'x')).rejects.toThrow('Invalid blob key');
  });
});

describe('LocalQueue', () => {
  it('retains exhausted terminal-queue messages until storage recovers', async () => {
    let now = 0;
    let failing = true;
    const q = new LocalQueue<number>('dlq', async (b) => { if (failing) b.retryAll(); }, { maxRetries: 0, now: () => now });
    await q.sendBatch([{ body: 1 }]);
    await q.drain();
    expect(q.size).toBe(1);
    failing = false;
    now = 60_000;
    await q.drain();
    expect(q.size).toBe(0);
    await q.close();
  });

  it('keeps in-flight messages durable until the handler finishes', async () => {
    const store = new SqliteQueueStore<number>(join(tmp(), 'queue.sqlite'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const q = new LocalQueue<number>('q', async () => gate, { store });
    await q.sendBatch([{ body: 7 }]);
    const delivery = q.drain();
    expect(store.load('q').map((m) => m.body)).toEqual([7]);
    await q.sendBatch([{ body: 8 }]);
    expect(store.load('q').map((m) => m.body)).toEqual([7, 8]);
    release();
    await delivery;
    expect(store.load('q')).toEqual([]);
    await q.close();
    store.close();
  });

  it('recovers delayed retries after closing and reopening the durable journal', async () => {
    const path = join(tmp(), 'queue.sqlite');
    let now = 0;
    const store = new SqliteQueueStore<number>(path);
    const q = new LocalQueue<number>('q', async (b) => b.retryAll({ delaySeconds: 10 }), { store, now: () => now });
    await q.sendBatch([{ body: 42 }]);
    await q.drain();
    await q.close();
    store.close();
    const reopened = new SqliteQueueStore<number>(path);
    const got: number[] = [];
    const recovered = new LocalQueue<number>('q', async (b) => {
      got.push(...b.messages.map((m) => m.body));
      expect(b.messages[0].attempts).toBe(2);
      expect(b.messages[0].timestamp).toBeInstanceOf(Date);
    }, { store: reopened, now: () => now });
    await recovered.drain();
    expect(got).toEqual([]);
    now = 10000;
    await recovered.drain();
    expect(got).toEqual([42]);
    expect(reopened.load('q')).toEqual([]);
    await recovered.close();
    reopened.close();
  });

  it('retains exhausted messages when the dead-letter queue is full', async () => {
    let now = 0;
    const got: number[] = [];
    const dlq = new LocalQueue<number>('dlq', async (b) => { got.push(...b.messages.map((m) => m.body)); }, { maxPending: 1 });
    const q = new LocalQueue<number>('q', async (b) => b.retryAll(), { maxRetries: 0, deadLetter: dlq, now: () => now });
    await dlq.sendBatch([{ body: 1 }]);
    await q.sendBatch([{ body: 2 }]);
    await expect(q.drain()).rejects.toBeInstanceOf(QueueFullError);
    expect(q.size).toBe(1);
    await dlq.drain();
    now = 1000;
    await q.drain();
    await dlq.drain();
    expect(got).toEqual([1, 2]);
    await q.close();
    await dlq.close();
  });

  it('delivers in batches, retries with attempts, then dead-letters after maxRetries', async () => {
    const seen: string[] = [];
    const dead: number[] = [];
    let now = 0;
    const dlq = new LocalQueue<number>('dlq', async (b) => void dead.push(...b.messages.map((m) => m.body)), { now: () => now });
    const q = new LocalQueue<number>('q', async (b) => {
      seen.push(b.messages.map((m) => `${m.body}@${m.attempts}`).join(','));
      for (const m of b.messages) (m.body % 2 ? m.retry({ delaySeconds: 10 }) : m.ack());
    }, { maxBatchSize: 2, maxRetries: 2, deadLetter: dlq, now: () => now });
    await q.sendBatch([1, 2, 3].map((body) => ({ body })));
    await q.drain();
    expect(seen).toEqual(['1@1,2@1', '3@1']);
    await q.drain();
    expect(seen).toHaveLength(2); // retry delay not elapsed
    now += 10_000;
    await q.drain();
    now += 10_000;
    await q.drain();
    expect(seen.slice(2)).toEqual(['1@2,3@2', '1@3,3@3']);
    await dlq.drain();
    expect(dead).toEqual([1, 3]);
    expect(q.size).toBe(0);
  });

  it('retries the whole batch when the handler throws, and refuses messages when full or closed', async () => {
    let calls = 0;
    const q = new LocalQueue<number>('q', async () => {
      if (++calls === 1) throw new Error('down');
    }, { maxPending: 2 });
    await q.sendBatch([{ body: 1 }]);
    await q.drain();
    expect(calls).toBe(2); // redelivered at once (no delay given), then acked
    expect(q.size).toBe(0);
    await expect(q.sendBatch([{ body: 2 }, { body: 3 }, { body: 4 }])).rejects.toBeInstanceOf(QueueFullError);
    await q.close();
    expect(q.size).toBe(0);
    await expect(q.sendBatch([{ body: 4 }])).rejects.toBeInstanceOf(QueueFullError);
  });

  it('delivers on its own after the batch timeout', async () => {
    const got: number[] = [];
    const q = new LocalQueue<number>('q', async (b) => void got.push(...b.messages.map((m) => m.body)), { batchTimeoutMs: 5 });
    await q.sendBatch([{ body: 7 }]);
    await Bun.sleep(50);
    expect(got).toEqual([7]);
  });
});

describe('memoryRateLimiter', () => {
  it('allows `limit` calls per key per period', async () => {
    let now = 0;
    const rl = memoryRateLimiter(2, 60, () => now);
    const r = async (key: string) => (await rl.limit({ key })).success;
    expect([await r('a'), await r('a'), await r('a'), await r('b')]).toEqual([true, true, false, true]);
    now += 60_000;
    expect(await r('a')).toBe(true);
  });
});

describe('migrateSqlite', () => {
  it('applies every migration once', () => {
    const db = new BunSqliteDatabase();
    const first = migrateSqlite(db, MIGRATIONS);
    expect(first[0]).toBe('0001_init.sql');
    expect(first.at(-1)).toBe('0023_dashboard_auth_limits.sql');
    expect(db.raw.query('PRAGMA table_info(traces)').all().some((row: any) => row.name === 'environment')).toBe(true);
    expect(migrateSqlite(db, MIGRATIONS)).toEqual([]);
  });
});

describe('single-process server', () => {
  async function server(dashboardDir?: string, queue?: { maxPending: number }) {
    const db = new BunSqliteDatabase();
    migrateSqlite(db, MIGRATIONS);
    const keys = new SqlKeyStore(db);
    await keys.put(`apikey:${await sha256('ingest-key')}`, JSON.stringify({ project_id: 'shop', name: 't', scopes: ['ingest'] }));
    await keys.put(`apikey:${await sha256('read-key')}`, JSON.stringify({ project_id: 'shop', name: 'r', scopes: ['read'] }));
    open = createEdgeWatch({ db, blobs: new FsBlobStore(tmp()), keys, vars: { TOKEN_SIGNING_SECRET: 'test-secret' }, dashboardDir, rateLimit: 3, queue });
    return open;
  }
  const req = (path: string, init: RequestInit = {}) => new Request(`http://edgewatch.test${path}`, init);

  it('ingests, queues, consumes and serves a trace through the API on one fetch handler', async () => {
    const app = await server();
    const trace = crypto.randomUUID();
    const ts = Date.now() / 1000;
    const records = [
      { v: 1, t: 'request', timestamp: ts, deploy: 'v1', server: 'web-1', _group: 'g', trace_id: trace, execution_source: 'request', execution_id: trace, user: '42', method: 'GET', url: 'https://shop.test/a', route_path: '/a', status_code: 200, duration: 1500, queries: 1 },
      { v: 1, t: 'query', timestamp: ts, deploy: 'v1', server: 'web-1', _group: 'q', trace_id: trace, execution_source: 'request', execution_id: trace, user: '42', sql: 'select * from users where id = 1', duration: 300, connection: 'mysql', connection_type: 'read' },
    ];
    const res = await app.fetch(req('/api/ingest', { method: 'POST', headers: { authorization: 'Bearer ingest-key', 'content-type': 'application/json' }, body: JSON.stringify({ records }) }));
    expect(res.status).toBe(200);
    expect(app.queue.size).toBe(1);
    await app.settle();
    const read = { headers: { authorization: 'Bearer read-key' } };
    const list = (await (await app.fetch(req('/v1/projects/shop/traces?range=1h', read))).json()) as { data: { trace_id: string }[] };
    expect(list.data.map((t) => t.trace_id)).toContain(trace);
    expect((await app.fetch(req('/v1/projects/shop/settings', { method: 'PUT', headers: { authorization: 'Bearer read-key', 'content-type': 'application/json' }, body: '{"retention_days":0}' }))).status).toBe(403);
    const detail = await app.fetch(req(`/v1/projects/shop/traces/${trace}`, read));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(await detail.json())).toContain('select * from users where id = ?');
    expect((await app.fetch(req('/v1/projects', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
  });

  it('applies the per-project rate limit and runs the scheduled jobs', async () => {
    const app = await server();
    const send = () => app.fetch(req('/api/ingest', { method: 'POST', headers: { authorization: 'Bearer ingest-key' }, body: '{"records":[]}' }));
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await send()).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    await app.scheduled('17 * * * *');
    await app.scheduled('*/5 * * * *');
  });

  it('answers 503 with Retry-After when the in-memory queue is full', async () => {
    const app = await server(undefined, { maxPending: 0 });
    const t = crypto.randomUUID();
    const rec = { v: 1, t: 'request', timestamp: Date.now() / 1000, deploy: 'v1', server: 'w', _group: 'g', trace_id: t, execution_source: 'request', execution_id: t, user: '', method: 'GET', url: 'https://x.test/', route_path: '/', status_code: 200, duration: 1 };
    const res = await app.fetch(req('/api/ingest', { method: 'POST', headers: { authorization: 'Bearer ingest-key' }, body: JSON.stringify({ records: [rec] }) }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(JSON.stringify(await res.json())).not.toContain('full');
  });

  it('serves the dashboard with an SPA fallback, without shadowing the API or ingest routes', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(dir, 'assets/app.js'), 'console.log(1)');
    const app = await server(dir);
    const html = await app.fetch(req('/traces/abc'));
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('root');
    const js = await app.fetch(req('/assets/app.js'));
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect((await app.fetch(req('/assets/missing-page.js'))).status).toBe(404);
    expect((await app.fetch(req('/assets'))).status).toBe(404);
    expect((await app.fetch(req('/%'))).status).toBe(400);
    expect((await app.fetch(req('/assets/../../etc/passwd'))).status).not.toBe(500);
    expect((await app.fetch(req('/health'))).status).toBe(200);
    expect((await app.fetch(req('/v1/projects'))).status).toBe(401);
  });

  it('auto-bootstraps the default owner from OWNER_EMAIL and OWNER_PASSWORD', async () => {
    const db = new BunSqliteDatabase();
    migrateSqlite(db, MIGRATIONS);
    open = createEdgeWatch({
      db,
      blobs: new FsBlobStore(tmp()),
      vars: { TOKEN_SIGNING_SECRET: 'test-secret', OWNER_EMAIL: 'admin@example.com', OWNER_PASSWORD: 'changeme123' },
    });
    const session = await (await open.fetch(req('/auth/session'))).json() as { setup_required: boolean };
    expect(session.setup_required).toBe(false);
    const login = await open.fetch(req('/auth/login', {
      method: 'POST',
      headers: { origin: 'http://edgewatch.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'changeme123' }),
    }));
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ user: { email: 'admin@example.com', name: 'Admin', role: 'owner' } });
  });
});

describe('GET /healthz on the single-process server', () => {
  type Report = { status: string; service: string; checks: Record<string, { status: string; backend?: string; error?: string; detail?: Record<string, number> }> };
  async function start(o: { maxPending?: number; secret?: string; db?: BunSqliteDatabase } = {}) {
    const db = o.db ?? new BunSqliteDatabase();
    if (!o.db) migrateSqlite(db, MIGRATIONS);
    open = createEdgeWatch({ db, blobs: new FsBlobStore(tmp()), vars: { TOKEN_SIGNING_SECRET: o.secret ?? 'test-secret' }, queue: { maxPending: o.maxPending ?? 100 }, backends: { events: 'sqlite', blobs: 'fs' } });
    return open;
  }
  const healthz = async (app: EdgeWatch) => {
    const res = await app.fetch(new Request('http://edgewatch.test/healthz'));
    return { status: res.status, body: (await res.json()) as Report };
  };

  it('reports ok with the event store, schema, blobs, keys, signing secret and queue depth', async () => {
    const { status, body } = await healthz(await start());
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'server' });
    expect(Object.keys(body.checks).sort()).toEqual(['blobs', 'events', 'keys', 'queue', 'schema', 'signing_secret']);
    expect(body.checks.events?.backend).toBe('sqlite');
    expect(body.checks.queue?.detail).toEqual({ pending: 0, capacity: 100, dead_letters: 0 });
  });

  it('is degraded when the queue is 90% full, before ingest starts refusing', async () => {
    const app = await start({ maxPending: 10 });
    await app.queue.sendBatch(Array.from({ length: 9 }, () => ({ body: { project_id: 'p', server: 's', received_at: Date.now(), trace_id: null, records: [] } })));
    const { status, body } = await healthz(app);
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.queue).toMatchObject({ status: 'fail', error: 'over_capacity', detail: { pending: 9, capacity: 10 } });
  });

  it('is down (503) on an unmigrated database or without a signing secret', async () => {
    const unmigrated = await healthz(await start({ db: new BunSqliteDatabase() }));
    expect(unmigrated.status).toBe(503);
    expect(unmigrated.body.checks.schema?.error).toBe('schema_missing');
    await open?.close();
    const noSecret = await healthz(await start({ secret: '' }));
    expect(noSecret.status).toBe(503);
    expect(noSecret.body.checks.signing_secret?.error).toBe('not_configured');
  });

  it('keeps GET /health as a plain liveness check', async () => {
    const res = await (await start()).fetch(new Request('http://edgewatch.test/health'));
    expect(await res.json()).toEqual({ ok: true });
  });
});
