#!/usr/bin/env bun
/**
 * Consumer memory/time benchmark without Workers: runs processBodies on generated traces against a local SQLite event
 * store (apps/server's adapter) and an in-memory blob store, then prints wall time, the process's peak RSS, how far RSS
 * grew past the level measured after setup (input generation is included in the growth, identically for every version).
 * Each run is its own process so peak RSS belongs to that scenario:
 *   bun scripts/consumer-bench.ts [scenario]   scenarios: batch (50 messages x 10 traces x 10 queries),
 *                                              merge (one 4,000-record trace, then 10 more batches into it),
 *                                              parked (one parked payload holding 400 traces),
 *                                              bigtrace (one request trace with 20,000 queries sent through ingest's enqueue)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobObject, BlobStore, IngestMessage, NightwatchRecord } from '../packages/shared/src';
import { BunSqliteDatabase, migrateSqlite } from '../apps/server/src/sqlite';
import { type Env, processBodies } from '../workers/consumer/src/process';
import { enqueue } from '../workers/ingest/src/enqueue';
import { batch } from './load-test';

class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<BlobObject | null> {
    const text = this.data.get(key);
    if (text === undefined) return null;
    return { size: text.length, body: new Response(text).body as ReadableStream, text: async () => text, json: async <T>() => JSON.parse(text) as T };
  }
  async put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown> {
    this.data.set(key, typeof value === 'string' ? value : await new Response(value).text());
    return {};
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}

const message = (records: NightwatchRecord[], extra: Partial<IngestMessage> = {}): IngestMessage =>
  ({ v: 1, project_id: 'bench', received_at: Date.now(), server: 'bench', records, ...extra }) as IngestMessage;

function bigTrace(traceId: string, queries: number): NightwatchRecord[] {
  const [root, q] = batch(0, 1, 1);
  const rows = [{ ...root, trace_id: traceId, execution_id: traceId }];
  for (let i = 0; i < queries; i++) rows.push({ ...q, trace_id: traceId, execution_id: traceId, line: i, sql: `select * from t${i % 40} where id = ?` });
  return rows as NightwatchRecord[];
}

export async function run(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ew-bench-'));
  const db = new BunSqliteDatabase(join(dir, 'bench.sqlite'));
  migrateSqlite(db, join(import.meta.dir, '../workers/migrations'));
  const blobs = new MemoryBlobs();
  const env = { DB: db, TRACES: blobs } as Env;
  Bun.gc(true);
  const startRss = process.memoryUsage().rss;
  const t0 = performance.now();
  let records = 0;
  if (scenario === 'batch') {
    for (let round = 0; round < 10; round++) {
      const bodies = Array.from({ length: 50 }, (_, i) => message(batch(round * 50 + i)));
      records += bodies.reduce((a, b) => a + (b.records?.length ?? 0), 0);
      await processBodies(bodies, env);
    }
  } else if (scenario === 'merge') {
    const id = crypto.randomUUID();
    const first = bigTrace(id, 4000);
    await processBodies([message(first)], env);
    records += first.length;
    for (let i = 0; i < 10; i++) {
      const more = bigTrace(id, 100).slice(1).map((r, j) => ({ ...r, line: 10_000 + i * 100 + j }));
      await processBodies([message(more)], env);
      records += more.length;
    }
  } else if (scenario === 'parked') {
    const rows: NightwatchRecord[] = [];
    while (rows.length < 40_000) rows.push(...bigTrace(crypto.randomUUID(), 99));
    await blobs.put('incoming/bench/1.json', JSON.stringify(rows));
    records = rows.length;
    const r = await processBodies([message([], { records: undefined, r2_key: 'incoming/bench/1.json' })], env);
    if (r.failed.size) throw new Error('parked payload failed');
  } else if (scenario === 'bigtrace') {
    const rows = bigTrace(crypto.randomUUID(), 20_000);
    records = rows.length;
    const sent: IngestMessage[] = [];
    const queue = { send: async (b: IngestMessage) => void sent.push(b), sendBatch: async (m: { body: IngestMessage }[]) => void sent.push(...m.map((x) => x.body)) };
    await enqueue({ TRACES: blobs, INGEST_QUEUE: queue }, 'bench', 'bench', rows);
    rows.length = 0;
    for (let i = 0; i < sent.length; i += 50) {
      const r = await processBodies(sent.slice(i, i + 50), env);
      if (r.failed.size) throw new Error('bigtrace failed');
    }
  } else throw new Error(`unknown scenario ${scenario}`);
  const ms = performance.now() - t0;
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
  return { scenario, records, ms: Math.round(ms), peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), rss_growth_mb: Math.round((process.resourceUsage().maxRSS * 1024 - startRss) / 2 ** 20) };
}

if (import.meta.main) {
  const scenarios = process.argv[2] ? [process.argv[2]] : ['batch', 'merge', 'parked', 'bigtrace'];
  if (scenarios.length === 1) console.log(JSON.stringify(await run(scenarios[0] ?? 'batch')));
  else for (const s of scenarios) console.log((await Bun.$`bun ${import.meta.path} ${s}`.text()).trim());
}
