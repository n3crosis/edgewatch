import { shortHash, type IngestMessage } from '@edgewatch/shared';
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { alert, checkPipeline, MAX_REPLAY_ATTEMPTS, replayDeadLetters, retryDelaySeconds, storeDeadLetters } from '../src/pipeline';
import { recordUsage, utcDay } from '../src/usage';
import { processMessage, applyRetention, capRecords, D1_BATCH_STATEMENTS, fingerprint, MAX_TRACE_RECORDS, type Env } from '../src/process';

const TRACE = '019aa7b1-35fb-7000-8000-0000000000c1';
const base = { timestamp: 1763750000.5, deploy: 'v1', server: 'web-1', _group: 'g', trace_id: TRACE, execution_source: 'request', execution_id: TRACE, user: '42' };

const message = (records: Record<string, unknown>[], extra: Partial<IngestMessage> = {}): IngestMessage => ({
  project_id: 'proj_c', server: 'web-1', received_at: 1763750001000, trace_id: TRACE, records: records as IngestMessage['records'], ...extra,
});

async function deliver(...bodies: IngestMessage[]) {
  const batch = createMessageBatch('edgewatch-ingest', bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env as never);
  return getQueueResult(batch, ctx);
}

describe('queue consumer', () => {
  it('captures environment from records and preserves it across partial deliveries', async () => {
    await deliver(message([{ v: 1, t: 'log', ...base, environment: 'staging', level: 'info', message: 'Before request' }]));
    expect(await env.DB.prepare('SELECT environment FROM traces WHERE trace_id = ?').bind(TRACE).first('environment')).toBe('staging');
    await deliver(message([{ v: 1, t: 'request', ...base, environment: 'production', method: 'GET', url: 'https://test/', status_code: 200, duration: 1000 }]));
    expect(await env.DB.prepare('SELECT environment FROM traces WHERE trace_id = ?').bind(TRACE).first('environment')).toBe('production');
    await deliver(message([{ v: 1, t: 'log', ...base, timestamp: base.timestamp + 1, level: 'info', message: 'After request' }]));
    expect(await env.DB.prepare('SELECT environment FROM traces WHERE trace_id = ?').bind(TRACE).first('environment')).toBe('production');
  });

  it('leaves environment unknown when the client did not capture it', async () => {
    await deliver(message([{ v: 1, t: 'request', ...base, server: 'production', method: 'GET', url: 'https://test/', status_code: 200, duration: 1000 }]));
    expect(await env.DB.prepare('SELECT environment FROM traces WHERE trace_id = ?').bind(TRACE).first('environment')).toBeNull();
  });

  it('stores unknown types named like object properties without retrying', async () => {
    const types = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const result = await deliver(message(types.map((t) => ({ v: 1, t, ...base, payload: 'preserved' }))));
    expect(result.explicitAcks).toEqual(['m0']);
    const trace = await env.DB.prepare('SELECT r2_key FROM traces WHERE trace_id = ?').bind(TRACE).first<{ r2_key: string }>();
    const raw = await (await env.TRACES.get(trace!.r2_key))!.json<{ records: { t: string; payload: string }[] }>();
    expect(raw.records.map((r) => r.t)).toEqual(types);
    expect(raw.records.every((r) => r.payload === 'preserved')).toBe(true);
  });

  it('normalizes SQL, writes D1 metadata and stores the raw trace in R2', async () => {
    const result = await deliver(
      message([
        { v: 1, t: 'query', ...base, sql: "select * from users where email = 'jane@example.com' and id in (1, 2, 3)", file: 'app/A.php', line: 3, duration: 2500, connection: 'mysql' },
        { v: 3, t: 'exception', ...base, class: 'RuntimeException', file: 'app/B.php', line: 9, message: 'boom for jane@example.com', code: '0', trace: '[{"file":"app/B.php:9","source":"x","code":null}]', handled: false },
        { v: 1, t: 'request', ...base, method: 'GET', url: 'https://shop.test/users/1', route_name: 'users.show', route_path: '/users/{id}', status_code: 500, duration: 48_000, queries: 1, exceptions: 1 },
      ]),
    );

    expect(result.explicitAcks).toEqual(['m0']);

    const trace = await env.DB.prepare('SELECT * FROM traces WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(trace).toMatchObject({
      project_id: 'proj_c', execution_source: 'request', name: 'GET /users/{id}', status_code: 500, duration_ms: 48, query_count: 1, exception_count: 1,
      date: '2025-11-21', r2_key: `traces/proj_c/2025-11-21/${TRACE}.json`, user: '42',
    });

    const query = await env.DB.prepare('SELECT * FROM queries WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(query).toMatchObject({ sql: 'select * from users where email = ? and id in (?)', duration_ms: 2.5, connection: 'mysql' });
    expect(query!.sql_hash).toMatch(/^[0-9a-f]{32}$/);

    const exception = await env.DB.prepare('SELECT * FROM exceptions WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(exception).toMatchObject({ class: 'RuntimeException', message: 'boom for [email]', handled: 0, line: 9 });

    const raw = (await (await env.TRACES.get(trace!.r2_key as string))!.json()) as { records: { t: string; sql?: string }[] };
    expect(raw.records).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain('jane@example.com');
  });

  it('preserves a blob written before the first SQL trace row committed', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000c2';
    const record = { v: 1, t: 'query', ...base, trace_id: id, sql: 'select ?', sql_hash: 'prior', duration: 100, connection: 'mysql' };
    const date = new Date(base.timestamp * 1000).toISOString().slice(0, 10);
    await env.TRACES.put(`traces/proj_c/${date}/${id}.json`, JSON.stringify({ project_id: 'proj_c', trace_id: id, records: [record] }));
    await deliver(message([{ v: 1, t: 'command', ...base, trace_id: id, command: 'sync', name: 'sync', duration: 100 }], { trace_id: id }));
    expect(await env.DB.prepare('SELECT query_count FROM traces WHERE trace_id = ?').bind(id).first('query_count')).toBe(1);
    const stored = await (await env.TRACES.get(`traces/proj_c/${date}/${id}.json`))?.json<{ records: unknown[] }>();
    expect(stored?.records).toHaveLength(2);
  });

  it('merges records for the same trace that arrive in separate messages', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000c2';
    await deliver(message([{ v: 1, t: 'query', ...base, trace_id: id, sql: 'select 1', duration: 100, connection: 'mysql' }], { trace_id: id }));
    await deliver(message([{ v: 1, t: 'command', ...base, trace_id: id, execution_source: 'command', name: 'shop:sync', command: 'shop:sync --force', exit_code: 0, duration: 1_200_000 }], { trace_id: id }));

    const trace = await env.DB.prepare('SELECT name, execution_source, query_count, duration_ms, r2_key FROM traces WHERE trace_id = ?').bind(id).first<Record<string, unknown>>();
    expect(trace).toMatchObject({ name: 'php artisan shop:sync --force', execution_source: 'command', query_count: 1, duration_ms: 1200 });
    const raw = (await (await env.TRACES.get(trace!.r2_key as string))!.json()) as { records: unknown[] };
    expect(raw.records).toHaveLength(2);
  });

  it('loads oversized payloads parked in R2 by the ingest worker and cleans them up', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000c3';
    await env.TRACES.put('incoming/proj_c/big.json', JSON.stringify([{ v: 1, t: 'job-attempt', ...base, trace_id: id, execution_source: 'job', execution_id: id, name: 'App\\Jobs\\Sync', status: 'processed', duration: 5000 }]));

    const result = await deliver(message([], { trace_id: id, records: undefined, r2_key: 'incoming/proj_c/big.json' }));

    expect(result.explicitAcks).toEqual(['m0']);
    expect(await env.DB.prepare('SELECT name FROM traces WHERE trace_id = ?').bind(id).first('name')).toBe('App\\Jobs\\Sync');
    expect(await env.TRACES.get('incoming/proj_c/big.json')).toBeNull();
    // A delivery after ack can still refer to the now-deleted parked payload.
    const again = await deliver(message([], { trace_id: id, records: undefined, r2_key: 'incoming/proj_c/big.json' }));
    expect(again.explicitAcks).toEqual(['m0']);
    expect(await env.DB.prepare('SELECT records FROM usage_daily WHERE project_id = ?').bind('proj_c').first('records')).toBe(1);
  });

  it('retries messages it cannot process', async () => {
    const result = await deliver(message([], { records: undefined, r2_key: 'incoming/missing.json' }));
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['m0']);
  });
});

