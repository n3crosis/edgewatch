import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyKvKey, SqlKeyStore, type IngestMessage, type SqlDatabase, type SqlStatement } from '../packages/shared/src';
import { FsBlobStore } from '../apps/server/src/fs-blob';
import api from '../workers/api/src';
import { processMessage } from '../workers/consumer/src/process';

/** Exercise the actual consumer and API SQL on each supported database engine. */
export async function checkInvestigations(db: SqlDatabase) {
  const dir = mkdtempSync(join(tmpdir(), 'ew-investigation-'));
  const env = { DB: db, TRACES: new FsBlobStore(dir), API_KEYS: new SqlKeyStore(db) };
  const token = 'ew_read_integration_admin';
  await env.API_KEYS.put(await apiKeyKvKey(token), JSON.stringify({ project_id: 'investigation', name: 'integration', scopes: ['admin'] }));
  const request = async (path: string, body?: unknown) => {
    const response = await api.fetch(new Request(`https://edgewatch.test/v1/projects/investigation${path}`, { method: body ? 'PUT' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(200);
    return data;
  };
  const emit = async (timestamp: number, duration: number, routeName: string | null = 'items.show', routePath: string | null = null, environment = 'production') => {
    const id = crypto.randomUUID();
    const base = { v: 1, timestamp, trace_id: id, execution_source: 'request', server: 'web', user: '7', environment };
    await processMessage({ project_id: 'investigation', server: 'web', received_at: Date.now(), trace_id: id, records: [
      { ...base, t: 'request', method: 'GET', url: 'https://test/items/1', route_name: routeName, route_path: routePath, status_code: 500, duration },
      { ...base, v: 3, t: 'exception', class: 'RuntimeException', file: 'app/Items.php', line: 4, code: '0', message: 'Unavailable', handled: false, trace: '[]' },
      { ...base, t: 'query', sql: 'select * from investigation_items', connection: 'sqlite', file: 'app/Items.php', line: 5, duration },
      { ...base, t: 'log', level: 'error', message: 'Item unavailable', context: '{"item":1}' },
    ] as unknown as IngestMessage['records'] }, env);
  };
  try {
    await emit(Date.now() / 1000 - 30, 100000);
    await emit(Date.now() / 1000 - 20, 300000);
    expect((await request('/traces?user=7&server=web&environment=production')).data).toHaveLength(2);
    expect((await request('/traces?environment=staging')).data).toEqual([]);
    expect((await request('/traces?environment=Production')).data).toEqual([]);
    for (const filter of ['user=70', 'server=we', 'server=WEB', 'user=%25', 'server=%25']) {
      expect((await request(`/traces?${filter}`)).data).toEqual([]);
    }
    const firstTrace = (await request('/traces')).data.at(-1);
    const start = Date.parse(firstTrace.timestamp);
    const fixed = `range=${encodeURIComponent(`custom:${start - 1}:${start}`)}`;
    expect((await request(`/overview?${fixed}`)).requests).toBe(1);
    expect((await request(`/traces?${fixed}`)).data).toHaveLength(1);
    expect((await request(`/requests?${fixed}`)).data[0].requests).toBe(1);
    expect((await request(`/requests/trend?route=items.show&${fixed}`)).series.reduce((sum: number, row: any) => sum + row.requests, 0)).toBe(1);
    const fixedExceptions = await request(`/exceptions?${fixed}`);
    expect(fixedExceptions.data[0].count).toBe(1);
    expect(fixedExceptions.data[0].last_trace_id).toBe(firstTrace.trace_id);
    expect((await request(`/exceptions/${fixedExceptions.data[0].group}?${fixed}`)).occurrences).toHaveLength(1);
    const fixedQueries = await request(`/queries?${fixed}`);
    expect(fixedQueries.data[0].calls).toBe(1);
    expect((await request(`/queries/${fixedQueries.data[0].sql_hash}?${fixed}`)).samples).toHaveLength(1);
    expect((await request(`/log-entries?${fixed}`)).data).toHaveLength(1);
    expect((await request(`/logs?${fixed}`)).data[0].count).toBe(1);
    expect((await request(`/logs/error?${fixed}`)).data).toHaveLength(1);
    const overview = await request('/overview?range=1h');
    expect(overview).toMatchObject({ requests: 2, error_rate: 1, p95_ms: 300, exceptions: 2, slow_queries: 1 });
    expect(overview.series.reduce((sum: number, row: any) => sum + row.requests, 0)).toBe(2);
    expect(overview.top_routes[0]).toMatchObject({ requests: 2, p95_ms: 300, error_rate: 1 });
    const trend = await request('/requests/trend?range=1h&route=items.show&route_kind=name&method=GET&min_duration_ms=200&status=5xx');
    expect(trend.series).toHaveLength(24);
    expect(trend.series.reduce((sum: number, row: any) => sum + row.requests, 0)).toBe(1);
    expect(trend.series.find((row: any) => row.requests)).toMatchObject({ errors: 1, p95_ms: 300 });
    const requests = await request('/requests?range=1h');
    expect(requests.data[0]).toMatchObject({ requests: 2, avg_ms: 200, p95_ms: 300, status_5xx: 2 });
    const queryGroups = await request('/queries?range=1h');
    expect(queryGroups.data[0]).toMatchObject({ calls: 2, p95_ms: 300 });
    const queryDetail = await request(`/queries/${queryGroups.data[0].sql_hash}?range=1h`);
    expect(queryDetail).toMatchObject({ calls: 2, p95_ms: 300 });
    expect((await request('/queries?q=items&sort=calls&offset=0')).data.length).toBeGreaterThan(0);
    expect((await request('/queries?q=does-not-match')).data).toEqual([]);
    expect((await request('/exceptions?handled=unhandled&q=unavailable')).data.length).toBeGreaterThan(0);
    expect((await request('/exceptions?handled=handled')).data).toEqual([]);
    const logs = await request('/log-entries?level=error');
    expect(logs.data).toHaveLength(2);
    expect(JSON.parse(logs.data[0].context)).toEqual({ item: 1 });
    expect(await request(`/log-entries/${logs.data[0].id}`)).toMatchObject({ ...logs.data[0], execution_available: 1, environment: 'production' });
    const issues = await request('/issues');
    expect(issues.data).toHaveLength(1);
    const path = `/issues/${issues.data[0].group_hash}`;
    await request(path, { status: 'resolved', expected_status: 'open', expected_revision: issues.data[0].revision, reason: 'Fix deployed' });
    expect((await request(path)).issue.status).toBe('resolved');
    await emit(Date.now() / 1000 + 1, 200000);
    const regressed = await request(path);
    expect(regressed.issue.status).toBe('open');
    expect(regressed.issue.revision).toBe(2);
    expect(regressed.changes.map((c: any) => c.status).sort()).toEqual(['open', 'resolved']);
    expect(regressed.impact.occurrences).toBe(3);
    // Force both operators to read the same revision before either transaction starts.
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gated = (statement: SqlStatement): SqlStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => gated(target.bind(...values));
        if (property === 'first') return async () => {
          const value = await target.first();
          if (++reads === 2) release();
          await gate;
          return value;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const raceEnv = { ...env, DB: { prepare: (sql: string) => sql.startsWith('SELECT status, revision FROM issues') ? gated(db.prepare(sql)) : db.prepare(sql), batch: db.batch.bind(db) } };
    const race = await Promise.all(['ignored', 'resolved'].map(async (status) => {
      const response = await api.fetch(new Request(`https://edgewatch.test/v1/projects/investigation${path}`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status, expected_revision: regressed.issue.revision, reason: 'Concurrent operator update' }),
      }), raceEnv);
      await response.json();
      return response.status;
    }));
    expect(race.sort()).toEqual([200, 409]);
    const afterRace = await request(path);
    expect(afterRace.issue.revision).toBe(3);
    expect(afterRace.changes).toHaveLength(3);
    await emit(Date.now() / 1000 - 10, 100000, null, '/items/{item}');
    await emit(Date.now() / 1000 - 5, 300000, null, '/items/{item}');
    const routes = await request('/requests?range=1h');
    expect(routes.data.find((r: any) => r.route_kind === 'path')).toMatchObject({ route: '/items/{item}', requests: 2, avg_ms: 200, p95_ms: 300 });
    const occurrences = await request('/traces?source=request&route=%2Fitems%2F%7Bitem%7D&route_kind=path');
    expect(occurrences.data).toHaveLength(2);
    const slow = await request('/traces?source=request&route=%2Fitems%2F%7Bitem%7D&route_kind=path&min_duration_ms=200.5&status=5xx');
    expect(slow.data).toHaveLength(1);
    expect(slow.data[0].duration_ms).toBe(300);
    await emit(Date.now() / 1000 - 1, 200000, 'items.show', null, 'staging');
    const scoped = 'environment=staging&range=1h';
    expect((await request(`/overview?${scoped}`))).toMatchObject({ requests: 1, exceptions: 1, slow_queries: 1 });
    expect((await request(`/requests?${scoped}`)).data[0].requests).toBe(1);
    const stage = (await request(`/traces?${scoped}`)).data[0];
    expect((await request(`/traces/${stage.trace_id}?${scoped}`)).trace.environment).toBe('staging');
    const stageExceptions = (await request(`/exceptions?${scoped}`)).data;
    expect(stageExceptions[0].count).toBe(1);
    expect(stageExceptions[0].trend.reduce((sum: number, n: number) => sum + n, 0)).toBe(1);
    expect((await request(`/exceptions/${stageExceptions[0].group}?${scoped}`)).occurrences).toHaveLength(1);
    const stageQueries = (await request(`/queries?${scoped}`)).data;
    expect(stageQueries[0].calls).toBe(1);
    expect((await request(`/queries/${stageQueries[0].sql_hash}?${scoped}`)).samples).toHaveLength(1);
    const stageLogs = (await request(`/log-entries?${scoped}`)).data;
    expect(stageLogs).toHaveLength(1);
    expect(await request(`/log-entries/${stageLogs[0].id}?${scoped}`)).toMatchObject({ ...stageLogs[0], execution_available: 1, environment: 'staging' });
    expect((await request(`/logs?${scoped}`)).data[0].count).toBe(1);
    expect((await request(`/logs/error?${scoped}`)).data).toHaveLength(1);
    expect((await request(`/users?${scoped}`)).data[0].count).toBe(1);
    expect((await request(`/users/7?${scoped}`)).data).toHaveLength(1);
    const stageIssues = await request(`/issues?status=all&${scoped}`);
    expect(stageIssues.data).toHaveLength(1);
    expect(stageIssues.lifecycle_scope).toBe('project');
    expect((await request(`${path}?${scoped}`)).impact.occurrences).toBe(1);
    expect((await request('/environments')).data.map((r: any) => r.name)).toEqual(['production', 'staging']);

    const userScope = 'environment=staging&user=7&range=1h';
    expect((await request(`/requests?${userScope}`)).data[0].requests).toBe(1);
    expect((await request(`/requests/trend?route=items.show&${userScope}`)).series.reduce((n: number, row: any) => n + row.requests, 0)).toBe(1);
    const userExceptions = (await request(`/exceptions?${userScope}`)).data;
    expect(userExceptions[0].count).toBe(1);
    expect((await request(`/exceptions/${userExceptions[0].group}?${userScope}`)).occurrences.map((row: any) => row.user)).toEqual(['7']);
    expect((await request(`/log-entries/${stageLogs[0].id}?${userScope}`)).user).toBe('7');
    const attemptId = crypto.randomUUID();
    await processMessage({ project_id: 'investigation', server: 'web', received_at: Date.now(), trace_id: attemptId, records: [
      { v: 1, t: 'job-attempt', timestamp: Date.now() / 1000 - 1, trace_id: attemptId, attempt_id: attemptId, job_id: attemptId,
        execution_source: 'job', environment: 'staging', user: '7', name: 'UserJob', attempt: 1, status: 'processed', duration: 1000, connection: 'sync', queue: 'default' },
    ] as unknown as IngestMessage['records'] }, env);
    expect((await request(`/jobs?${userScope}`)).summary.attempts).toBe(1);
    expect((await request(`/jobs/UserJob?${userScope}`)).data.map((row: any) => row.user)).toEqual(['7']);
    for (const path of ['/requests', '/jobs', '/exceptions', '/log-entries']) expect((await request(`${path}?user=70&environment=staging`)).data).toEqual([]);

    await db.prepare('INSERT INTO exceptions (project_id, trace_id, group_hash, class, message, file, line, handled, timestamp, user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('investigation', stage.trace_id, stageExceptions[0].group, 'RuntimeException', 'Caught later', 'app/Items.php', 4, 1, Date.now() - 1000, '7').run();
    const mixed = (await request(`/exceptions?handled=unhandled&${userScope}`)).data[0];
    expect(mixed).toMatchObject({ count: 2, handled: false, handled_count: 1, unhandled_count: 1 });
    expect((await request(`/exceptions/${mixed.group}?${userScope}`))).toMatchObject({ handled: false, handled_count: 1, unhandled_count: 1 });
    expect((await request(`/exceptions?handled=handled&${userScope}`)).data).toEqual([]);

  } finally { rmSync(dir, { recursive: true, force: true }); }
}
