import { apiKeyKvKey, type IngestMessage } from '@edgewatch/shared';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { processMessage } from '../../consumer/src/process';
import app, { type Env } from '../src/index';

const ADMIN_KEY = 'ew_read_admin_test';
const READ_KEY = 'ew_read_api_test';
const now = Date.now() / 1000;
const T1 = '019aa7b1-35fb-7000-8000-0000000000a1';
const T2 = '019aa7b1-35fb-7000-8000-0000000000a2';
const base = (trace_id: string, offset = 0) => ({ timestamp: now - 60 + offset, deploy: 'v1', server: 'web-1', _group: 'g', trace_id, execution_source: 'request', user: '7' });

async function get(path: string, key: string | null = READ_KEY, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } }), env as unknown as Env);
  return { status: res.status, json: (await res.json()) as any, headers: res.headers };
}

beforeAll(async () => {
  await env.API_KEYS.put(await apiKeyKvKey(ADMIN_KEY), JSON.stringify({ project_id: 'proj_api', name: 'admin', scopes: ['admin'] }));
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
  it('scopes aggregates, child events and detail reads by captured environment and project', async () => {
    const pid = 'env-scope';
    const emit = async (project: string, trace: string, environment?: string) => {
      const common = { ...base(trace), environment, timestamp: now - 5 };
      await processMessage({ project_id: project, server: 'same-server', received_at: Date.now(), trace_id: trace, records: [
        { v: 1, t: 'request', ...common, method: 'GET', url: 'https://test/env', route_name: 'env.route', status_code: 500, duration: 300000 },
        { v: 1, t: 'query', ...common, sql: 'select * from environment_items', file: 'Env.php', line: 1, duration: 200000, connection: 'sqlite' },
        { v: 3, t: 'exception', ...common, class: 'EnvironmentFailure', file: 'Env.php', line: 1, message: 'Failed', code: '0', handled: false, trace: JSON.stringify([{ file: `${environment}.php`, source: 'failed()' }]) },
        { v: 1, t: 'log', ...common, level: 'error', message: environment ?? 'unknown' },
      ] as unknown as IngestMessage['records'] }, env as never);
    };
    await emit(pid, 'env-production', 'production');
    await emit(pid, 'env-staging', 'staging');
    await emit(pid, 'env-unknown');
    await emit('env-other', 'env-production', 'staging');
    const path = `/v1/projects/${pid}`;
    const scope = 'environment=production&range=1h';
    const overview = (await get(`${path}/overview?${scope}`)).json;
    expect(overview).toMatchObject({ requests: 1, exceptions: 1, slow_queries: 1 });
    expect(overview.series.reduce((n: number, b: any) => n + b.requests, 0)).toBe(1);
    expect((await get(`${path}/requests?${scope}`)).json.data[0].requests).toBe(1);
    expect((await get(`${path}/requests/trend?route=env.route&${scope}`)).json.series.reduce((n: number, b: any) => n + b.requests, 0)).toBe(1);
    const exceptions = (await get(`${path}/exceptions?${scope}`)).json.data;
    expect(exceptions[0]).toMatchObject({ count: 1, last_trace_id: 'env-production' });
    expect(exceptions[0].trend.reduce((n: number, v: number) => n + v, 0)).toBe(1);
    const detail = (await get(`${path}/exceptions/${exceptions[0].group}?${scope}`)).json;
    expect(detail.occurrences.map((r: any) => r.trace_id)).toEqual(['env-production']);
    expect(detail.stack[0].file).toBe('production.php');
    const queries = (await get(`${path}/queries?${scope}`)).json.data;
    expect(queries[0].calls).toBe(1);
    expect((await get(`${path}/queries/${queries[0].sql_hash}?${scope}`)).json.samples.map((r: any) => r.trace_id)).toEqual(['env-production']);
    expect((await get(`${path}/log-entries?${scope}`)).json.data.map((r: any) => r.message)).toEqual(['production']);
    expect((await get(`${path}/logs?${scope}`)).json.data[0].count).toBe(1);
    expect((await get(`${path}/logs/error?${scope}`)).json.data.map((r: any) => r.trace_id)).toEqual(['env-production']);
    expect((await get(`${path}/queries?environment=staging`)).json.data[0].calls).toBe(1);
    expect((await get(`${path}/log-entries?environment=staging`)).json.data.map((r: any) => r.message)).toEqual(['staging']);
    expect((await get('/v1/exceptions?environment=production')).json.data.find((r: any) => r.class === 'EnvironmentFailure').count).toBe(1);
    expect((await get(`${path}/users?${scope}`)).json.data[0].count).toBe(1);
    expect((await get(`${path}/users/7?${scope}`)).json.data).toHaveLength(1);
    expect((await get(`${path}/traces/env-staging?${scope}`)).status).toBe(404);
    expect((await get(`${path}/traces/env-staging/raw?${scope}`)).status).toBe(404);
    await env.DB.prepare('UPDATE traces SET origin_trace_id = ? WHERE project_id = ? AND trace_id = ?').bind('env-production', pid, 'env-staging').run();
    expect((await get(`${path}/traces/env-production?${scope}`)).json.trace.environment).toBe('production');
    expect((await get(`${path}/traces/env-production?${scope}`)).json.related).toEqual([]);
    const issues = (await get(`${path}/issues?${scope}`)).json;
    expect(issues.lifecycle_scope).toBe('project');
    expect(issues.data).toHaveLength(1);
    expect((await get(`${path}/issues/${issues.data[0].group_hash}?${scope}`)).json.impact.occurrences).toBe(1);
    expect((await get(`${path}/issues/${issues.data[0].group_hash}?environment=missing`)).status).toBe(404);
    expect((await get(`${path}/environments`)).json.data.map((r: any) => r.name)).toEqual(['production', 'staging']);
    for (const endpoint of ['requests', 'queries', 'exceptions', 'logs', 'users', 'issues']) expect((await get(`${path}/${endpoint}?environment=missing`)).json.data).toEqual([]);
    expect((await get(`${path}/overview?environment=${'x'.repeat(129)}`)).status).toBe(400);
  });

  it('filters captured environments exactly and does not infer them for legacy traces', async () => {
    const path = '/v1/projects/proj_api/traces';
    expect((await get(path)).json.data.every((row: any) => row.environment === null)).toBe(true);
    expect((await get(`${path}?environment=web-1`)).json.data).toEqual([]);
    await env.DB.prepare('UPDATE traces SET environment = ? WHERE project_id = ? AND trace_id = ?').bind('production', 'proj_api', T1).run();
    await env.DB.prepare('UPDATE traces SET environment = ? WHERE project_id = ? AND trace_id = ?').bind('all', 'proj_api', T2).run();
    expect((await get(`${path}?environment=production&user=7&server=web-1&status=5xx`)).json.data.map((row: any) => row.trace_id)).toEqual([T1]);
    expect((await get(`${path}?environment=all`)).json.data.map((row: any) => row.trace_id)).toEqual([T2]);
    for (const value of ['prod', '%25', 'Production', 'staging']) expect((await get(`${path}?environment=${value}`)).json.data).toEqual([]);
    expect((await get('/v1/projects/other/traces?environment=production')).json.data).toEqual([]);
  });

  it('uses fixed inclusive bounds across requests, traces, exceptions and queries', async () => {
    const traces = (await get('/v1/projects/proj_api/traces')).json.data;
    const start = Date.parse(traces.find((t: any) => t.trace_id === T1).timestamp);
    const range = encodeURIComponent(`custom:${start}:${start + 500}`);
    const narrow = encodeURIComponent(`custom:${start}:${start + 1}`);
    const path = '/v1/projects/proj_api';
    expect((await get(`${path}/traces?range=${narrow}`)).json.data.map((t: any) => t.trace_id)).toEqual([T1]);
    expect((await get(`${path}/overview?range=${narrow}`)).json.requests).toBe(1);
    expect((await get(`${path}/requests?range=${narrow}`)).json.data).toHaveLength(1);
    expect((await get(`${path}/exceptions?range=${range}`)).json.data[0].count).toBe(1);
    expect((await get(`${path}/queries?range=${range}`)).json.data[0].calls).toBe(3);
    const empty = encodeURIComponent(`custom:${start + 501}:${start + 999}`);
    for (const endpoint of ['traces', 'requests', 'exceptions', 'queries', 'logs', 'log-entries']) expect((await get(`${path}/${endpoint}?range=${empty}`)).json.data).toEqual([]);
    for (const range of ['custom:2:1', 'custom:1:1', 'custom:1:NaN', 'custom:1:8640000000000001']) expect((await get(`${path}/overview?range=${range}`)).status).toBe(400);
  });

  it('scopes exception and query details to the selected relative window', async () => {
    const trace = crypto.randomUUID();
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: trace, records: [
      { v: 3, t: 'exception', ...base(trace), timestamp: now - 7200, class: 'OldWindowException', file: 'app/Old.php', line: 91, message: 'Old event', handled: true, trace: '[]' },
      { v: 1, t: 'query', ...base(trace), timestamp: now - 7200, sql: 'select * from old_window_table', duration: 2000, connection: 'sqlite', file: 'app/Old.php', line: 92 },
    ] as unknown as IngestMessage['records'] }, env as never);
    const exception = (await get('/v1/projects/proj_api/exceptions?range=24h')).json.data.find((e: any) => e.class === 'OldWindowException');
    const query = (await get('/v1/projects/proj_api/queries?range=24h')).json.data.find((q: any) => q.sql.includes('old_window_table'));
    expect((await get(`/v1/projects/proj_api/exceptions/${exception.group}?range=1h`)).status).toBe(404);
    expect((await get(`/v1/projects/proj_api/exceptions/${exception.group}?range=24h`)).json.count).toBe(1);
    expect((await get(`/v1/projects/proj_api/queries/${query.sql_hash}?range=1h`)).status).toBe(404);
    expect((await get(`/v1/projects/proj_api/queries/${query.sql_hash}?range=24h`)).json.calls).toBe(1);
  });

  it('allows one concurrent lifecycle update and records only the winning audit entry', async () => {
    const issue = (await get('/v1/projects/proj_api/issues')).json.data[0];
    const path = `/v1/projects/proj_api/issues/${issue.group_hash}`;
    const update = async (status: string, revision: unknown) => {
      const response = await app.fetch(new Request(`https://api.edgewatch.test${path}`, {
        method: 'PUT', headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status, expected_status: issue.status, expected_revision: revision, reason: `Choose ${status}` }),
      }), env as unknown as Env);
      await response.json();
      return response.status;
    };
    expect((await Promise.all([update('resolved', issue.revision), update('ignored', issue.revision)])).sort()).toEqual([200, 409]);
    const detail = (await get(path)).json;
    expect(detail.issue.revision).toBe(1);
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0].status).toBe(detail.issue.status);
    expect(await update('open', undefined)).toBe(422);
    expect(await update('open', '1')).toBe(422);
  });

  it('persists issue transitions and reopens only a newer unhandled occurrence', async () => {
    const initial = (await get('/v1/projects/proj_api/issues')).json.data.find((i: any) => i.class === 'App\\PaymentDeclined');
    expect(initial.status).toBe('open');
    expect(initial.revision).toBe(0);
    const path = `/v1/projects/proj_api/issues/${initial.group_hash}`;
    const transition = async (status: string, expected: string, key = ADMIN_KEY, revision?: number) => app.fetch(new Request(`https://api.edgewatch.test${path}`, { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ status, expected_status: expected, expected_revision: revision ?? (await get(path)).json.issue.revision, reason: 'Investigated test issue' }) }), env as unknown as Env);
    expect((await transition('resolved', 'open', READ_KEY)).status).toBe(403);
    expect((await transition('resolved', 'open')).status).toBe(200);
    expect((await transition('ignored', 'open')).status).toBe(409);
    const emit = async (timestamp: number) => {
      const trace = crypto.randomUUID();
      await processMessage({ project_id: 'proj_api', server: 'web-1', message_id: trace, received_at: Date.now(), trace_id: trace, records: [{ v: 3, t: 'exception', ...base(trace), timestamp, class: 'App\\PaymentDeclined', file: 'app/Pay.php', line: 88, message: 'Declined', code: '0', trace: '[]', handled: false }] as unknown as IngestMessage['records'] }, env as never);
    };
    await emit(now - 100);
    expect((await get(path)).json.issue.status).toBe('resolved');
    await emit(Date.now() / 1000 + 1);
    expect((await get(path)).json.issue).toMatchObject({ status: 'open', revision: 2 });
    expect((await transition('ignored', 'open', ADMIN_KEY, initial.revision)).status).toBe(409);
    expect((await transition('ignored', 'open')).status).toBe(200);
    await emit(Date.now() / 1000 + 2);
    const detail = (await get(path)).json;
    expect(detail.issue.status).toBe('ignored');
    expect(detail.changes.map((c: any) => c.status).sort()).toEqual(['ignored', 'open', 'resolved']);
  });

  it('groups unnamed requests by captured templates without colliding with route names', async () => {
    const records = [
      { route_name: null, route_path: '/items/{item}', url: 'https://test/items/1' },
      { route_name: '', route_path: '/items/{item}', url: 'https://test/items/2' },
      { route_name: null, route_path: '/orders/{order}', url: 'https://test/orders/1' },
      { route_name: '/items/{item}', route_path: '/other', url: 'https://test/other' },
      { route_name: null, route_path: null, url: 'https://test/unmatched/1' },
    ].map((route) => ({ v: 1, t: 'request', ...base(crypto.randomUUID()), method: 'GET', status_code: 200, duration: 5000, ...route }));
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: records as unknown as IngestMessage['records'] }, env as never);
    const groups = (await get('/v1/projects/proj_api/requests')).json.data;
    expect(groups.find((r: any) => r.route_kind === 'path' && r.route === '/items/{item}')).toMatchObject({ requests: 2, p95_ms: 5 });
    expect(groups.find((r: any) => r.route_kind === 'name' && r.route === '/items/{item}')).toMatchObject({ requests: 1 });
    expect(groups.find((r: any) => r.route_kind === 'unknown')).toMatchObject({ requests: 1, route: '[unnamed]' });
    const path = '/v1/projects/proj_api/traces?source=request&route=%2Fitems%2F%7Bitem%7D&route_kind=path&method=GET';
    const detail = (await get(path)).json.data;
    expect(detail).toHaveLength(2);
    expect(detail.every((r: any) => r.route_path === '/items/{item}')).toBe(true);
    const trendPath = '/v1/projects/proj_api/requests/trend?route=%2Fitems%2F%7Bitem%7D&route_kind=path&method=GET';
    expect((await get(trendPath)).json.series.reduce((sum: number, b: any) => sum + b.requests, 0)).toBe(2);
    expect((await get(trendPath.replace('route_kind=path', 'route_kind=name'))).json.series.reduce((sum: number, b: any) => sum + b.requests, 0)).toBe(1);
    expect((await get(path.replace('route_kind=path', 'route_kind=name'))).json.data).toHaveLength(1);
  });

  it('filters executions by inclusive duration and combines status, route and paging', async () => {
    const path = '/v1/projects/proj_api/traces?source=request&range=1h';
    expect((await get(`${path}&min_duration_ms=20`)).json.data.map((t: any) => t.trace_id).sort()).toEqual([T1, T2].sort());
    expect((await get(`${path}&min_duration_ms=20.1`)).json.data.map((t: any) => t.trace_id)).toEqual([T1]);
    expect((await get(`${path}&min_duration_ms=400&status=5xx&route=checkout`)).json.data.map((t: any) => t.trace_id)).toEqual([T1]);
    expect((await get(`${path}&min_duration_ms=401`)).json.data).toEqual([]);
    expect((await get(`${path}&min_duration_ms=400&status=2xx`)).json.data).toEqual([]);
    const page = (await get(`${path}&min_duration_ms=20&limit=1`)).json;
    expect(page.next_cursor).toBeTruthy();
    expect((await get(`${path}&min_duration_ms=20&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)).json.data.map((t: any) => t.trace_id)).toEqual([T1]);
    for (const value of ['', '-1', 'NaN', 'Infinity', 'not-a-number']) expect((await get(`${path}&min_duration_ms=${value}`)).status).toBe(400);
  });

  it('computes exact query p95 beyond the former 50,000-row sampling limit', async () => {
    await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 50001
    ) INSERT INTO queries (project_id, trace_id, sql_hash, sql, connection, duration_ms, timestamp)
      SELECT 'proj_api', ?, 'large-p95-group', 'select large_sample', 'sqlite', CASE WHEN n <= 47500 THEN 1 ELSE 100 END, ? FROM numbers`)
      .bind(T1, Math.round(now * 1000)).run();
    const list = (await get('/v1/projects/proj_api/queries?range=1h')).json.data;
    expect(list.find((q: any) => q.sql_hash === 'large-p95-group')).toMatchObject({ calls: 50001, p95_ms: 100 });
    expect((await get('/v1/projects/proj_api/queries/large-p95-group?range=1h')).json).toMatchObject({ calls: 50001, p95_ms: 100 });
  });

  it('returns filtered request trends for one route, method and project', async () => {
    const path = '/v1/projects/proj_api/requests/trend?range=1h&route=checkout&route_kind=name&method=POST';
    const trend = (await get(path)).json;
    expect(trend.series).toHaveLength(24);
    expect(trend.series.reduce((sum: number, b: any) => sum + b.requests, 0)).toBe(1);
    expect(trend.series.reduce((sum: number, b: any) => sum + b.errors, 0)).toBe(1);
    expect(trend.series.find((b: any) => b.requests)).toMatchObject({ requests: 1, errors: 1, p95_ms: 400 });
    for (const filter of ['&status=2xx', '&min_duration_ms=401', '&method=GET']) {
      const url = filter === '&method=GET' ? path.replace('method=POST', 'method=GET') : path + filter;
      expect((await get(url)).json.series.every((b: any) => b.requests === 0 && b.p95_ms === 0)).toBe(true);
    }
    expect((await get(path.replace('proj_api', 'other-project'))).json.series.every((b: any) => b.requests === 0)).toBe(true);
    expect((await get(`${path}&min_duration_ms=400&status=5xx`)).json.series.reduce((sum: number, b: any) => sum + b.requests, 0)).toBe(1);
    expect((await get('/v1/requests/trend')).status).toBe(400);
    expect((await get(path.replace('route_kind=name', 'route_kind=invalid'))).status).toBe(400);
    expect((await get(`${path}&status=invalid`)).status).toBe(400);
    expect((await get(`${path}&min_duration_ms=-1`)).status).toBe(400);
  });

  it('groups Requests by method and route with matching status totals and drilldown', async () => {
    const { status, json } = await get('/v1/projects/proj_api/requests?range=1h');
    expect(status).toBe(200);
    const checkout = json.data.find((r: any) => r.route === 'checkout');
    expect(checkout).toMatchObject({ method: 'POST', requests: 1, avg_ms: 400, p95_ms: 400, status_5xx: 1, status_other: 0 });
    for (const r of json.data) expect(r.status_2xx + r.status_3xx + r.status_4xx + r.status_5xx + r.status_other).toBe(r.requests);
    const detail = await get('/v1/projects/proj_api/traces?source=request&route=checkout&method=POST&range=1h');
    expect(detail.json.data.map((r: any) => r.trace_id)).toEqual([T1]);
    expect((await get('/v1/projects/proj_api/requests?offset=-1')).status).toBe(400);
    expect((await get('/v1/projects/proj_api/requests?q=absent')).json.data).toEqual([]);
  });

  it('allows admin reads but forbids mutations with read-only credentials', async () => {
    expect((await get('/v1/projects', ADMIN_KEY)).status).toBe(200);
    expect((await get('/v1/permissions')).json).toEqual({ can_manage: false });
    expect((await get('/v1/projects/proj_api/permissions', ADMIN_KEY)).json).toEqual({ can_manage: true });
    for (const [method, path] of [['PUT', '/v1/projects/proj_api/settings'], ['POST', '/v1/dead-letters/replay'], ['POST', '/v1/projects/proj_api/dead-letters/replay']]) {
      const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { method, headers: { authorization: `Bearer ${READ_KEY}`, 'content-type': 'application/json' }, body: '{}' }), env as unknown as Env);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('requires a read key', async () => {
    expect((await get('/v1/projects/proj_api/traces', 'nope')).status).toBe(401);
    expect((await get('/v1/traces', 'ew_live_ingest_only')).status).toBe(401);
  });

  it('lists traces newest first with filters and keyset pagination', async () => {
    const all = await get('/v1/projects/proj_api/traces');
    expect(all.json.data.map((t: any) => t.trace_id)).toEqual([T2, T1]);
    expect(all.json.data[1]).toMatchObject({ name: 'POST /checkout', status_code: 500, query_count: 2, exception_count: 1 });
    expect(all.json.data[1]).not.toHaveProperty('r2_key');

    expect((await get('/v1/projects/proj_api/traces?status=5xx')).json.data).toHaveLength(1);
    expect((await get('/v1/projects/proj_api/traces?q=checkout')).json.data[0].trace_id).toBe(T1);
    expect((await get('/v1/projects/proj_api/traces?range=1h')).json.data.length).toBeLessThanOrEqual((await get('/v1/projects/proj_api/traces')).json.data.length);

    const page1 = await get('/v1/projects/proj_api/traces?limit=1');
    expect(page1.json.next_cursor).toBeTruthy();
    const page2 = await get(`/v1/projects/proj_api/traces?limit=1&cursor=${page1.json.next_cursor}`);
    expect(page2.json.data[0].trace_id).toBe(T1);
    expect(page2.json.next_cursor).toBeNull();
  });

  it('filters traces by exact user and server values within the project', async () => {
    const path = '/v1/projects/proj_api/traces';
    const matching = await get(`${path}?user=7&server=web-1&status=5xx`);
    expect(matching.json.data.map((t: any) => t.trace_id)).toEqual([T1]);
    for (const query of ['user=70', 'user=%25', 'server=web', 'server=WEB-1', 'server=all', 'user=all', 'server=%25', 'user=7&server=other']) {
      expect((await get(`${path}?${query}`)).json.data).toEqual([]);
    }
    expect((await get('/v1/projects/other-project/traces?user=7&server=web-1')).json.data).toEqual([]);
    const first = await get(`${path}?user=7&server=web-1&limit=1`);
    expect(first.json.next_cursor).toBeTruthy();
    const second = await get(`${path}?user=7&server=web-1&limit=1&cursor=${encodeURIComponent(first.json.next_cursor)}`);
    expect(second.json.data.map((t: any) => t.trace_id)).toEqual([T1]);
  });

  it('scopes user pivots across requests, jobs, exceptions and logs, including literal all', async () => {
    const pid = 'user-pivots';
    const emit = async (user: string, offset: number) => {
      const trace = `pivot-${user}`;
      const common = { ...base(trace, offset), user, environment: 'staging' };
      await processMessage({ project_id: pid, server: 'web-1', received_at: Date.now(), trace_id: trace, records: [
        { v: 1, t: 'request', ...common, method: 'GET', route_name: 'user.route', status_code: 500, duration: 100000 },
        { v: 3, t: 'exception', ...common, class: 'UserFailure', file: 'shared.php', line: 1, code: '0', handled: false, message: 'failed', trace: JSON.stringify([{ file: `${user}.php`, source: user }]) },
        { v: 1, t: 'log', ...common, level: 'warning', message: `user ${user}` },
        { v: 1, t: 'job-attempt', ...common, trace_id: `${trace}-job`, execution_source: 'job', job_id: `${trace}-job`, attempt_id: `${trace}-job`, attempt: 1, name: 'SharedJob', connection: 'sync', queue: 'default', status: 'processed', duration: 1000 },
      ] as unknown as IngestMessage['records'] }, env as never);
    };
    await emit('all', 1);
    await emit('other', 2);
    const path = `/v1/projects/${pid}`;
    for (const scope of ['user=all', 'user=all&environment=staging']) {
      expect((await get(`${path}/requests?${scope}`)).json.data[0].requests).toBe(1);
      expect((await get(`${path}/requests/trend?route=user.route&${scope}`)).json.series.reduce((sum: number, row: any) => sum + row.requests, 0)).toBe(1);
      const jobs = (await get(`${path}/jobs?${scope}`)).json;
      expect(jobs.summary.attempts).toBe(1);
      expect((await get(`${path}/jobs/SharedJob?${scope}`)).json.data.map((row: any) => row.user)).toEqual(['all']);
      const exceptions = (await get(`${path}/exceptions?${scope}`)).json.data;
      expect(exceptions[0]).toMatchObject({ count: 1, users: 1, last_trace_id: 'pivot-all' });
      expect(exceptions[0].trend.reduce((sum: number, count: number) => sum + count, 0)).toBe(1);
      const detail = (await get(`${path}/exceptions/${exceptions[0].group}?${scope}`)).json;
      expect(detail.stack).toEqual([{ file: 'all.php', source: 'all' }]);
      expect(detail.occurrences.map((row: any) => row.user)).toEqual(['all']);
      const logs = (await get(`${path}/log-entries?${scope}`)).json.data;
      expect(logs.map((row: any) => row.user)).toEqual(['all']);
      expect((await get(`${path}/log-entries/${logs[0].id}?${scope}`)).status).toBe(200);
      expect((await get(`${path}/log-entries/${logs[0].id}?user=other`)).status).toBe(404);
    }
    for (const family of ['requests', 'jobs', 'exceptions', 'log-entries']) {
      expect((await get(`${path}/${family}?user=al`)).json.data).toEqual([]);
      expect((await get(`${path}/${family}?user=`)).json.data).toEqual([]);
      expect((await get(`${path}/${family}?user=all&environment=production`)).json.data).toEqual([]);
      expect((await get(`/v1/projects/other/${family}?user=all`)).json.data).toEqual([]);
    }
  });

  it('returns a trace with raw R2 records and a derived waterfall', async () => {
    const { status, json } = await get(`/v1/projects/proj_api/traces/${T1}`);
    expect(status).toBe(200);
    expect(json.records).toHaveLength(5);
    expect(json.capture).toEqual({ records_available: true, dropped_records: 0 });
    expect(json.spans.map((s: any) => s.type)).toEqual(['request', 'query', 'query', 'outgoing-request', 'exception']);
    expect(json.spans[2]).toMatchObject({ label: 'select * from orders where id = ?', duration_ms: 250 });
    expect((await get('/v1/projects/proj_api/traces/missing')).status).toBe(404);
  });

  it('keeps event links stable when stored records are reordered or removed', async () => {
    const path = `/v1/projects/proj_api/traces/${T1}`;
    const before = (await get(path)).json;
    const row = await env.DB.prepare('SELECT r2_key FROM traces WHERE project_id = ? AND trace_id = ?').bind('proj_api', T1).first<{ r2_key: string }>();
    const stored = await (await env.TRACES.get(row!.r2_key))!.json<{ records: unknown[] }>();
    await env.TRACES.put(row!.r2_key, JSON.stringify({ ...stored, records: [...stored.records].reverse() }));
    expect((await get(path)).json.spans).toEqual(before.spans);
    const removed = stored.records[0];
    await env.TRACES.put(row!.r2_key, JSON.stringify({ ...stored, records: stored.records.filter((record) => record !== removed) }));
    const remaining = (await get(path)).json.spans;
    expect(remaining).toHaveLength(before.spans.length - 1);
    for (const span of remaining) expect(before.spans.find((previous: any) => previous.id === span.id)).toEqual(span);
  });

  it('reports capped and unavailable trace records instead of implying complete capture', async () => {
    const path = `/v1/projects/proj_api/traces/${T1}`;
    const row = await env.DB.prepare('SELECT r2_key FROM traces WHERE project_id = ? AND trace_id = ?').bind('proj_api', T1).first<{ r2_key: string }>();
    const stored = await (await env.TRACES.get(row!.r2_key))!.json<{ records: unknown[] }>();
    await env.TRACES.put(row!.r2_key, JSON.stringify({ ...stored, dropped_records: 12 }));
    expect((await get(path)).json.capture).toEqual({ records_available: true, dropped_records: 12 });
    await env.TRACES.delete(row!.r2_key);
    const unavailable = await get(path);
    expect(unavailable.status).toBe(200);
    expect(unavailable.json.capture).toEqual({ records_available: false, dropped_records: 0 });
    expect(unavailable.json.records).toEqual([]);
    expect(unavailable.json.spans).toEqual([]);
    expect(unavailable.json.trace.trace_id).toBe(T1);
  });

  it('filters and sorts complete query and exception populations before pagination', async () => {
    const pid = 'list-filters';
    const timestamp = Date.now() - 1000;
    await env.DB.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind(pid, pid).run();
    const query = (hash: string, sql: string, duration: number) => env.DB.prepare('INSERT INTO queries (project_id, trace_id, sql_hash, sql, connection, duration_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(pid, 'trace', hash, sql, 'sqlite', duration, timestamp);
    const exception = (group: string, handled: number) => env.DB.prepare('INSERT INTO exceptions (project_id, trace_id, group_hash, class, message, file, line, handled, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(pid, 'trace', group, 'AppFailure', group === 'zz-target' ? '%_!needle' : 'normal', 'app.php', 1, handled, timestamp);
    await env.DB.batch([
      ...Array.from({ length: 201 }, (_, i) => query(`q${String(i).padStart(3, '0')}`, 'select normal', 1)),
      query('zz-target', 'select %_!needle', .1), query('zz-target', 'select %_!needle', .2),
      ...Array.from({ length: 101 }, (_, i) => exception(`e${String(i).padStart(3, '0')}`, 1)), exception('zz-target', 0),
    ]);
    const path = `/v1/projects/${pid}`;
    const trendReads: { keys: string[]; parameters: number }[] = [];
    const observed = async (suffix: string) => {
      trendReads.length = 0;
      const db = { prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        return { bind(...values: (string | number | null)[]) {
          const bound = statement.bind(...values);
          return { first: bound.first.bind(bound), async all() {
            const result = await bound.all<{ k: string }>();
            if (sql.includes(' AS k,')) trendReads.push({ keys: result.results.map((row) => row.k), parameters: values.length });
            return result;
          } };
        } };
      } };
      const response = await app.fetch(new Request(`https://test${path}${suffix}`, { headers: { authorization: `Bearer ${READ_KEY}` } }), { ...(env as unknown as Env), DB: db as unknown as Env['DB'] });
      expect(response.status).toBe(200);
      return await response.json() as any;
    };
    const queries = await observed('/queries');
    expect(trendReads.flatMap((read) => read.keys).sort()).toEqual(queries.data.map((row: any) => row.sql_hash).sort());
    expect(trendReads.every((read) => read.parameters <= 100)).toBe(true);
    expect(queries.data.every((row: any) => row.trend.reduce((sum: number, count: number) => sum + count, 0) === row.calls)).toBe(true);
    await observed('/queries/zz-target');
    expect(trendReads.flatMap((read) => read.keys)).toEqual(['zz-target']);
    await observed('/queries?q=not-present');
    expect(trendReads).toEqual([]);
    const visibleExceptions = await observed('/exceptions');
    expect(trendReads.flatMap((read) => read.keys).sort()).toEqual(visibleExceptions.data.map((row: any) => row.group).sort());
    expect(trendReads.every((read) => read.parameters <= 100)).toBe(true);
    await observed('/exceptions/zz-target');
    expect(trendReads.flatMap((read) => read.keys)).toEqual(['zz-target']);
    await observed('/exceptions?q=not-present');
    expect(trendReads).toEqual([]);
    expect(queries.data).toHaveLength(200);
    expect(queries.next_offset).toBe(200);
    const nextQueries = (await get(`${path}/queries?offset=200`)).json;
    expect(nextQueries.data).toHaveLength(2);
    expect(nextQueries.next_offset).toBeNull();
    expect(new Set([...queries.data, ...nextQueries.data].map((row: any) => row.sql_hash)).size).toBe(202);
    expect((await get(`${path}/queries?sort=calls`)).json.data[0]).toMatchObject({ sql_hash: 'zz-target', calls: 2, p95_ms: .2 });
    for (const q of ['NEEDLE', '%', '_', '!']) {
      expect((await get(`${path}/queries?q=${encodeURIComponent(q)}`)).json.data.map((row: any) => row.sql_hash)).toEqual(['zz-target']);
      expect((await get(`${path}/exceptions?q=${encodeURIComponent(q)}`)).json.data.map((row: any) => row.group)).toEqual(['zz-target']);
    }
    const exceptions = (await get(`${path}/exceptions`)).json;
    expect(exceptions.data).toHaveLength(100);
    expect(exceptions.next_offset).toBe(100);
    const nextExceptions = (await get(`${path}/exceptions?offset=100`)).json;
    expect(nextExceptions.data).toHaveLength(2);
    expect(nextExceptions.next_offset).toBeNull();
    expect(new Set([...exceptions.data, ...nextExceptions.data].map((row: any) => row.group)).size).toBe(102);
    expect((await get(`${path}/exceptions?handled=unhandled`)).json.data.map((row: any) => row.group)).toEqual(['zz-target']);
    expect((await get(`${path}/exceptions?handled=handled`)).json.data.every((row: any) => row.handled)).toBe(true);
    for (const suffix of ['queries?sort=sql', 'queries?offset=-1', 'exceptions?handled=invalid', 'exceptions?offset=1.5']) expect((await get(`${path}/${suffix}`)).status).toBe(400);
  });

  it('keeps mixed exception groups visible as unhandled and counts only the selected scope', async () => {
    const pid = 'mixed-handling';
    const stamp = Date.now() - 2000;
    await env.DB.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').bind(pid, pid).run();
    const insert = env.DB.prepare('INSERT INTO exceptions (project_id, trace_id, group_hash, class, message, file, line, handled, timestamp, user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    await env.DB.batch([
      insert.bind(pid, 'caught', 'mixed', 'Failure', 'caught', 'app.php', 1, 1, stamp, 'caught-user'),
      insert.bind(pid, 'uncaught', 'mixed', 'Failure', 'uncaught', 'app.php', 1, 0, stamp + 1000, 'uncaught-user'),
    ]);
    const path = `/v1/projects/${pid}/exceptions`;
    const expected = { handled: false, count: 2, handled_count: 1, unhandled_count: 1 };
    expect((await get(path)).json.data[0]).toMatchObject(expected);
    expect((await get(`${path}?handled=unhandled`)).json.data[0]).toMatchObject(expected);
    expect((await get(`${path}?handled=handled`)).json.data).toEqual([]);
    expect((await get(`${path}/mixed`)).json).toMatchObject(expected);
    expect((await get(`${path}?user=caught-user&handled=handled`)).json.data[0]).toMatchObject({ handled: true, count: 1, handled_count: 1, unhandled_count: 0 });
    expect((await get(`${path}/mixed?range=custom:${stamp}:${stamp + 1}`)).json).toMatchObject({ handled: true, count: 1, handled_count: 1, unhandled_count: 0 });
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

  it('aggregates every overview bucket and keeps empty projects at zero', async () => {
    await env.DB.prepare("INSERT INTO projects (id, name) VALUES ('overview-window', 'Overview')").run();
    await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 48)
      INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, duration_ms, status_code, r2_key)
      SELECT 'overview-window', 'sample-' || n, ? + ((n - 1) % 24) * 150000 + 75000, '2026-01-01', 'request', 'route-' || ((n - 1) % 24), n,
        CASE WHEN n % 2 = 0 THEN 500 ELSE 200 END, 'unused' FROM numbers`).bind(Date.now() - 3600000).run();
    for (const [id, timestamp] of [['past', Date.now() - 7200000], ['future', Date.now() + 3600000]] as const) {
      await env.DB.prepare(`INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, duration_ms, status_code, r2_key)
        VALUES ('overview-window', ?, ?, '2026-01-01', 'request', 'outside-window', 100000, 500, 'unused')`).bind(id, timestamp).run();
    }
    const overview = (await get('/v1/projects/overview-window/overview?range=1h')).json;
    expect(overview).toMatchObject({ requests: 48, error_rate: 0.5, p95_ms: 46, exceptions: 0, slow_queries: 0 });
    expect(overview.series.map((b: any) => b.requests)).toEqual(Array(24).fill(2));
    expect(overview.series.map((b: any) => b.p95_ms)).toEqual(Array.from({ length: 24 }, (_, i) => i + 25));
    expect(overview.series.reduce((sum: number, b: any) => sum + b.errors, 0)).toBe(24);
    expect(overview.top_routes).toHaveLength(20);
    const empty = (await get('/v1/projects/no-overview/overview?range=1h')).json;
    expect(empty).toMatchObject({ requests: 0, error_rate: 0, p95_ms: 0, top_routes: [] });
    expect(empty.series).toHaveLength(24);
    expect(empty.series.every((b: any) => b.requests === 0 && b.errors === 0 && b.p95_ms === 0)).toBe(true);
  });

  it('summarizes the overview', async () => {
    const { json } = await get('/v1/projects/proj_api/overview?range=1h');
    expect(json).toMatchObject({ range: '1h', requests: 2, error_rate: 0.5, exceptions: 1, slow_queries: 1, p95_ms: 400 });
    expect(json.series).toHaveLength(24);
    expect(json.top_routes.map((r: any) => r.route).sort()).toEqual(['GET /', 'POST /checkout']);
  });
});

describe('project filter (single-tenant)', () => {
  const OTHER = 'proj_other';
  const SHARED_TRACE = T1; // the same trace id in two projects must not collide

  beforeAll(async () => {
    await processMessage({
      project_id: OTHER, server: 'api-1', received_at: Date.now(), trace_id: null,
      records: [
        { v: 1, t: 'query', ...base(SHARED_TRACE, 0.01), server: 'api-1', sql: "select * from invoices where token = 'x'", file: 'app/I.php', line: 9, duration: 7000, connection: 'pgsql' },
        { v: 3, t: 'exception', ...base(SHARED_TRACE, 0.2), server: 'api-1', class: 'App\\InvoiceLocked', file: 'app/I.php', line: 12, message: 'Locked', code: '0', trace: '[]', handled: true },
        { v: 1, t: 'request', ...base(SHARED_TRACE), server: 'api-1', method: 'GET', url: 'https://billing.test/invoices', route_name: 'invoices', route_path: '/invoices', status_code: 200, duration: 30_000 },
      ] as IngestMessage['records'],
    }, env as never);
  });

  it('lists every project for the selector', async () => {
    expect((await get('/v1/projects')).json.data.map((p: any) => p.id)).toEqual(['proj_api', OTHER]);
  });

  it('one read key reads every project; the path segment filters', async () => {
    expect((await get(`/v1/projects/${OTHER}/traces`)).json.data.map((t: any) => t.name)).toEqual(['GET /invoices']);
    expect((await get('/v1/projects/proj_api/traces')).json.data).toHaveLength(2);
    expect((await get(`/v1/projects/${OTHER}/exceptions`)).json.data.map((e: any) => e.class)).toEqual(['App\\InvoiceLocked']);
    expect((await get(`/v1/projects/${OTHER}/queries`)).json.data.map((q: any) => q.connection)).toEqual(['pgsql']);
    expect((await get('/v1/projects/proj_api/queries')).json.data.every((q: any) => q.connection === 'mysql')).toBe(true);
    expect((await get(`/v1/projects/${OTHER}/overview?range=1h`)).json).toMatchObject({ requests: 1, exceptions: 1 });
  });

  it('?project_id= is optional on /v1 routes: without it every project is returned', async () => {
    expect((await get('/v1/traces')).json.data).toHaveLength(3);
    expect((await get(`/v1/traces?project_id=${OTHER}`)).json.data).toHaveLength(1);
    expect((await get('/v1/exceptions')).json.data.map((e: any) => e.class).sort()).toEqual(['App\\InvoiceLocked', 'App\\PaymentDeclined']);
    expect((await get('/v1/queries?project_id=proj_api')).json.data.every((q: any) => q.connection === 'mysql')).toBe(true);
    expect((await get('/v1/overview?range=1h')).json).toMatchObject({ requests: 3, exceptions: 2 });
  });

  it('keeps the same trace id apart per project', async () => {
    expect((await get(`/v1/projects/proj_api/traces/${SHARED_TRACE}`)).json.trace.name).toBe('POST /checkout');
    const theirs = await get(`/v1/projects/${OTHER}/traces/${SHARED_TRACE}`);
    expect(theirs.json.trace.name).toBe('GET /invoices');
    expect(theirs.json.records.every((r: any) => r.server === 'api-1')).toBe(true);
    expect((await get(`/v1/projects/nope/traces/${SHARED_TRACE}`)).status).toBe(404);
  });
});

describe('errors, key validation and response hygiene', () => {
  it('uses the shared JSON error body with a request id for 401/404', async () => {
    const unauth = await get('/v1/projects/proj_api/traces', null, { 'x-request-id': 'dash-1' });
    expect(unauth.status).toBe(401);
    expect(unauth.json).toEqual({ error: { code: 'unauthenticated', message: 'Unauthenticated.' }, message: 'Unauthenticated.', request_id: 'dash-1' });
    expect(unauth.headers.get('x-request-id')).toBe('dash-1');


    const missing = await get('/v1/projects/proj_api/traces/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('not_found');
    expect((await get('/nope')).json.error.code).toBe('not_found');
  });

  it('rejects malformed, unknown, ingest-scope and disabled keys on every route', async () => {
    await env.API_KEYS.put(await apiKeyKvKey('ew_read_disabled'), JSON.stringify({ project_id: 'proj_api', name: 'off', scopes: ['read'], disabled: true }));
    const routes = ['/v1/projects', '/v1/projects/proj_api/overview', '/v1/projects/proj_api/traces', '/v1/projects/proj_api/exceptions', '/v1/projects/proj_api/queries'];
    for (const route of routes) {
      for (const key of ['nope', 'ew_live_ingest_only', 'ew_read_disabled']) expect((await get(route, key)).status, `${route} ${key}`).toBe(401);
      const basic = await app.fetch(new Request(`https://api.edgewatch.test${route}`, { headers: { authorization: `Basic ${READ_KEY}` } }), env as unknown as Env);
      expect(basic.status).toBe(401);
    }
  });

  it('handles inherited range names, malformed project paths and malformed cursors safely', async () => {
    for (const range of ['__proto__', 'constructor', 'toString']) {
      const result = await get(`/v1/projects/proj_api/overview?range=${range}`);
      expect(result.status).toBe(200);
      expect(result.json.range).toBe('24h');
    }
    expect((await get('/v1/projects/%/overview')).status).toBe(400);
    for (const raw of ['|id', 'NaN|id', '-1|id', '1.5|id', '9007199254740992|id', '123|id|extra']) {
      expect((await get(`/v1/projects/proj_api/traces?cursor=${encodeURIComponent(btoa(raw))}`)).status).toBe(400);
    }
  });

  it('validates paging input instead of failing', async () => {
    expect((await get('/v1/projects/proj_api/traces?cursor=%%%')).status).toBe(400);
    expect((await get('/v1/projects/proj_api/traces?cursor=bm90LWEtY3Vyc29y')).json.error.code).toBe('invalid_request');
    const bad = await get('/v1/projects/proj_api/traces?limit=abc');
    expect(bad.status).toBe(200);
    expect(bad.json.data.length).toBeGreaterThan(0);
    const one = await get('/v1/projects/proj_api/traces?limit=1');
    expect(one.json.data).toHaveLength(1);
    expect(one.json.next_cursor).toEqual(expect.any(String));
    const next = await get(`/v1/projects/proj_api/traces?limit=1&cursor=${encodeURIComponent(one.json.next_cursor)}`);
    expect(next.json.data[0].trace_id).not.toBe(one.json.data[0].trace_id);
  });

  it('marks tenant data as private, no-store', async () => {
    expect((await get('/v1/projects/proj_api/overview')).headers.get('cache-control')).toBe('private, no-store');
  });

  it('streams the raw stored trace, filtered by project', async () => {
    const raw = await get(`/v1/projects/proj_api/traces/${T1}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.json).toMatchObject({ project_id: 'proj_api', trace_id: T1 });
    expect(raw.json.records.length).toBeGreaterThan(3);
    expect((await get(`/v1/projects/proj_none/traces/${T1}/raw`)).status).toBe(404);
  });
});

describe('Nightwatch record coverage in trace detail', () => {
  const T = '019aa7b1-35fb-7000-8000-0000000000e1';
  beforeAll(async () => {
    const b = (offset: number) => ({ ...base(T, offset), user: '99' });
    await processMessage({
      project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null,
      records: [
        ...Array.from({ length: 6 }, (_, i) => ({ v: 1, t: 'query', ...b(0.01 * (i + 1)), sql: `select * from posts where user_id = ${i}`, file: 'app/P.php', line: 7, duration: 1000, connection: 'mysql' })),
        { v: 1, t: 'queued-job', ...b(0.1), job_id: 'j1', name: 'App\\Jobs\\Notify', connection: 'redis', queue: 'default', duration: 300 },
        { v: 1, t: 'log', ...b(0.12), level: 'warning', message: 'slow upstream', context: '{}', extra: '{}' },
        { v: 1, t: 'notification', ...b(0.15), channel: 'mail', class: 'App\\Notifications\\Welcome', duration: 900, failed: false },
        { v: 1, t: 'request', ...b(0), method: 'GET', url: 'https://shop.test/feed', route_path: '/feed', status_code: 200, duration: 200_000, lazy_loads: 6, peak_memory_usage: 2_097_152 },
        { v: 1, t: 'user', timestamp: now, id: '99', name: 'Ada', username: 'ada' },
      ] as IngestMessage['records'],
    }, env as never);
  });

  it('flags repeated statements (possible N+1) and returns the user profile', async () => {
    const { json } = await get(`/v1/projects/proj_api/traces/${T}`);
    expect(json.repeated_queries).toEqual([{ sql_hash: expect.any(String), sql: 'select * from posts where user_id = ?', count: 6, total_ms: 6 }]);
    expect(json.trace).toMatchObject({ lazy_loads: 6, peak_memory_usage: 2_097_152 });
    expect(json.user).toEqual({ id: '99', name: 'Ada', username: 'ada' });
    expect((await get(`/v1/projects/proj_api/traces/${T1}`)).json.repeated_queries).toEqual([]);
  });

  it('renders queued jobs, logs and notifications in the waterfall', async () => {
    const { json } = await get(`/v1/projects/proj_api/traces/${T}`);
    const types = json.spans.map((s: any) => s.type);
    expect(types).toContain('queued-job');
    expect(types).toContain('log');
    expect(json.spans.find((s: any) => s.type === 'log').label).toBe('[warning] slow upstream');
    expect(json.spans.find((s: any) => s.type === 'mail').meta).toMatchObject({ channel: 'mail', failed: 0 });
  });
});

describe('jobs endpoints', () => {
  beforeAll(async () => {
    const job = (trace: string, offset: number, extra: Record<string, unknown>) => ({ v: 1, ...base(trace, offset), connection: 'redis', queue: 'mail', ...extra });
    const J1 = '019aa7b1-35fb-7000-8000-0000000000b1';
    const J2 = '019aa7b1-35fb-7000-8000-0000000000b2';
    await processMessage({ project_id: 'proj_api', server: 'worker-1', received_at: Date.now(), trace_id: null, records: [
      job(T2, 0.5, { t: 'queued-job', job_id: 'j1', name: 'App\\Jobs\\SendInvoice', duration: 400 }),
      job(J1, 1, { t: 'job-attempt', job_id: 'j1', attempt: 1, name: 'App\\Jobs\\SendInvoice', status: 'released', duration: 20_000 }),
      job(J2, 2, { t: 'job-attempt', job_id: 'j1', attempt: 2, name: 'App\\Jobs\\SendInvoice', status: 'failed', duration: 40_000 }),
      job(J2, 3, { t: 'job-attempt', job_id: 'j2', attempt: 1, name: 'App\\Jobs\\Resize', queue: 'images', status: 'processed', duration: 10_000 }),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups jobs by class with attempts, failures and durations', async () => {
    const { json } = await get('/v1/projects/proj_api/jobs?range=1h');
    expect(json.summary).toEqual({ queued: 1, attempts: 3, failed: 1, released: 1 });
    expect(json.data[0]).toMatchObject({ key: 'App\\Jobs\\SendInvoice', queue: 'mail', queued: 1, attempts: 2, failed: 1, released: 1, processed: 0, avg_ms: 30, max_ms: 40 });
    expect((await get('/v1/jobs?queue=images')).json.data.map((j: any) => j.key)).toEqual(['App\\Jobs\\Resize']);
    expect((await get('/v1/jobs?status=failed')).json.data).toHaveLength(1);
    expect((await get('/v1/projects/proj_other/jobs')).json.data).toEqual([]);
  });

  it('lists recent attempts of one job with their traces', async () => {
    const { status, json } = await get(`/v1/projects/proj_api/jobs/${encodeURIComponent('App\\Jobs\\SendInvoice')}`);
    expect(status).toBe(200);
    expect(json.data.map((r: any) => r.status)).toEqual(['failed', 'released', null]);
    expect(json.data[2]).toMatchObject({ kind: 'queued', trace_name: 'GET /' });
    expect((await get('/v1/jobs/Nope')).status).toBe(404);
  });
});

describe('commands endpoints', () => {
  beforeAll(async () => {
    const cmd = (trace: string, offset: number, name: string, exit_code: number, duration: number) => ({ v: 1, t: 'command', ...base(trace, offset), execution_source: 'command', name, command: name, exit_code, duration });
    await processMessage({ project_id: 'proj_api', server: 'worker-1', received_at: Date.now(), trace_id: null, records: [
      cmd('019aa7b1-35fb-7000-8000-0000000000d1', 1, 'reports:build', 0, 3_000_000),
      cmd('019aa7b1-35fb-7000-8000-0000000000d2', 2, 'reports:build', 1, 5_000_000),
      cmd('019aa7b1-35fb-7000-8000-0000000000d3', 3, 'cache:prune', 0, 1_000_000),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('preserves literal percent escapes in group names and scopes detail rows', async () => {
    const name = 'reports:100%2Fcomplete';
    const records = [now - 7200, now - 30].map((timestamp) => ({ v: 1, t: 'command', ...base(crypto.randomUUID()), timestamp, execution_source: 'command', name, command: name, exit_code: 0, duration: 1000 }));
    await processMessage({ project_id: 'proj_api', server: 'worker-1', received_at: Date.now(), trace_id: null, records: records as unknown as IngestMessage['records'] }, env as never);
    const path = `/v1/projects/proj_api/commands/${encodeURIComponent(name)}`;
    const recent = await get(`${path}?range=1h`);
    expect(recent.status).toBe(200);
    expect(recent.json.data).toHaveLength(1);
    expect(recent.json.data[0].name).toBe(name);
    expect((await get(`${path}?range=24h`)).json.data).toHaveLength(2);
  });

  it('groups commands by name with runs, failures and durations', async () => {
    const { json } = await get('/v1/projects/proj_api/commands?range=1h');
    expect(json.summary).toMatchObject({ runs: 3, failed: 1 });
    expect(json.data[0]).toMatchObject({ key: 'reports:build', count: 2, failed: 1, avg_ms: 4000, max_ms: 5000 });
    expect((await get('/v1/commands?status=failed')).json.data.map((c: any) => c.key)).toEqual(['reports:build']);
    expect((await get('/v1/commands?q=prune')).json.data.map((c: any) => c.key)).toEqual(['cache:prune']);
    expect((await get('/v1/projects/proj_other/commands')).json.data).toEqual([]);
  });

  it('lists recent runs of one command with exit codes', async () => {
    const { json } = await get('/v1/commands/reports%3Abuild');
    expect(json.data.map((r: any) => r.exit_code)).toEqual([1, 0]);
    expect(json.data[0].trace_name).toBe('php artisan reports:build');
  });
});

describe('cache endpoints', () => {
  beforeAll(async () => {
    const ev = (offset: number, key: string, type: string, duration = 200) => ({ v: 1, t: 'cache-event', ...base(T1, offset), store: 'redis', key, type, duration, ttl: 0 });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [
      ev(1, 'settings', 'hit'), ev(2, 'settings', 'hit'), ev(3, 'settings', 'hit'), ev(4, 'settings', 'miss', 400), ev(5, 'settings', 'write', 600),
      ev(6, 'cart:1', 'delete'), ev(7, 'cart:1', 'write-failure'),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups cache operations by key with counts and hit ratio', async () => {
    const { json } = await get('/v1/projects/proj_api/cache?range=1h');
    expect(json.summary).toEqual({ hits: 3, misses: 1, writes: 1, deletes: 1, failures: 1, hit_ratio: 0.75 });
    expect(json.data[0]).toMatchObject({ key: 'settings', store: 'redis', count: 5, hits: 3, misses: 1, writes: 1, hit_ratio: 0.75 });
    expect(json.data.find((g: any) => g.key === 'cart:1')).toMatchObject({ deletes: 1, failures: 1, hit_ratio: null });
    expect((await get('/v1/cache?type=miss')).json.data.map((g: any) => g.key)).toEqual(['settings']);
    expect((await get('/v1/projects/proj_other/cache')).json.summary.hit_ratio).toBe(0);
  });

  it('lists recent operations on one key', async () => {
    const { json } = await get('/v1/cache/settings');
    expect(json.data.map((r: any) => r.type)).toEqual(['write', 'miss', 'hit', 'hit', 'hit']);
  });
});

describe('outgoing requests endpoints', () => {
  beforeAll(async () => {
    const out = (offset: number, host: string, method: string, status_code: number | null, duration: number) => ({ v: 1, t: 'outgoing-request', ...base(T1, offset), host, method, url: `https://${host}/v1/x`, status_code, duration });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [
      out(1, 'payments.test', 'POST', 200, 300_000), out(2, 'payments.test', 'POST', 402, 500_000), out(3, 'payments.test', 'GET', 503, 100_000),
      out(4, 'hooks.slack.com', 'POST', null, 2_000_000),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups calls by host with failures and durations', async () => {
    const { json } = await get('/v1/projects/proj_api/outgoing-requests?range=1h');
    expect(json.summary.requests).toBeGreaterThanOrEqual(4);
    expect((await get('/v1/outgoing-requests?q=payments.test')).json.summary).toMatchObject({ requests: 3, failed: 2 });
    const stripe = json.data.find((g: any) => g.key === 'payments.test');
    expect(stripe).toMatchObject({ count: 3, failed: 2, server_errors: 1, avg_ms: 300, max_ms: 500 });
    expect(stripe.methods.split(',').sort()).toEqual(['GET', 'POST']);
    expect((await get('/v1/outgoing-requests?status=error')).json.data.map((g: any) => g.key)).toEqual(['hooks.slack.com']);
    expect((await get('/v1/outgoing-requests?method=GET&status=5xx')).json.data.map((g: any) => g.key)).toEqual(['payments.test']);
  });

  it('lists recent calls to one host', async () => {
    const { json } = await get('/v1/outgoing-requests/payments.test');
    expect(json.data.map((r: any) => r.status_code)).toEqual([503, 402, 200]);
  });
});