describe('project-tagged storage', () => {
  it('keeps the same trace id from two projects in separate R2 partitions and D1 rows', async () => {
    const shared = '019aa7b1-35fb-7000-8000-0000000000d1';
    const rec = { ...base, trace_id: shared, execution_id: shared };
    const result = await deliver(
      message([{ v: 1, t: 'request', ...rec, method: 'GET', url: 'https://a.test/', route_name: 'a', route_path: '/a', status_code: 200, duration: 1000 }], { project_id: 'proj_a', trace_id: shared }),
      message([{ v: 1, t: 'request', ...rec, method: 'GET', url: 'https://b.test/', route_name: 'b', route_path: '/b', status_code: 500, duration: 2000 }], { project_id: 'proj_b', trace_id: shared }),
    );
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1']);

    const rows = await env.DB.prepare('SELECT project_id, name, r2_key FROM traces WHERE trace_id = ? ORDER BY project_id').bind(shared).all<{ project_id: string; name: string; r2_key: string }>();
    expect(rows.results.map((r) => [r.project_id, r.name])).toEqual([['proj_a', 'GET /a'], ['proj_b', 'GET /b']]);
    expect(rows.results[0].r2_key).toMatch(new RegExp(`^traces/proj_a/\\d{4}-\\d{2}-\\d{2}/${shared}\\.json$`));
    expect(rows.results[1].r2_key).toMatch(new RegExp(`^traces/proj_b/\\d{4}-\\d{2}-\\d{2}/${shared}\\.json$`));

    const a = (await (await env.TRACES.get(rows.results[0].r2_key))!.json()) as { project_id: string; records: { url: string }[] };
    expect(a.project_id).toBe('proj_a');
    expect(a.records.map((r) => r.url)).toEqual(['https://a.test/']);
  });
});

describe('batching', () => {
  it('stores a trace split across messages of one batch as a single R2 object and D1 row', async () => {
    const T = '019aa7b1-35fb-7000-8000-0000000000d1';
    const rec = (extra: Record<string, unknown>) => ({ ...base, trace_id: T, execution_id: T, ...extra });
    const result = await deliver(
      message([{ v: 1, t: 'query', ...rec({}), sql: 'select 1', file: 'a.php', line: 1, duration: 100, connection: 'mysql' }], { project_id: 'proj_batch', trace_id: T }),
      message([{ v: 1, t: 'query', ...rec({}), sql: 'select 1', file: 'a.php', line: 1, duration: 200, connection: 'mysql' }], { project_id: 'proj_batch', trace_id: T }),
      message([{ v: 1, t: 'request', ...rec({}), method: 'GET', url: 'https://shop.test/b', route_path: '/b', status_code: 200, duration: 9000 }], { project_id: 'proj_batch', trace_id: T }),
    );
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2']);
    const row = await env.DB.prepare('SELECT name, query_count FROM traces WHERE project_id = ? AND trace_id = ?').bind('proj_batch', T).first<{ name: string; query_count: number }>();
    expect(row).toEqual({ name: 'GET /b', query_count: 2 });
    const stored = (await (await env.TRACES.get(`traces/proj_batch/2025-11-21/${T}.json`))!.json()) as { records: unknown[] };
    expect(stored.records).toHaveLength(3);
    const hashes = await env.DB.prepare('SELECT DISTINCT sql_hash FROM queries WHERE project_id = ?').bind('proj_batch').all();
    expect(hashes.results).toHaveLength(1);
  });

  it('retries only the message whose payload is missing and acks the rest', async () => {
    const result = await deliver(
      message([{ v: 1, t: 'request', ...base, trace_id: 'ok-trace', method: 'GET', url: 'https://shop.test/', status_code: 200, duration: 1 }], { project_id: 'proj_partial', trace_id: 'ok-trace' }),
      message([], { project_id: 'proj_partial', records: undefined, r2_key: 'incoming/proj_partial/missing.json' }),
    );
    expect(result.explicitAcks).toEqual(['m0']);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['m1']);
  });
});

describe('retry backoff', () => {
  it('exports only handlers from the Worker entry module', async () => {
    expect(Object.keys(await import('../src/index'))).toEqual(['default']);
  });


  it('waits 5 s doubling to 10 minutes, about 2.3 hours over the 20 configured retries', () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(retryDelaySeconds)).toEqual([5, 10, 20, 40, 320, 600, 600]);
    const total = Array.from({ length: 20 }, (_, i) => retryDelaySeconds(i + 1)).reduce((a, b) => a + b, 0);
    expect(total / 3600).toBeCloseTo(2.34, 1);
  });

  it('redelivers a failed batch with the attempt-based delay', async () => {
    const failing = { ...(env as unknown as Env), DB: { batch: () => Promise.reject(new Error('D1_ERROR: overloaded')), prepare: env.DB.prepare.bind(env.DB) } };
    const retry = vi.fn();
    const ack = vi.fn();
    const body = message([{ v: 1, t: 'request', ...base, method: 'GET', url: 'https://shop.test/', status_code: 200, duration: 1 }]);
    const batch = { queue: 'edgewatch-ingest', messages: [{ id: 'm0', timestamp: new Date(), attempts: 4, body, retry, ack }] };
    await worker.queue(batch as unknown as MessageBatch<IngestMessage>, failing as never);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 40 });
    expect(ack).not.toHaveBeenCalled();
  });
});

