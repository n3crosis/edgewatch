/**
 * Local throughput check: sends Nightwatch-shaped batches to /api/ingest for DURATION seconds with CONCURRENCY parallel
 * senders, then waits until the consumer has counted them in usage_daily. Run through scripts/load-test.sh, which starts
 * wrangler dev (Miniflare) with fresh state. Numbers are for this machine's Miniflare, not Cloudflare.
 */
const env = process.env;
const INGEST_URL = env.INGEST_URL ?? 'http://127.0.0.1:8787/api/ingest';
const API_URL = env.API_URL ?? 'http://127.0.0.1:8788';
const PROJECT = env.PROJECT ?? 'load';
const DURATION = Number(env.DURATION ?? 20);
const CONCURRENCY = Number(env.CONCURRENCY ?? 8);
const TRACES = Number(env.TRACES_PER_REQUEST ?? 10);
const QUERIES = Number(env.QUERIES_PER_TRACE ?? 10);
const DRAIN_TIMEOUT = Number(env.DRAIN_TIMEOUT ?? 300);
const INGEST_KEY = env.INGEST_KEY ?? '';
const READ_KEY = env.READ_KEY ?? '';
/** Dashboard reads sampled while ingest is under load (one reader per endpoint, back to back). 0 turns them off. */
const READERS = Number(env.READERS ?? 1);
export const READ_PATHS = ['overview', 'traces?limit=50', 'exceptions', 'queries'];

export function batch(seq: number, traces = TRACES, queries = QUERIES): Record<string, unknown>[] {
  const now = Date.now() / 1000;
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < traces; i++) {
    const trace_id = crypto.randomUUID();
    const exec = { deploy: 'load', server: 'load-1', _group: 'g', trace_id, execution_source: 'request', execution_id: trace_id, execution_preview: 'GET /orders/{id}', execution_stage: 'action', user: String(seq % 50) };
    records.push({ v: 1, t: 'request', timestamp: now, ...exec, method: 'GET', url: `https://shop.test/orders/${seq}`, route_name: 'orders.show', route_methods: ['GET'], route_domain: '', route_path: '/orders/{id}', route_action: 'OrderController@show', ip: '127.0.0.1', duration: 42_000, status_code: 200, request_size: 0, response_size: 1200, bootstrap: 5000, before_middleware: 1000, action: 30_000, render: 3000, after_middleware: 1000, sending: 1000, terminating: 1000, exceptions: 0, logs: 0, queries, lazy_loads: 0, jobs_queued: 0, mail: 0, notifications: 0, outgoing_requests: 0, files_read: 0, files_written: 0, cache_events: 0, hydrated_models: 0, peak_memory_usage: 12_000_000, exception_preview: '', context: '', headers: '{}' });
    for (let q = 0; q < queries; q++) {
      records.push({ v: 1, t: 'query', timestamp: now, ...exec, sql: `select * from orders where id = ? and tenant = ${q % 3}`, file: 'app/Http/Controllers/OrderController.php', line: 10 + q, duration: 900, connection: 'mysql', connection_type: 'read' });
    }
  }
  return records;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

async function processed(): Promise<number> {
  const res = await fetch(`${API_URL}/v1/projects/${PROJECT}/usage?days=1`, { headers: { authorization: `Bearer ${READ_KEY}` } });
  if (!res.ok) return 0;
  const { data } = (await res.json()) as { data: { records: number }[] };
  return data.reduce((a, r) => a + r.records, 0);
}

async function main() {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let sentRecords = 0;
  let seq = 0;
  const started = performance.now();
  const until = started + DURATION * 1000;
  const reads = new Map<string, number[]>(READ_PATHS.map((p) => [p, []]));
  let readErrors = 0;
  const readers = READERS > 0 ? READ_PATHS.map(async (path) => {
    while (performance.now() < until) {
      const t0 = performance.now();
      const res = await fetch(`${API_URL}/v1/projects/${PROJECT}/${path}`, { headers: { authorization: `Bearer ${READ_KEY}` } }).catch(() => null);
      await res?.arrayBuffer();
      if (res?.ok) reads.get(path)?.push(performance.now() - t0);
      else readErrors++;
    }
  }) : [];
  const senders = Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < until) {
      const records = batch(seq++);
      const t0 = performance.now();
      const res = await fetch(INGEST_URL, { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json', 'nightwatch-server': 'load-1' }, body: JSON.stringify({ records }) }).catch(() => null);
      latencies.push(performance.now() - t0);
      const status = res?.status ?? 0;
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (status === 200) sentRecords += records.length;
      await res?.arrayBuffer();
    }
  });
  await Promise.all([...senders, ...readers]);
  const sendSeconds = (performance.now() - started) / 1000;
  const requests = latencies.length;

  let done = await processed();
  let last = done;
  let lastChange = performance.now();
  while (done < sentRecords && performance.now() - lastChange < DRAIN_TIMEOUT * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    done = await processed();
    if (done !== last) {
      last = done;
      lastChange = performance.now();
    }
  }
  const totalSeconds = (lastChange - started) / 1000;
  latencies.sort((a, b) => a - b);
  const result = {
    config: { duration_s: DURATION, concurrency: CONCURRENCY, records_per_request: TRACES * (1 + QUERIES), traces_per_request: TRACES },
    ingest: { requests, req_per_s: +(requests / sendSeconds).toFixed(1), records_per_s: +(sentRecords / sendSeconds).toFixed(0), p50_ms: +pct(latencies, 50).toFixed(1), p95_ms: +pct(latencies, 95).toFixed(1), p99_ms: +pct(latencies, 99).toFixed(1), statuses: Object.fromEntries(statuses) },
    reads_under_load: {
      errors: readErrors,
      ...Object.fromEntries([...reads].map(([path, l]) => {
        l.sort((a, b) => a - b);
        return [path.split('?')[0], { n: l.length, p50_ms: +pct(l, 50).toFixed(1), p95_ms: +pct(l, 95).toFixed(1), max_ms: +(l.at(-1) ?? 0).toFixed(1) }];
      })),
    },
    pipeline: { accepted_records: sentRecords, processed_records: done, end_to_end_s: +totalSeconds.toFixed(1), processed_records_per_s: +(done / totalSeconds).toFixed(0), traces_per_s: +(done / (1 + QUERIES) / totalSeconds).toFixed(1), complete: done >= sentRecords },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.pipeline.complete || !statuses.has(200)) process.exit(1);
}

if (import.meta.main) await main();