describe('mail and notifications endpoints', () => {
  beforeAll(async () => {
    const mail = (offset: number, cls: string, failed: boolean, to: number) => ({ v: 1, t: 'mail', ...base(T1, offset), mailer: 'ses', class: cls, subject: 'Hi', to, cc: 0, bcc: 1, attachments: 0, duration: 20_000, failed });
    const note = (offset: number, channel: string, failed: boolean) => ({ v: 1, t: 'notification', ...base(T1, offset), channel, class: 'App\\Notifications\\Ping', duration: 10_000, failed });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [
      mail(1, 'App\\Mail\\Receipt', false, 2), mail(2, 'App\\Mail\\Receipt', true, 1), mail(3, 'App\\Mail\\Digest', false, 1),
      note(4, 'mail', false), note(5, 'slack', true),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups mail by mailable with recipients and failures', async () => {
    const { json } = await get('/v1/projects/proj_api/mail?range=1h');
    expect(json.summary).toMatchObject({ sent: 3, failed: 1 });
    expect(json.data.find((g: any) => g.key === 'App\\Mail\\Receipt')).toMatchObject({ count: 2, failed: 1, recipients: 5, mailers: 'ses', avg_ms: 20 });
    expect((await get('/v1/mail?status=failed')).json.data.map((g: any) => g.key)).toEqual(['App\\Mail\\Receipt']);
    expect((await get(`/v1/mail/${encodeURIComponent('App\\Mail\\Digest')}`)).json.data).toHaveLength(1);
  });

  it('groups notifications by class with channels and a channel filter', async () => {
    const { json } = await get('/v1/notifications?range=1h');
    expect(json.summary).toMatchObject({ sent: 2, failed: 1 });
    expect(json.data[0].channels.split(',').sort()).toEqual(['mail', 'slack']);
    expect((await get('/v1/notifications?channel=slack')).json.summary).toMatchObject({ sent: 1, failed: 1 });
  });
});

describe('scheduled tasks endpoints', () => {
  beforeAll(async () => {
    const run = (offset: number, name: string, status: string, duration: number) => ({ v: 1, t: 'scheduled-task', ...base(T1, offset), name, cron: '0 * * * *', timezone: 'UTC', status, duration });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [
      run(1, 'reports:hourly', 'processed', 100_000), run(2, 'reports:hourly', 'failed', 300_000), run(3, 'reports:hourly', 'skipped', 0),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups runs by task with processed, failed and skipped counts; skipped runs do not drag the average down', async () => {
    const { json } = await get('/v1/projects/proj_api/scheduled-tasks?range=1h');
    expect(json.data.find((g: any) => g.key === 'reports:hourly')).toMatchObject({ count: 3, cron: '0 * * * *', timezone: 'UTC', processed: 1, failed: 1, skipped: 1, avg_ms: 200, max_ms: 300 });
    expect((await get('/v1/scheduled-tasks?status=skipped')).json.summary).toMatchObject({ runs: 1, skipped: 1 });
    expect((await get('/v1/scheduled-tasks/reports:hourly')).json.data.map((r: any) => r.status)).toEqual(['skipped', 'failed', 'processed']);
  });
});

describe('web vitals endpoints', () => {
  beforeAll(async () => {
    const view = (offset: number, path: string, lcp: number, inp: number, cls: number) =>
      ({ v: 1, t: 'web-vital', ...base(`019aa7b1-35fb-7000-8000-0000000000v${offset}`, offset), execution_source: 'browser', path, lcp, inp, cls, fcp: 500, ttfb: 100 });
    await processMessage({ project_id: 'proj_api', server: 'browser', received_at: Date.now(), trace_id: null, records: [
      view(1, '/checkout', 2000, 100, 0.05), view(2, '/checkout', 4000, 300, 0.3), view(3, '/', 1000, 50, 0),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('groups page views by path with averages and the share of good values', async () => {
    const { json } = await get('/v1/projects/proj_api/web-vitals?range=1h');
    const checkout = json.data.find((g: { key: string }) => g.key === '/checkout');
    expect(checkout).toMatchObject({ count: 2, lcp_ms: 3000, inp_ms: 200, lcp_good: 0.5, inp_good: 0.5, cls_good: 0.5 });
    expect(json.summary).toMatchObject({ views: 3, lcp_good: 0.6667 });
    expect((await get('/v1/projects/proj_api/web-vitals/%2Fcheckout')).json.data).toHaveLength(2);
  });
});

describe('logs endpoints', () => {
  beforeAll(async () => {
    const log = (offset: number, level: string, message: string) => ({ v: 1, t: 'log', ...base(T1, offset), level, message, context: '{"k":1}' });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [
      log(1, 'info', 'Order placed'), log(2, 'info', 'Order placed'), log(3, 'error', 'Payment gateway down'), log(4, 'warning', 'Low stock'),
    ] as unknown as IngestMessage['records'] }, env as never);
  });

  it('provides a chronological log feed with level and text filters', async () => {
    const { status, json } = await get('/v1/projects/proj_api/log-entries?range=1h');
    expect(status).toBe(200);
    expect(json.data.map((r: any) => r.message)).toEqual(['Low stock', 'Payment gateway down', 'Order placed', 'Order placed']);
    expect(json.data[0]).toMatchObject({ trace_id: T1, context: '{"k":1}', level: 'warning' });
    expect((await get('/v1/projects/proj_api/log-entries?level=info&q=placed')).json.data).toHaveLength(2);
    expect((await get('/v1/projects/missing/log-entries')).json.data).toEqual([]);
    expect((await get('/v1/log-entries?cursor=bad')).status).toBe(400);
    const first = json.data[0];
    const cursor = btoa(`${Date.parse(first.timestamp)}|${first.id}`);
    expect((await get(`/v1/projects/proj_api/log-entries?cursor=${encodeURIComponent(cursor)}`)).json.data).toHaveLength(3);
  });

  it('resolves log links independently of feed filters while enforcing project, environment and time', async () => {
    const entry = (await get('/v1/projects/proj_api/log-entries')).json.data[0];
    const path = `/v1/projects/proj_api/log-entries/${entry.id}`;
    await env.DB.prepare('UPDATE traces SET environment = ? WHERE project_id = ? AND trace_id = ?').bind('staging', 'proj_api', T1).run();
    const detail = await get(`${path}?environment=staging&q=does-not-match&level=debug&cursor=ignored`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ ...entry, environment: 'staging', execution_available: 1 });
    expect((await get(`${path}?environment=production`)).status).toBe(404);
    expect((await get(`/v1/projects/other/log-entries/${entry.id}`)).status).toBe(404);
    const timestamp = Date.parse(entry.timestamp);
    expect((await get(`${path}?range=custom:${timestamp}:${timestamp + 1}`)).status).toBe(200);
    expect((await get(`${path}?range=custom:${timestamp + 1}:${timestamp + 2}`)).status).toBe(404);
    expect((await get(`${path}?range=custom:1:${timestamp - 1}`)).status).toBe(404);
    expect((await get(path, null)).status).toBe(401);
    for (const id of ['bad', '0', '-1', '1.5', '9007199254740992']) expect((await get(`/v1/log-entries/${id}`)).status).toBe(400);
  });

  it('keeps log context accessible when its execution is missing', async () => {
    const entry = (await get('/v1/projects/proj_api/log-entries')).json.data[0];
    await env.DB.prepare('UPDATE logs SET trace_id = ? WHERE id = ?').bind('not-retained', entry.id).run();
    const detail = await get(`/v1/projects/proj_api/log-entries/${entry.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ context: '{"k":1}', trace_id: 'not-retained', execution_available: 0, environment: null });
  });

  it('groups by level, most severe first, with error and warning totals', async () => {
    const { json } = await get('/v1/projects/proj_api/logs?range=1h');
    expect(json.data.map((g: any) => g.key)).toEqual(['error', 'warning', 'info']);
    expect(json.data[2]).toMatchObject({ count: 2, traces: 1 });
    expect(json.summary).toMatchObject({ logs: 4, errors: 1, warnings: 1 });
  });

  it('filters by level and searches messages; lists entries of one level', async () => {
    expect((await get('/v1/logs?level=error')).json.summary).toMatchObject({ logs: 1, errors: 1 });
    expect((await get('/v1/logs?q=stock')).json.data.map((g: any) => g.key)).toEqual(['warning']);
    const { json } = await get('/v1/logs/info');
    expect(json.data.map((r: any) => r.message)).toEqual(['Order placed', 'Order placed']);
    expect(json.data[0].context).toBe('{"k":1}');
  });
});

describe('users endpoints', () => {
  const U1 = '019aa7b1-35fb-7000-8000-0000000000u1';
  const U2 = '019aa7b1-35fb-7000-8000-0000000000u2';
  beforeAll(async () => {
    const req = (trace_id: string, status_code: number) => ({ v: 1, t: 'request', ...base(trace_id, 1), user: 'user-77', method: 'GET', url: 'https://shop.test/account', route_path: '/account', status_code, duration: 40_000, exceptions: status_code >= 500 ? 1 : 0 });
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: U1, records: [req(U1, 200)] as unknown as IngestMessage['records'] }, env as never);
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: U2, records: [req(U2, 503)] as unknown as IngestMessage['records'] }, env as never);
    await processMessage({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: null, records: [{ v: 1, t: 'user', timestamp: Date.now() / 1000, id: 'user-77', name: 'Ada Lovelace', username: 'ada' }] as unknown as IngestMessage['records'] }, env as never);
  });

  it('lists users with their name and trace counts', async () => {
    const { json } = await get('/v1/projects/proj_api/users?range=1h');
    expect(json.data.find((g: any) => g.key === 'user-77')).toMatchObject({ count: 2, name: 'Ada Lovelace', requests: 2, server_errors: 1, avg_ms: 40 });
    expect(json.summary.users).toBeGreaterThanOrEqual(1);
    expect(json.data.every((g: any) => g.key)).toBe(true);
  });

  it("lists one user's traces", async () => {
    const { json } = await get('/v1/users/user-77');
    expect(json.data.map((r: any) => r.trace_id).sort()).toEqual([U1, U2]);
    expect(json.data[0].trace_name).toBe('GET /account');
  });
});

describe('laravel/nightwatch job attempts', () => {
  it('links a job attempt trace and the request that dispatched it both ways', async () => {
    const R = '019aa7b1-35fb-7000-8000-0000000000r1';
    const A = '019aa7b1-35fb-7000-8000-0000000000r2';
    const b = { timestamp: now - 30, deploy: 'v1', server: 'web-1', _group: 'g', trace_id: R, user: '7' };
    const msg = (records: unknown[]): IngestMessage => ({ project_id: 'proj_api', server: 'web-1', received_at: Date.now(), trace_id: R, records: records as IngestMessage['records'] });
    await processMessage(msg([{ v: 1, t: 'request', ...b, execution_source: 'request', method: 'GET', url: 'https://shop.test/fresh', status_code: 200, duration: 5000 }]), env as never);
    await processMessage(msg([{ v: 1, t: 'job-attempt', ...b, timestamp: now - 29, execution_source: 'job', job_id: 'j', attempt_id: A, attempt: 1, name: 'App\\Jobs\\Fresh', connection: 'database', queue: 'default', status: 'processed', duration: 6000 }]), env as never);
    const req = await get(`/v1/projects/proj_api/traces/${R}`);
    expect(req.json.related).toEqual([expect.objectContaining({ trace_id: A, execution_source: 'job', name: 'App\\Jobs\\Fresh', status: 'processed', origin_trace_id: R })]);
    const attempt = await get(`/v1/projects/proj_api/traces/${A}`);
    expect(attempt.json.trace.origin_trace_id).toBe(R);
    expect(attempt.json.related).toEqual([expect.objectContaining({ trace_id: R, execution_source: 'request' })]);
  });
});

describe('storage failures', () => {
  const SECRET = 'internal-detail-91bc';
  const boom = async () => { throw new Error(SECRET); };
  const fetchWith = async (path: string, override: Partial<Env>) => {
    const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { headers: { authorization: `Bearer ${READ_KEY}` } }), { ...(env as unknown as Env), ...override });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), json: JSON.parse(text) as { error: { code: string } } };
  };

  it('answers 503 unavailable when the key lookup in KV fails', async () => {
    const res = await fetchWith('/v1/traces', { API_KEYS: { get: boom } as unknown as KVNamespace });
    expect(res).toMatchObject({ status: 503, retryAfter: '5', json: { error: { code: 'unavailable' } } });
  });

  it('answers 503 unavailable when R2 fails on trace detail and raw trace', async () => {
    const traces = { get: boom } as unknown as R2Bucket;
    expect(await fetchWith(`/v1/projects/proj_api/traces/${T1}`, { TRACES: traces })).toMatchObject({ status: 503, json: { error: { code: 'unavailable' } } });
    expect(await fetchWith(`/v1/projects/proj_api/traces/${T1}/raw`, { TRACES: traces })).toMatchObject({ status: 503, json: { error: { code: 'unavailable' } } });
  });

  it('answers 500 internal_error without the cause when a D1 query fails', async () => {
    const db = { prepare: () => { throw new Error(SECRET); } } as unknown as D1Database;
    expect(await fetchWith('/v1/traces', { DB: db })).toMatchObject({ status: 500, json: { error: { code: 'internal_error' } } });
  });
});

describe('pipeline and dead letters', () => {
  const post = async (path: string, body: unknown, key: string | null = ADMIN_KEY) => {
    const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }), env as unknown as Env);
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeAll(async () => {
    const t = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO dead_letters (id, project_id, trace_id, received_at, failed_at, record_count, r2_key) VALUES ('dl-1', 'proj_dl', 'tr-1', ?, ?, 3, 'dead/proj_dl/dl-1.json')").bind(t - 7_200_000, t - 3_600_000),
      env.DB.prepare("INSERT INTO dead_letters (id, project_id, trace_id, received_at, failed_at, record_count, r2_key) VALUES ('dl-2', 'proj_dl', NULL, ?, ?, 1, 'dead/proj_dl/dl-2.json')").bind(t - 7_200_000, t - 60_000),
      env.DB.prepare("INSERT INTO dead_letters (id, project_id, trace_id, received_at, failed_at, record_count, r2_key) VALUES ('dl-3', 'proj_other', NULL, ?, ?, 1, 'dead/proj_other/dl-3.json')").bind(t, t),
      env.DB.prepare('INSERT INTO pipeline_minutes (minute, batches, messages, retried, max_lag_ms) VALUES (?, 2, 40, 1, 1500)').bind(t - (t % 60_000)),
      env.DB.prepare('INSERT INTO pipeline_minutes (minute, batches, messages, retried, max_lag_ms) VALUES (?, 1, 10, 0, 9000)').bind(t - (t % 60_000) - 30 * 60_000),
    ]);
  });

  it('reports dead letters per project and consumer stats for the last hour', async () => {
    const { status, json } = await get('/v1/projects/proj_dl/pipeline');
    expect(status).toBe(200);
    expect(json.dead_letters).toMatchObject({ count: 2, replay_pending: 0, oldest_failed_at: expect.any(String) });
    expect(json.consumer).toMatchObject({ messages_1h: 50, retried_1h: 1, max_lag_ms_5m: 1500, max_lag_ms_1h: 9000, last_batch_at: expect.any(String) });
    expect(json.minutes).toHaveLength(2);
    expect((await get('/v1/pipeline')).json.dead_letters.count).toBe(3);
  });

  it('lists dead letters newest first without payloads', async () => {
    const { json } = await get('/v1/projects/proj_dl/dead-letters');
    expect(json.data.map((d: any) => d.id)).toEqual(['dl-2', 'dl-1']);
    expect(json.data[1]).toMatchObject({ trace_id: 'tr-1', record_count: 3, replay_requested_at: null });
    expect(json.data[1]).not.toHaveProperty('r2_key');
  });

  it('requests a replay for chosen ids or the whole project, once, and validates input', async () => {
    expect((await post('/v1/dead-letters/replay', {}, null)).status).toBe(401);
    expect(await post('/v1/projects/proj_dl/dead-letters/replay', { ids: 'dl-1' })).toMatchObject({ status: 422, json: { error: { code: 'unprocessable' } } });
    expect(await post('/v1/projects/proj_dl/dead-letters/replay', { ids: ['dl-1', 'dl-3'] })).toEqual({ status: 202, json: { requested: 1 } });
    expect(await post('/v1/projects/proj_dl/dead-letters/replay', {})).toEqual({ status: 202, json: { requested: 1 } });
    expect(await post('/v1/projects/proj_dl/dead-letters/replay', {})).toEqual({ status: 202, json: { requested: 0 } });
    expect((await get('/v1/projects/proj_dl/pipeline')).json.dead_letters.replay_pending).toBe(2);
    expect((await get('/v1/projects/proj_other/pipeline')).json.dead_letters.replay_pending).toBe(0);
  });
});

describe('usage and project settings', () => {
  const put = async (path: string, body: unknown) => {
    const res = await app.fetch(new Request(`https://api.edgewatch.test${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}` }, body: JSON.stringify(body) }), env as unknown as Env);
    return { status: res.status, json: (await res.json()) as any };
  };
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES ('proj_set', 'proj_set')"),
      env.DB.prepare('INSERT INTO usage_daily (project_id, day, records, quota, blocked_at) VALUES (?, ?, 120, 100, ?)').bind('proj_set', today, Date.now()),
      env.DB.prepare("INSERT INTO usage_daily (project_id, day, records) VALUES ('proj_set', '2001-01-01', 9)"),
      env.DB.prepare('INSERT INTO usage_daily (project_id, day, records) VALUES (?, ?, 5)').bind('proj_other_use', today),
    ]);
  });

  it('lists usage per project and day within the window', async () => {
    const { json } = await get('/v1/projects/proj_set/usage?days=7');
    expect(json.data).toEqual([{ project_id: 'proj_set', day: today, records: 120, quota: 100, blocked_at: expect.any(String) }]);
    expect((await get('/v1/usage')).json.data.map((r: any) => r.project_id)).toEqual(expect.arrayContaining(['proj_set', 'proj_other_use']));
    expect((await get('/v1/usage?days=nope')).status).toBe(200);
  });

  it('validates settings', async () => {
    expect((await put('/v1/projects/proj_set/settings', { color: 'red' })).status).toBe(422);
    expect((await put('/v1/projects/proj_set/settings', { daily_record_quota: -1 })).status).toBe(422);
    expect((await put('/v1/projects/proj_set/settings', { retention_days: 1.5 })).status).toBe(422);
    expect((await put('/v1/projects/proj_set/settings', {})).status).toBe(422);
    expect((await put('/v1/projects/proj_set/settings', [1])).status).toBe(422);
    expect((await put('/v1/projects/nope/settings', { retention_days: 7 })).status).toBe(404);
  });

  it('keeps an automatic block while the quota is still exceeded, lifts it when raised, and never lifts a manual block', async () => {
    await env.API_KEYS.put('project:proj_set', JSON.stringify({ over_quota_until: 9e9, reason: 'daily_quota' }));
    expect(await put('/v1/projects/proj_set/settings', { daily_record_quota: 110, retention_days: 7 })).toEqual({ status: 200, json: { id: 'proj_set', daily_record_quota: 110, retention_days: 7 } });
    expect(await env.API_KEYS.get('project:proj_set')).not.toBeNull();
    await put('/v1/projects/proj_set/settings', { daily_record_quota: 1000 });
    expect(await env.API_KEYS.get('project:proj_set')).toBeNull();
    expect((await get('/v1/projects/proj_set/usage?days=1')).json.data[0].blocked_at).toBeNull();
    await env.API_KEYS.put('project:proj_set', JSON.stringify({ over_quota_until: 9e9 }));
    await put('/v1/projects/proj_set/settings', { daily_record_quota: null });
    expect(await env.API_KEYS.get('project:proj_set')).not.toBeNull();
    const project = (await get('/v1/projects')).json.data.find((p: any) => p.id === 'proj_set');
    expect(project).toMatchObject({ daily_record_quota: null, retention_days: 7 });
  });
});

describe('read key expiry', () => {
  it('rejects an expired read key', async () => {
    await env.API_KEYS.put(await apiKeyKvKey('ew_read_expired'), JSON.stringify({ project_id: 'proj_api', name: 'old', scopes: ['read'], expires_at: Math.floor(Date.now() / 1000) - 1 }));
    expect((await get('/v1/projects', 'ew_read_expired')).status).toBe(401);
  });
});

describe('GET /healthz', () => {
  type Report = { status: string; service: string; checks: Record<string, { status: string; backend?: string; error?: string }> };
  const healthz = (override: Partial<Env> = {}) => app.fetch(new Request('https://api.edgewatch.test/healthz'), { ...(env as unknown as Env), ...override });

  it('needs no key and checks the event store, its schema, blobs and keys', async () => {
    const res = await healthz();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Report;
    expect(body).toMatchObject({ status: 'ok', service: 'api' });
    expect(Object.keys(body.checks).sort()).toEqual(['blobs', 'config', 'events', 'keys', 'schema']);
    expect(body.checks.events).toMatchObject({ status: 'ok', backend: 'd1' });
  });

  it('is down (503) when the database is unreachable or not migrated, without leaking the error', async () => {
    const unreachable = await healthz({ DB: { prepare: () => ({ first: () => Promise.reject(new Error('D1_ERROR: secret-host unreachable')) }) } as never });
    expect(unreachable.status).toBe(503);
    const text = await unreachable.text();
    expect(text).not.toContain('secret-host');
    expect((JSON.parse(text) as Report).checks.events?.error).toBe('unavailable');
    const unmigrated = await healthz({ DB: { prepare: (sql: string) => ({ first: () => (sql.includes('traces') ? Promise.reject(new Error('no such table: traces')) : Promise.resolve(null)) }) } as never });
    expect(unmigrated.status).toBe(503);
    expect(((await unmigrated.json()) as Report).checks.schema?.error).toBe('schema_missing');
  });
});