describe('retention', () => {
  it('deletes D1 rows and R2 traces older than RETENTION_DAYS, keeping newer data', async () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 0, 31);
    const old = (now - 40 * day) / 1000;
    const fresh = (now - 1 * day) / 1000;
    const rec = (trace: string, ts: number) => [
      { v: 1, t: 'query', ...base, trace_id: trace, timestamp: ts, sql: 'select 2', file: 'a.php', line: 1, duration: 100, connection: 'mysql' },
      { v: 3, t: 'exception', ...base, trace_id: trace, timestamp: ts, class: 'E', file: 'a.php', line: 1, message: 'x', code: '0', trace: '[]', handled: true },
      { v: 1, t: 'request', ...base, trace_id: trace, timestamp: ts, method: 'GET', url: 'https://shop.test/', status_code: 200, duration: 1 },
    ];
    await deliver(message(rec('old-trace', old), { project_id: 'proj_ret', trace_id: 'old-trace' }), message(rec('new-trace', fresh), { project_id: 'proj_ret', trace_id: 'new-trace' }));

    const result = await applyRetention({ ...(env as unknown as Env), RETENTION_DAYS: '30' }, now);
    expect(result).toMatchObject({ skipped: false, traces: expect.any(Number), r2_objects: expect.any(Number) });
    const left = await env.DB.prepare("SELECT trace_id FROM traces WHERE project_id = 'proj_ret'").all<{ trace_id: string }>();
    expect(left.results.map((r) => r.trace_id)).toEqual(['new-trace']);
    for (const table of ['exceptions', 'queries']) {
      const rows = await env.DB.prepare(`SELECT trace_id FROM ${table} WHERE project_id = 'proj_ret'`).all<{ trace_id: string }>();
      expect(rows.results.map((r) => r.trace_id)).toEqual(['new-trace']);
    }
    const listed = await env.TRACES.list({ prefix: 'traces/proj_ret/' });
    expect(listed.objects.map((o) => o.key)).toEqual([expect.stringContaining('new-trace')]);
  });

  it('deletes past one chunk per run and stops at its query or time budget, resuming on the next run', async () => {
    const now = Date.UTC(2026, 5, 30);
    const old = now - 60 * 86_400_000;
    const insert = (i: number) =>
      env.DB.prepare('INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, duration_ms, query_count, exception_count, r2_key) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)')
        .bind('proj_ret_bulk', `bulk-${i}`, old + i, '2026-05-01', 'request', 'GET /', `traces/proj_ret_bulk/2026-05-01/bulk-${i}.json`);
    await env.DB.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES ('proj_ret_bulk', 'proj_ret_bulk')").run();
    const ids = Array.from({ length: 2500 }, (_, i) => i);
    const count = () => env.DB.prepare("SELECT count(*) AS n FROM traces WHERE project_id = 'proj_ret_bulk'").first<number>('n');
    const retEnv = { ...(env as unknown as Env), RETENTION_DAYS: '30' };
    // Clear other projects' expired rows first so only proj_ret_bulk is due below.
    await applyRetention(retEnv, now);
    for (let i = 0; i < ids.length; i += 100) await env.DB.batch(ids.slice(i, i + 100).map(insert));

    // Time budget already spent: nothing is deleted and the run reports it is incomplete.
    let t = 0;
    const expired = await applyRetention(retEnv, now, { budgetMs: 10, clock: () => (t += 100) });
    expect(expired).toMatchObject({ complete: false, traces: 0 });
    expect(await count()).toBe(2500);

    // Two queries per trace chunk: one chunk of 1,000 fits, then the run stops.
    const partial = await applyRetention(retEnv, now, { maxQueries: 2 });
    expect(partial).toMatchObject({ complete: false, traces: 1000 });
    expect(await count()).toBe(1500);

    // The next run continues past the old fixed daily cap and finishes.
    const rest = await applyRetention(retEnv, now);
    expect(rest).toMatchObject({ complete: true, traces: 1500 });
    expect(await count()).toBe(0);
  });

  it('applies per-project retention_days over RETENTION_DAYS (0 keeps the project forever)', async () => {
    const now = Date.UTC(2027, 0, 31);
    const day = 86_400_000;
    const trace = (project: string, id: string, age: number) =>
      env.DB.prepare('INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, duration_ms, query_count, exception_count, r2_key) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)')
        .bind(project, id, now - age * day, '2027-01-01', 'request', 'GET /', `traces/${project}/${id}.json`);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, name, retention_days) VALUES ('proj_r7', 'proj_r7', 7), ('proj_rkeep', 'proj_rkeep', 0), ('proj_rdef', 'proj_rdef', NULL)"),
      trace('proj_r7', 'r7-old', 10), trace('proj_r7', 'r7-new', 3),
      trace('proj_rkeep', 'keep-old', 400),
      trace('proj_rdef', 'def-mid', 10), trace('proj_rdef', 'def-old', 40),
      env.DB.prepare("INSERT INTO queries (project_id, trace_id, timestamp, sql_hash, sql, duration_ms) VALUES ('proj_r7', 'gone', ?, 'h', 'select 1', 1)").bind(now - 10 * day),
    ]);
    const left = async (project: string) => (await env.DB.prepare('SELECT trace_id FROM traces WHERE project_id = ? ORDER BY trace_id').bind(project).all<{ trace_id: string }>()).results.map((r) => r.trace_id);
    const result = await applyRetention({ ...(env as unknown as Env), RETENTION_DAYS: '30' }, now);
    expect(result).toMatchObject({ skipped: false, complete: true });
    expect(await left('proj_r7')).toEqual(['r7-new']);
    expect(await left('proj_rkeep')).toEqual(['keep-old']);
    expect(await left('proj_rdef')).toEqual(['def-mid']);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM queries WHERE project_id = 'proj_r7'").first<number>('n')).toBe(0);
    // With the default off, only projects with their own retention are cleaned.
    await env.DB.batch([trace('proj_r7', 'r7-old2', 10), trace('proj_rdef', 'def-old2', 400)]);
    expect(await applyRetention({ ...(env as unknown as Env), RETENTION_DAYS: '0' }, now)).toMatchObject({ skipped: false, traces: 1 });
    expect(await left('proj_rdef')).toEqual(['def-mid', 'def-old2']);
  });

  it('keeps everything when RETENTION_DAYS is 0 and runs from the cron handler', async () => {
    await env.DB.prepare('UPDATE projects SET retention_days = NULL WHERE retention_days > 0').run();
    expect((await applyRetention({ ...(env as unknown as Env), RETENTION_DAYS: '0' })).skipped).toBe(true);
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '17 * * * *' });
    await expect(worker.scheduled(controller, env as never)).resolves.toBeUndefined();
  });
});

