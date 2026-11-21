import { apiKeyKvKey, type IngestMessage } from '@edgewatch/shared';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { processMessage } from '../../consumer/src/process';
import app, { type Env } from '../src/index';

const READ_KEY = 'ew_read_api_test';
const now = Date.now() / 1000;
const T1 = '019aa7b1-35fb-7000-8000-0000000000a1';
const T2 = '019aa7b1-35fb-7000-8000-0000000000a2';
const base = (trace_id: string, offset = 0) => ({ timestamp: now - 60 + offset, deploy: 'v1', server: 'web-1', _group: 'g', trace_id, execution_source: 'request', user: '7' });

async function get(path: string, key = READ_KEY) {
  const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env as unknown as Env);
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  await env.API_KEYS.put(await apiKeyKvKey(READ_KEY), JSON.stringify({ project_id: 'proj_api', name: 'read', scopes: ['read'] }));
  await env.API_KEYS.put(await apiKeyKvKey('ew_live_ingest_only'), JSON.stringify({ project_id: 'proj_api', name: 'ingest', scopes: ['ingest'] }));

  const msg = (records: unknown[]): IngestMessage => ({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: records as IngestMessage['records'] });
  // Ingest through the real consumer so the API is tested against what the pipeline actually writes.
  await processMessage(msg([
    { v: 1, t: 'query', ...base(T1, 0.01), sql: 'select * from orders where id = 5', file: 'app/O.php', line: 4, duration: 3000, connection: 'mysql' },
    { v: 1, t: 'query', ...base(T1, 0.02), sql: 'select * from orders where id = 6', file: 'app/O.php', line: 4, duration: 250_000, connection: 'mysql' },
    { v: 1, t: 'outgoing-request', ...base(T1, 0.03), host: 'api.stripe.com', method: 'POST', url: 'https://api.stripe.com/v1/charges', duration: 90_000, status_code: 402 },
    { v: 3, t: 'exception', ...base(T1, 0.3), class: 'App\\PaymentDeclined', file: 'app/Pay.php', line: 88, message: 'Declined', code: '0', trace: '[{"file":"app/Pay.php:88","source":"charge()","code":null}]', handled: false },
    { v: 1, t: 'request', ...base(T1), method: 'POST', url: 'https://shop.test/checkout', route_name: 'checkout', route_path: '/checkout', status_code: 500, duration: 400_000 },
    { v: 1, t: 'query', ...base(T2, 0.01), sql: 'select * from orders where id = 9', file: 'app/O.php', line: 4, duration: 1000, connection: 'mysql' },
    { v: 1, t: 'request', ...base(T2, 1), method: 'GET', url: 'https://shop.test/', route_name: 'home', route_path: '/', status_code: 200, duration: 20_000 },
  ]), env as never);
});

describe('workers/api', () => {
  it('requires a read key for the requested project', async () => {
    expect((await get('/v1/projects/proj_api/traces', 'nope')).status).toBe(401);
    expect((await get('/v1/projects/proj_api/traces', 'ew_live_ingest_only')).status).toBe(401);
    expect((await get('/v1/projects/other/traces')).status).toBe(403);
  });

  it('lists traces newest first with filters and keyset pagination', async () => {
    const all = await get('/v1/projects/proj_api/traces');
    expect(all.json.data.map((t: any) => t.trace_id)).toEqual([T2, T1]);
    expect(all.json.data[1]).toMatchObject({ name: 'POST /checkout', status_code: 500, query_count: 2, exception_count: 1 });
    expect(all.json.data[1]).not.toHaveProperty('r2_key');

    expect((await get('/v1/projects/proj_api/traces?status=5xx')).json.data).toHaveLength(1);
    expect((await get('/v1/projects/proj_api/traces?q=checkout')).json.data[0].trace_id).toBe(T1);

    const page1 = await get('/v1/projects/proj_api/traces?limit=1');
    expect(page1.json.next_cursor).toBeTruthy();
    const page2 = await get(`/v1/projects/proj_api/traces?limit=1&cursor=${page1.json.next_cursor}`);
    expect(page2.json.data[0].trace_id).toBe(T1);
    expect(page2.json.next_cursor).toBeNull();
  });

  it('returns a trace with raw R2 records and a derived waterfall', async () => {
    const { status, json } = await get(`/v1/projects/proj_api/traces/${T1}`);
    expect(status).toBe(200);
    expect(json.records).toHaveLength(5);
    expect(json.spans.map((s: any) => s.type)).toEqual(['request', 'query', 'query', 'outgoing-request', 'exception']);
    expect(json.spans[2]).toMatchObject({ label: 'select * from orders where id = ?', duration_ms: 250 });
    expect((await get('/v1/projects/proj_api/traces/missing')).status).toBe(404);
  });

  it('groups queries by sql_hash with literals stripped', async () => {
    const { json } = await get('/v1/projects/proj_api/queries');
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({ sql: 'select * from orders where id = ?', calls: 3, max_ms: 250, p95_ms: 250 });
    expect(json.data[0].trend.reduce((a: number, b: number) => a + b, 0)).toBe(3);

    const detail = await get(`/v1/projects/proj_api/queries/${json.data[0].sql_hash}`);
    expect(detail.json.samples[0]).toMatchObject({ trace_id: T1, name: 'POST /checkout', duration_ms: 250 });
  });

  it('groups exceptions and returns the stack and occurrences', async () => {
    const { json } = await get('/v1/projects/proj_api/exceptions');
    expect(json.data[0]).toMatchObject({ class: 'App\\PaymentDeclined', count: 1, users: 1, handled: false, last_trace_id: T1 });

    const detail = await get(`/v1/projects/proj_api/exceptions/${json.data[0].group}`);
    expect(detail.json.stack).toEqual([{ file: 'app/Pay.php:88', source: 'charge()' }]);
    expect(detail.json.occurrences[0]).toMatchObject({ trace_id: T1, name: 'POST /checkout' });
  });

  it('summarizes the overview', async () => {
    const { json } = await get('/v1/projects/proj_api/overview?range=1h');
    expect(json).toMatchObject({ range: '1h', requests: 2, error_rate: 0.5, exceptions: 1, slow_queries: 1, p95_ms: 400 });
    expect(json.series).toHaveLength(24);
    expect(json.top_routes.map((r: any) => r.route).sort()).toEqual(['GET /', 'POST /checkout']);
  });
});