describe('Nightwatch fields and user records', () => {
  it('stores user records in the users table instead of creating a trace', async () => {
    const result = await deliver(
      message([{ v: 1, t: 'user', timestamp: 1763750000.4, id: '42', name: 'Jane Doe', username: 'jane@example.com' }], { project_id: 'proj_users', trace_id: null }),
      message([{ v: 1, t: 'user', timestamp: 1763750009, id: '42', name: 'Jane D.', username: '' }], { project_id: 'proj_users', trace_id: null }),
    );
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1']);
    const traces = await env.DB.prepare("SELECT count(*) AS n FROM traces WHERE project_id = 'proj_users'").first<number>('n');
    expect(traces).toBe(0);
    const user = await env.DB.prepare("SELECT id, name, username FROM users WHERE project_id = 'proj_users'").all();
    expect(user.results).toEqual([{ id: '42', name: 'Jane D.', username: 'jane@example.com' }]);
  });

  it('keeps peak memory, lazy loads, route action and job/task status on the trace row', async () => {
    const T = '019aa7b1-35fb-7000-8000-0000000000f1';
    const J = '019aa7b1-35fb-7000-8000-0000000000f2';
    await deliver(
      message([{ v: 1, t: 'request', ...base, trace_id: T, method: 'GET', url: 'https://shop.test/p', route_path: '/p', route_action: 'App\\Http\\Controllers\\ProductController@show', status_code: 200, duration: 9000, peak_memory_usage: 23_068_672, lazy_loads: 7 }], { project_id: 'proj_fields', trace_id: T }),
      message([{ v: 1, t: 'job-attempt', ...base, trace_id: J, execution_source: 'job', execution_id: J, name: 'App\\Jobs\\SendInvoice', connection: 'redis', queue: 'mail', attempt: 3, status: 'failed', duration: 1200, peak_memory_usage: 1024 }], { project_id: 'proj_fields', trace_id: J }),
    );
    const rows = await env.DB.prepare("SELECT trace_id, execution_source, peak_memory_usage, lazy_loads, route_action, status FROM traces WHERE project_id = 'proj_fields' ORDER BY trace_id").all();
    expect(rows.results).toEqual([
      { trace_id: T, execution_source: 'request', peak_memory_usage: 23_068_672, lazy_loads: 7, route_action: 'App\\Http\\Controllers\\ProductController@show', status: null },
      { trace_id: J, execution_source: 'job', peak_memory_usage: 1024, lazy_loads: null, route_action: null, status: 'failed' },
    ]);
  });
});

describe('job records', () => {
  it('stores job-attempt and queued-job records in job_attempts', async () => {
    const R = '019aa7b1-35fb-7000-8000-0000000000j1';
    const J = '019aa7b1-35fb-7000-8000-0000000000j2';
    await deliver(
      message([
        { v: 1, t: 'queued-job', ...base, trace_id: R, job_id: 'job-1', name: 'App\\Jobs\\SendInvoice', connection: 'redis', queue: 'mail', duration: 800 },
        { v: 1, t: 'request', ...base, trace_id: R, method: 'POST', url: 'https://shop.test/orders', status_code: 202, duration: 5000 },
      ], { project_id: 'proj_jobs', trace_id: R }),
      message([{ v: 1, t: 'job-attempt', ...base, trace_id: J, job_id: 'job-1', attempt_id: 'a1', attempt: 2, name: 'App\\Jobs\\SendInvoice', connection: 'redis', queue: 'mail', status: 'failed', duration: 1_500_000 }], { project_id: 'proj_jobs', trace_id: J }),
    );
    const rows = await env.DB.prepare("SELECT kind, name, job_id, queue, attempt, status, duration_ms FROM job_attempts WHERE project_id = 'proj_jobs' ORDER BY kind").all();
    expect(rows.results).toEqual([
      { kind: 'attempt', name: 'App\\Jobs\\SendInvoice', job_id: 'job-1', queue: 'mail', attempt: 2, status: 'failed', duration_ms: 1500 },
      { kind: 'queued', name: 'App\\Jobs\\SendInvoice', job_id: 'job-1', queue: 'mail', attempt: null, status: null, duration_ms: 0.8 },
    ]);

    const result = await applyRetention({ ...(env as unknown as Env), RETENTION_DAYS: '1' }, Date.UTC(2030, 0, 1));
    expect(result.job_attempts).toBeGreaterThanOrEqual(2);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM job_attempts WHERE project_id = 'proj_jobs'").first<number>('n')).toBe(0);
  });
});

describe('command records', () => {
  it('stores artisan runs in commands with the exit code and a PII-scrubbed command line', async () => {
    const C = '019aa7b1-35fb-7000-8000-0000000000c1';
    await deliver(message([{ v: 1, t: 'command', ...base, trace_id: C, execution_source: 'command', class: 'App\\Console\\Commands\\Notify', name: 'users:notify', command: 'users:notify --to=jane@example.com', exit_code: 1, duration: 2_500_000 }], { project_id: 'proj_cmd', trace_id: C }));
    const row = await env.DB.prepare("SELECT name, command, exit_code, duration_ms, trace_id FROM commands WHERE project_id = 'proj_cmd'").first();
    expect(row).toMatchObject({ name: 'users:notify', exit_code: 1, duration_ms: 2500, trace_id: C });
    expect(String(row?.command)).not.toContain('jane@example.com');
    expect(await env.DB.prepare("SELECT count(*) AS n FROM traces WHERE project_id = 'proj_cmd'").first<number>('n')).toBe(1);
  });
});

describe('cache-event records', () => {
  it('stores cache operations in cache_events with a scrubbed, truncated key', async () => {
    const K = '019aa7b1-35fb-7000-8000-0000000000k1';
    const ev = (type: string, key: string, extra: Record<string, unknown> = {}) => ({ v: 1, t: 'cache-event', ...base, trace_id: K, store: 'redis', key, type, duration: 300, ttl: 0, ...extra });
    await deliver(message([
      ev('miss', 'user:jane@example.com'),
      ev('write', 'user:jane@example.com', { ttl: 60, duration: 900 }),
      ev('hit', `report:${'x'.repeat(400)}`),
      ev('delete-failure', 'cart:9'),
    ], { project_id: 'proj_cache', trace_id: K }));
    const { results } = await env.DB.prepare("SELECT store, key, type, duration_ms, ttl FROM cache_events WHERE project_id = 'proj_cache' ORDER BY id").all<Record<string, any>>();
    expect(results.map((r) => r.type)).toEqual(['miss', 'write', 'hit', 'delete-failure']);
    expect(results[0].key).not.toContain('jane@example.com');
    expect(results[1]).toMatchObject({ store: 'redis', ttl: 60, duration_ms: 0.9 });
    expect(results[2].key).toHaveLength(255);
  });
});

describe('outgoing-request records', () => {
  it('stores outgoing HTTP calls with host, method, status and a URL without query string', async () => {
    const O = '019aa7b1-35fb-7000-8000-0000000000o1';
    await deliver(message([
      { v: 1, t: 'outgoing-request', ...base, trace_id: O, host: 'api.stripe.com', method: 'post', url: 'https://api.stripe.com/v1/charges?api_key=sk_live_123&email=jane@example.com', duration: 350_000, request_size: 120, response_size: 900, status_code: 402 },
      { v: 1, t: 'outgoing-request', ...base, trace_id: O, method: 'GET', url: 'https://cdn.test/a.png', duration: 1000, status_code: null },
    ], { project_id: 'proj_out', trace_id: O }));
    const { results } = await env.DB.prepare("SELECT host, method, url, status_code, duration_ms, request_size, response_size FROM outgoing_requests WHERE project_id = 'proj_out' ORDER BY id").all();
    expect(results).toEqual([
      { host: 'api.stripe.com', method: 'POST', url: 'https://api.stripe.com/v1/charges', status_code: 402, duration_ms: 350, request_size: 120, response_size: 900 },
      { host: 'cdn.test', method: 'GET', url: 'https://cdn.test/a.png', status_code: null, duration_ms: 1, request_size: null, response_size: null },
    ]);
  });
});

describe('mail and notification records', () => {
  it('stores mail with a scrubbed subject and recipient counts, and notifications per channel', async () => {
    const M = '019aa7b1-35fb-7000-8000-0000000000m1';
    await deliver(message([
      { v: 1, t: 'mail', ...base, trace_id: M, mailer: 'ses', class: 'App\\Mail\\Receipt', subject: 'Receipt for jane@example.com', to: 2, cc: 1, bcc: 0, attachments: 1, duration: 40_000, failed: false },
      { v: 1, t: 'mail', ...base, trace_id: M, mailer: 'log', class: '', duration: 1000, failed: true },
      { v: 1, t: 'notification', ...base, trace_id: M, channel: 'slack', class: 'App\\Notifications\\NewOrder', duration: 90_000, failed: false },
    ], { project_id: 'proj_mail', trace_id: M }));
    const mail = await env.DB.prepare("SELECT mailer, class, subject, to_count, cc_count, bcc_count, attachments, duration_ms, failed FROM mail WHERE project_id = 'proj_mail' ORDER BY id").all();
    expect(mail.results).toEqual([
      { mailer: 'ses', class: 'App\\Mail\\Receipt', subject: 'Receipt for [email]', to_count: 2, cc_count: 1, bcc_count: 0, attachments: 1, duration_ms: 40, failed: 0 },
      { mailer: 'log', class: '(raw)', subject: null, to_count: null, cc_count: null, bcc_count: null, attachments: null, duration_ms: 1, failed: 1 },
    ]);
    const notes = await env.DB.prepare("SELECT channel, class, duration_ms, failed FROM notifications WHERE project_id = 'proj_mail'").all();
    expect(notes.results).toEqual([{ channel: 'slack', class: 'App\\Notifications\\NewOrder', duration_ms: 90, failed: 0 }]);
  });
});

describe('scheduled-task records', () => {
  it('stores each run with cron, timezone, status and duration, and keeps it as the trace root', async () => {
    const S = '019aa7b1-35fb-7000-8000-0000000000s1';
    await deliver(message([
      { v: 1, t: 'scheduled-task', ...base, trace_id: S, execution_source: 'schedule', name: 'prune-carts', cron: '*/5 * * * *', timezone: 'UTC', repeat_seconds: 0, status: 'failed', duration: 2_500_000, exceptions: 1 },
    ], { project_id: 'proj_sched', trace_id: S }));
    const { results } = await env.DB.prepare("SELECT name, cron, timezone, repeat_seconds, status, duration_ms FROM scheduled_tasks WHERE project_id = 'proj_sched'").all();
    expect(results).toEqual([{ name: 'prune-carts', cron: '*/5 * * * *', timezone: 'UTC', repeat_seconds: 0, status: 'failed', duration_ms: 2500 }]);
    const trace = await env.DB.prepare("SELECT name, status, duration_ms FROM traces WHERE project_id = 'proj_sched'").first();
    expect(trace).toMatchObject({ name: 'prune-carts', status: 'failed', duration_ms: 2500 });
  });
});

describe('log records', () => {
  it('stores level, PII-scrubbed message and truncated context', async () => {
    const L = '019aa7b1-35fb-7000-8000-0000000000l1';
    await deliver(message([
      { v: 1, t: 'log', ...base, trace_id: L, level: 'WARNING', message: 'Refund for jane@example.com', context: JSON.stringify({ email: 'jane@example.com', big: 'x'.repeat(5000) }) },
      { v: 1, t: 'log', ...base, trace_id: L, level: 'debug', message: 'm'.repeat(5000), context: '{}' },
    ], { project_id: 'proj_logs', trace_id: L }));
    const { results } = await env.DB.prepare("SELECT level, message, context FROM logs WHERE project_id = 'proj_logs' ORDER BY id").all<{ level: string; message: string; context: string | null }>();
    expect(results.map((r) => r.level)).toEqual(['warning', 'debug']);
    expect(results[0].message).toBe('Refund for [email]');
    expect(results[0].context).toHaveLength(2048);
    expect(results[0].context).toContain('"email":"[email]"');
    expect(results[1].message).toHaveLength(4096);
    expect(results[1].context).toBeNull();
  });
});

describe('laravel/nightwatch job attempts', () => {
  it('stores each attempt as its own trace keyed by attempt id, linked to the dispatching trace', async () => {
    const R = '019aa7b1-35fb-7000-8000-0000000000n1';
    const A = '019aa7b1-35fb-7000-8000-0000000000n2';
    const job = { ...base, trace_id: R, execution_source: 'job', execution_id: A };
    await deliver(
      message([
        { v: 1, t: 'queued-job', ...base, trace_id: R, execution_id: R, job_id: 'j1', name: 'App\\Jobs\\Fresh', connection: 'database', queue: 'default', duration: 500 },
        { v: 1, t: 'request', ...base, trace_id: R, execution_id: undefined, method: 'GET', url: 'https://app.test/fresh', status_code: 200, duration: 5000 },
      ], { project_id: 'proj_nwjob', trace_id: R }),
      message([
        { v: 1, t: 'query', ...job, sql: 'select count(*) from users', file: 'app/Jobs/Fresh.php', line: 9, duration: 300, connection: 'sqlite' },
        { v: 1, t: 'job-attempt', ...base, trace_id: R, execution_source: 'job', execution_id: undefined, job_id: 'j1', attempt_id: A, attempt: 1, name: 'App\\Jobs\\Fresh', connection: 'database', queue: 'default', status: 'processed', duration: 6000 },
      ], { project_id: 'proj_nwjob', trace_id: R }),
    );
    const rows = await env.DB.prepare("SELECT trace_id, execution_source, name, query_count, status, origin_trace_id FROM traces WHERE project_id = 'proj_nwjob' ORDER BY execution_source").all();
    expect(rows.results).toEqual([
      { trace_id: A, execution_source: 'job', name: 'App\\Jobs\\Fresh', query_count: 1, status: 'processed', origin_trace_id: R },
      { trace_id: R, execution_source: 'request', name: 'GET /fresh', query_count: 0, status: null, origin_trace_id: null },
    ]);
    const attempts = await env.DB.prepare("SELECT kind, trace_id FROM job_attempts WHERE project_id = 'proj_nwjob' ORDER BY kind").all();
    expect(attempts.results).toEqual([{ kind: 'attempt', trace_id: A }, { kind: 'queued', trace_id: R }]);
  });
});

describe('retries, chunking and caps', () => {
  it('a redelivered message after a partial write does not duplicate R2 records or D1 rows', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000e1';
    const body = message([
      { v: 1, t: 'request', ...base, trace_id: id, execution_id: id, method: 'GET', url: 'https://shop.test/a', status_code: 500, duration: 2000 },
      { v: 1, t: 'query', ...base, trace_id: id, execution_id: id, sql: 'select 1', duration: 100, connection: 'mysql' },
      { v: 1, t: 'exception', ...base, trace_id: id, execution_id: id, class: 'E', message: 'boom', file: 'a.php', line: 1, handled: false },
      { v: 1, t: 'log', ...base, trace_id: id, execution_id: id, level: 'error', message: 'x' },
    ], { trace_id: id });
    await deliver(body);
    await deliver(body);
    const count = (table: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE trace_id = ?`).bind(id).first<number>('n');
    expect(await count('queries')).toBe(1);
    expect(await count('exceptions')).toBe(1);
    expect(await count('logs')).toBe(1);
    const trace = await env.DB.prepare('SELECT query_count, exception_count, r2_key FROM traces WHERE trace_id = ?').bind(id).first<{ query_count: number; exception_count: number; r2_key: string }>();
    expect(trace).toMatchObject({ query_count: 1, exception_count: 1 });
    const raw = (await (await env.TRACES.get(trace?.r2_key ?? ''))?.json()) as { records: unknown[] };
    expect(raw.records).toHaveLength(4);
  });

  it('commits regression state and audit together at a statement chunk boundary', async () => {
    const group = await shortHash('BoundaryError,0,boundary.php,1');
    const timestamp = base.timestamp * 1000;
    await env.DB.prepare(`INSERT INTO issues (project_id, group_hash, class, message, status, first_seen, last_seen, resolved_at, revision)
      VALUES ('proj_c', ?, 'BoundaryError', 'x', 'resolved', ?, ?, ?, 1)`).bind(group, timestamp - 1000, timestamp - 1000, timestamp - 1000).run();
    const snapshots: { status: string; revision: number; changes: number }[] = [];
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await env.DB.batch(statements);
        const row = await env.DB.prepare('SELECT status, revision FROM issues WHERE group_hash = ?').bind(group).first<{ status: string; revision: number }>();
        const changes = await env.DB.prepare('SELECT count(*) AS n FROM issue_changes WHERE group_hash = ?').bind(group).first<number>('n');
        snapshots.push({ ...row!, changes: changes! });
        return result;
      },
    };
    const queries = Array.from({ length: D1_BATCH_STATEMENTS - 2 }, (_, i) => ({ v: 1, t: 'query', ...base, sql: `select ${i}`, duration: i + 1, connection: 'sqlite' }));
    await processMessage(message([...queries, { v: 3, t: 'exception', ...base, class: 'BoundaryError', code: '0', file: 'boundary.php', line: 1, message: 'x', handled: false }]), { ...env, DB: db } as never);
    expect(snapshots.some((row) => row.status === 'open')).toBe(true);
    expect(snapshots.every((row) => row.status === 'resolved' ? row.revision === 1 && row.changes === 0 : row.revision === 2 && row.changes === 1)).toBe(true);
  });

  it('splits a large trace into several D1 batches and stores every row', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000e2';
    const queries = Array.from({ length: D1_BATCH_STATEMENTS * 2 + 7 }, (_, i) => ({ v: 1, t: 'query', ...base, trace_id: id, execution_id: id, sql: `select ${i}`, duration: 10 + i, connection: 'mysql' }));
    const result = await deliver(message([{ v: 1, t: 'request', ...base, trace_id: id, execution_id: id, method: 'GET', url: 'https://shop.test/b', status_code: 200, duration: 1000 }, ...queries], { trace_id: id }));
    expect(result.explicitAcks).toEqual(['m0']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM queries WHERE trace_id = ?').bind(id).first<number>('n')).toBe(queries.length);
  });

  it('caps stored records by count and size, keeps root records and counts what was dropped', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000e3';
    const root = { v: 1, t: 'request', ...base, trace_id: id } as never;
    const query = (i: number) => ({ v: 1, t: 'query', ...base, trace_id: id, sql: `select ${i}` }) as never;
    const byCount = capRecords([query(1), query(2), query(3), root], 2, 1e9);
    expect(byCount.kept).toHaveLength(2);
    expect(byCount.kept).toContain(root);
    expect(byCount.dropped).toBe(2);
    const bySize = capRecords([root, query(1), query(2)], 100, JSON.stringify(root).length + JSON.stringify(query(1)).length);
    expect(bySize.kept).toEqual([root, query(1)]);
    expect(bySize.dropped).toBe(1);
  });

  it('merges a trace parked as several parts in one batch and counts records past the cap as dropped', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000e4';
    const query = (i: number) => ({ v: 1, t: 'query', ...base, trace_id: id, execution_id: id, sql: 'select 1', line: i, duration: 10, connection: 'mysql' });
    const parts = [0, 1, 2].map((p) => Array.from({ length: 2000 }, (_, i) => query(p * 2000 + i)));
    parts[2]?.push({ v: 1, t: 'request', ...base, trace_id: id, execution_id: id, method: 'GET', url: 'https://shop.test/big', status_code: 200, duration: 1000 } as never);
    const bodies = await Promise.all(parts.map(async (records, p) => {
      await env.TRACES.put(`incoming/proj_c/big-${p}.json`, JSON.stringify(records));
      return message([], { records: undefined, r2_key: `incoming/proj_c/big-${p}.json`, trace_id: id });
    }));
    const result = await deliver(...bodies);
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2']);
    const trace = await env.DB.prepare('SELECT r2_key, query_count FROM traces WHERE trace_id = ?').bind(id).first<{ r2_key: string }>();
    const stored = (await (await env.TRACES.get(trace?.r2_key ?? ''))?.json()) as { records: { t: string }[]; dropped_records: number };
    expect(stored.records).toHaveLength(MAX_TRACE_RECORDS);
    expect(stored.records.some((r) => r.t === 'request')).toBe(true);
    expect(stored.dropped_records).toBe(6001 - MAX_TRACE_RECORDS);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM queries WHERE trace_id = ?').bind(id).first<number>('n')).toBe(MAX_TRACE_RECORDS - 1);
    expect(await env.TRACES.get('incoming/proj_c/big-0.json')).toBeNull();
  });

  it('fingerprints record JSON stably and tells different records apart', () => {
    const a = JSON.stringify({ t: 'query', sql: 'select 1' });
    expect(fingerprint(a)).toBe(fingerprint(String(a)));
    expect(fingerprint(a)).not.toBe(fingerprint(JSON.stringify({ t: 'query', sql: 'select 2' })));
    expect(Number.isSafeInteger(fingerprint(a))).toBe(true);
  });
});

describe('dead letters and pipeline stats', () => {
  const T = '019aa7b1-35fb-7000-8000-0000000000d1';
  const request = (trace: string) => ({ v: 1, t: 'request', ...base, trace_id: trace, method: 'GET', url: 'https://shop.test/dead', status_code: 200, duration: 1 });

  it('stores DLQ batches in D1 and R2 with parked payloads inlined, then replays them on request', async () => {
    await env.TRACES.put('incoming/proj_dead/parked.json', JSON.stringify([request(T)]));
    const dlq = createMessageBatch('edgewatch-ingest-dlq', [
      { id: 'dead-1', timestamp: new Date(), attempts: 1, body: message([], { project_id: 'proj_dead', trace_id: T, records: undefined, r2_key: 'incoming/proj_dead/parked.json' }) },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(dlq, env as never);
    expect((await getQueueResult(dlq, ctx)).explicitAcks).toEqual(['dead-1']);
    const row = await env.DB.prepare("SELECT project_id, trace_id, record_count, r2_key, replay_requested_at FROM dead_letters WHERE id = 'dead-1'").first();
    expect(row).toEqual({ project_id: 'proj_dead', trace_id: T, record_count: 1, r2_key: 'dead/proj_dead/dead-1.json', replay_requested_at: null });
    const stored = await (await env.TRACES.get('dead/proj_dead/dead-1.json'))?.json<IngestMessage>();
    expect(stored?.records).toHaveLength(1);
    expect(stored?.r2_key).toBeUndefined();
    // The DLQ message itself must not create a trace.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM traces WHERE project_id = 'proj_dead'").first<number>('n')).toBe(0);

    // Not requested yet: nothing happens.
    expect(await replayDeadLetters(env as unknown as Env)).toEqual({ replayed: 0, failed: 0 });
    await env.DB.prepare("UPDATE dead_letters SET replay_requested_at = 1 WHERE id = 'dead-1'").run();
    const queued: IngestMessage[] = [];
    const replayEnv = { ...env, INGEST_QUEUE: { sendBatch: async (messages: Iterable<{ body: IngestMessage }>) => { queued.push(...[...messages].map((m) => m.body)); } } } as unknown as Env;
    expect(await replayDeadLetters(replayEnv)).toEqual({ replayed: 1, failed: 0 });
    expect(await env.DB.prepare("SELECT trace_id FROM traces WHERE project_id = 'proj_dead'").first('trace_id')).toBeNull();
    expect(queued).toHaveLength(1);
    expect(queued[0].records).toBeUndefined();
    const replay = createMessageBatch('edgewatch-ingest', [{ id: 'replay-1', timestamp: new Date(), attempts: 1, body: queued[0] }]);
    await worker.queue(replay, env as never);
    expect(await env.DB.prepare("SELECT trace_id FROM traces WHERE project_id = 'proj_dead'").first('trace_id')).toBe(T);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM dead_letters WHERE id = 'dead-1'").first<number>('n')).toBe(0);
    expect(await env.TRACES.get('dead/proj_dead/dead-1.json')).toBeNull();
  });

  it('keeps the dead letter when replay enqueue fails', async () => {
    await storeDeadLetters([{ id: 'enqueue-fail', body: message([request(T)], { project_id: 'proj_dead' }) }], env as unknown as Env);
    await env.DB.prepare("UPDATE dead_letters SET replay_requested_at = 1 WHERE id = 'enqueue-fail'").run();
    const broken = { ...env, INGEST_QUEUE: { sendBatch: async () => { throw new Error('queue unavailable'); } } } as unknown as Env;
    expect(await replayDeadLetters(broken)).toEqual({ replayed: 0, failed: 1 });
    expect(await env.DB.prepare("SELECT replay_attempts FROM dead_letters WHERE id = 'enqueue-fail'").first('replay_attempts')).toBe(1);
    expect(await (await env.TRACES.get('dead/proj_dead/enqueue-fail.json'))?.json()).toMatchObject({ project_id: 'proj_dead' });
  });

  it('counts failed replays and gives up after MAX_REPLAY_ATTEMPTS', async () => {
    await env.DB.prepare("INSERT INTO dead_letters (id, project_id, received_at, failed_at, r2_key, replay_requested_at) VALUES ('dead-gone', 'proj_dead', 1, 1, 'dead/proj_dead/missing.json', 1)").run();
    for (let i = 0; i < MAX_REPLAY_ATTEMPTS; i++) expect(await replayDeadLetters(env as unknown as Env)).toEqual({ replayed: 0, failed: 1 });
    const row = await env.DB.prepare("SELECT replay_attempts, replay_requested_at, last_error FROM dead_letters WHERE id = 'dead-gone'").first();
    expect(row).toEqual({ replay_attempts: MAX_REPLAY_ATTEMPTS, replay_requested_at: null, last_error: 'Stored payload is missing.' });
    expect(await replayDeadLetters(env as unknown as Env)).toEqual({ replayed: 0, failed: 0 });
  });

  it('retries a DLQ message whose storage fails instead of acking it', async () => {
    const broken = { ...(env as unknown as Env), TRACES: { ...env.TRACES, get: env.TRACES.get.bind(env.TRACES), put: () => Promise.reject(new Error('R2 down')) } };
    const failed = await storeDeadLetters([{ id: 'dead-r2', body: message([request(T)], { project_id: 'proj_dead' }) }], broken as never);
    expect([...failed]).toEqual(['dead-r2']);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM dead_letters WHERE id = 'dead-r2'").first<number>('n')).toBe(0);
  });

  it('records per-minute batch stats with queue lag', async () => {
    const enqueued = new Date(Date.now() - 90_000);
    const batch = createMessageBatch('edgewatch-ingest', [{ id: 'lag-1', timestamp: enqueued, attempts: 1, body: message([request('019aa7b1-35fb-7000-8000-0000000000d2')], { project_id: 'proj_lag' }) }]);
    await worker.queue(batch, env as never);
    const row = await env.DB.prepare('SELECT batches, messages, retried, max_lag_ms FROM pipeline_minutes ORDER BY minute DESC LIMIT 1').first<{ batches: number; messages: number; retried: number; max_lag_ms: number }>();
    expect(row?.messages).toBeGreaterThanOrEqual(1);
    expect(row?.max_lag_ms).toBeGreaterThanOrEqual(90_000);
  });

  it('alerts on queue lag through the webhook at most once per hour, and never throws', async () => {
    const now = Date.now();
    await env.DB.prepare('INSERT INTO pipeline_minutes (minute, batches, messages, retried, max_lag_ms) VALUES (?, 1, 1, 0, 900000) ON CONFLICT (minute) DO UPDATE SET max_lag_ms = 900000').bind(now - (now % 60_000)).run();
    const sent: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    });
    const alertEnv = { ...(env as unknown as Env), ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', ALERT_LAG_SECONDS: '600' };
    expect(await checkPipeline(alertEnv, now)).toEqual({ max_lag_ms: 900000, alerted: true });
    expect(await checkPipeline(alertEnv, now + 60_000)).toEqual({ max_lag_ms: 900000, alerted: false });
    expect(sent).toEqual([expect.objectContaining({ source: 'edgewatch', event: 'queue_lag', max_lag_ms: 900000, text: expect.stringContaining('900 s') })]);
    // Without a webhook nothing is sent; a failing webhook is logged, not thrown.
    expect(await alert(env as unknown as Env, 'x', 'x', {})).toBe(false);
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    expect(await alert(alertEnv, 'other', 'x', {}, now)).toBe(false);
    fetchMock.mockRestore();
  });

  it('runs replay and lag checks from the 5-minute cron', async () => {
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '*/5 * * * *' });
    await expect(worker.scheduled(controller, env as never)).resolves.toBeUndefined();
  });
});

describe('usage metering and daily quota', () => {
  it('retries an accounting failure before ack and counts once after recovery', async () => {
    const body = message([{ v: 1, t: 'query', ...base, sql: 'select 1', duration: 100, connection: 'mysql' }], { message_id: 'accounting-retry' });
    const broken = { ...env, DB: {
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO usage_daily')) throw new Error('accounting unavailable');
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    } };
    const batch = createMessageBatch('edgewatch-ingest', [{ id: 'retry-account', timestamp: new Date(), attempts: 1, body }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, broken as never);
    expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM usage_receipts').first('n')).toBe(0);
    expect((await deliver(body)).explicitAcks).toEqual(['m0']);
    expect((await deliver(body)).explicitAcks).toEqual(['m0']);
    expect(await env.DB.prepare('SELECT records FROM usage_daily WHERE project_id = ?').bind('proj_c').first('records')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM queries WHERE project_id = ?').bind('proj_c').first('n')).toBe(1);
  });

  it('counts a receipt once across repeated accounting attempts', async () => {
    const records = new Map([['receipt-project', 7]]);
    await recordUsage(env as unknown as Env, records, Date.now(), 'receipt-1');
    await recordUsage(env as unknown as Env, records, Date.now(), 'receipt-1');
    expect(await env.DB.prepare('SELECT records FROM usage_daily WHERE project_id = ?').bind('receipt-project').first('records')).toBe(7);
  });

  const T = '019aa7b1-35fb-7000-8000-0000000000e1';
  const log = (n: number, project: string) =>
    message(Array.from({ length: n }, (_, i) => ({ v: 1, t: 'log', ...base, trace_id: T, execution_id: T, level: 'info', message: `line ${i}` })), { project_id: project });
  const today = () => utcDay(Date.now());
  const usageRow = (project: string) => env.DB.prepare('SELECT records, quota, blocked_at FROM usage_daily WHERE project_id = ? AND day = ?').bind(project, today()).first<{ records: number; quota: number | null; blocked_at: number | null }>();

  it('counts processed records per project per UTC day, without a quota by default', async () => {
    await deliver(log(3, 'proj_use_a'), log(2, 'proj_use_b'), log(1, 'proj_use_a'));
    expect(await usageRow('proj_use_a')).toEqual({ records: 4, quota: null, blocked_at: null });
    expect(await usageRow('proj_use_b')).toEqual({ records: 2, quota: null, blocked_at: null });
    expect(await env.API_KEYS.get('project:proj_use_a')).toBeNull();
  });

  it('does not count messages that will be retried', async () => {
    const result = await deliver(message([], { project_id: 'proj_use_fail', records: undefined, r2_key: 'incoming/missing.json' }));
    expect(result.retryMessages).toHaveLength(1);
    expect(await usageRow('proj_use_fail')).toBeNull();
  });

  it('blocks a project in KV until the next UTC midnight once it reaches its daily quota, once per day', async () => {
    await env.DB.prepare("INSERT INTO projects (id, name, daily_record_quota) VALUES ('proj_quota', 'proj_quota', 5)").run();
    await deliver({ ...log(3, 'proj_quota'), message_id: crypto.randomUUID() });
    expect(await env.API_KEYS.get('project:proj_quota')).toBeNull();
    await deliver({ ...log(3, 'proj_quota'), message_id: crypto.randomUUID() });
    const block = await env.API_KEYS.get<{ over_quota_until: number; reason: string; message: string }>('project:proj_quota', 'json');
    const midnight = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400;
    expect(block).toEqual({ over_quota_until: midnight, reason: 'daily_quota', message: 'Daily record quota of 5 reached.' });
    expect(await usageRow('proj_quota')).toEqual({ records: 6, quota: 5, blocked_at: expect.any(Number) });
    // Already blocked today: later batches (queued before the block) are still counted but KV is not written again.
    await env.API_KEYS.put('project:proj_quota', '{"marker":true}');
    await deliver(log(1, 'proj_quota'));
    expect(await env.API_KEYS.get('project:proj_quota')).toBe('{"marker":true}');
    expect((await usageRow('proj_quota'))?.records).toBe(7);
  });

  it('uses DAILY_RECORD_QUOTA as the default, keeps a longer manual block, and treats 0 as no quota', async () => {
    const e = { ...(env as unknown as Env), DAILY_RECORD_QUOTA: '2' };
    const later = Math.floor(Date.now() / 1000) + 10 * 86_400;
    await env.API_KEYS.put('project:proj_manual', JSON.stringify({ over_quota_until: later }));
    expect(await recordUsage(e, new Map([['proj_default', 2], ['proj_manual', 5]]))).toEqual({ blocked: ['proj_default', 'proj_manual'] });
    expect(await env.API_KEYS.get('project:proj_manual', 'json')).toEqual({ over_quota_until: later });
    expect(await env.API_KEYS.get<{ reason: string }>('project:proj_default', 'json')).toMatchObject({ reason: 'daily_quota' });
    await env.DB.prepare("INSERT INTO projects (id, name, daily_record_quota) VALUES ('proj_unlimited', 'proj_unlimited', 0)").run();
    expect(await recordUsage(e, new Map([['proj_unlimited', 50]]))).toEqual({ blocked: [] });
    expect(await recordUsage(e, new Map())).toEqual({ blocked: [] });
  });

  it('leaves the day unblocked when the KV write fails, so the next batch tries again', async () => {
    const e = { ...(env as unknown as Env), DAILY_RECORD_QUOTA: '1', API_KEYS: undefined };
    expect(await recordUsage(e, new Map([['proj_kv_down', 3]]))).toEqual({ blocked: [] });
    expect(await usageRow('proj_kv_down')).toEqual({ records: 3, quota: 1, blocked_at: null });
  });

  it('prunes usage older than 400 days from the 5-minute cron', async () => {
    await env.DB.prepare("INSERT INTO usage_daily (project_id, day, records) VALUES ('proj_old', '2000-01-01', 1)").run();
    await checkPipeline(env as unknown as Env);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM usage_daily WHERE project_id = 'proj_old'").first<number>('n')).toBe(0);
  });
});

describe('GET /healthz', () => {
  type Report = { status: string; service: string; checks: Record<string, { status: string; required: boolean; error?: string }> };
  const healthz = (override: Partial<Env> = {}, path = '/healthz', method = 'GET') =>
    worker.fetch(new Request(`https://consumer.edgewatch.test${path}`, { method }), { ...(env as unknown as Env), ...override });

  it('checks the event store, schema, blobs and keys; every other path is 404', async () => {
    const res = await healthz();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Report;
    expect(body).toMatchObject({ status: 'ok', service: 'consumer' });
    expect(Object.keys(body.checks).sort()).toEqual(['blobs', 'config', 'events', 'keys', 'schema']);
    expect((await healthz({}, '/')).status).toBe(404);
    expect((await healthz({}, '/healthz', 'POST')).status).toBe(404);
  });

  it('is degraded when only KV fails and down (503) when R2 fails', async () => {
    const failing = { get: () => Promise.reject(new Error('down')) } as never;
    const kv = await healthz({ API_KEYS: failing });
    expect(kv.status).toBe(200);
    expect(((await kv.json()) as Report).status).toBe('degraded');
    const r2 = await healthz({ TRACES: failing });
    expect(r2.status).toBe(503);
    expect(((await r2.json()) as Report).checks.blobs).toMatchObject({ status: 'fail', required: true, error: 'unavailable' });
  });
});
