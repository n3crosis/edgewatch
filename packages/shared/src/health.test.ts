import { describe, expect, it } from 'vitest';
import { backendHealth, healthResponse } from './backends';
import { HealthCheckError, healthChecks, healthHttpStatus, runHealthChecks, type HealthCheck } from './health';

const pass = (required = true): HealthCheck => ({ required, run: async () => {} });
const failWith = (error: unknown, required = true): HealthCheck => ({ required, run: () => Promise.reject(error) });

describe('runHealthChecks', () => {
  it('is ok when every check passes, and reports each one', async () => {
    const report = await runHealthChecks('api', { events: { ...pass(), backend: 'd1' }, blobs: pass() });
    expect(report.status).toBe('ok');
    expect(report.service).toBe('api');
    expect(report.checks.events).toMatchObject({ status: 'ok', required: true, backend: 'd1' });
    expect(Number.isNaN(Date.parse(report.checked_at))).toBe(false);
    expect(healthHttpStatus(report)).toBe(200);
  });

  it('is degraded (200) when only an optional check fails, down (503) when a required one does', async () => {
    const degraded = await runHealthChecks('consumer', { events: pass(), keys: failWith(new Error('x'), false) });
    expect(degraded.status).toBe('degraded');
    expect(healthHttpStatus(degraded)).toBe(200);
    const down = await runHealthChecks('consumer', { events: failWith(new Error('x')), keys: failWith(new Error('x'), false) });
    expect(down.status).toBe('down');
    expect(healthHttpStatus(down)).toBe(503);
  });

  it('never puts the underlying error text in the report, only a fixed reason, and hands the error to onError', async () => {
    const seen: string[] = [];
    const report = await runHealthChecks('api', { events: failWith(new Error('connect ECONNREFUSED postgres://user:hunter2@db')) }, {
      onError: (name, e) => seen.push(`${name}:${(e as Error).message}`),
    });
    expect(report.checks.events).toMatchObject({ status: 'fail', error: 'unavailable' });
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(seen).toEqual(['events:connect ECONNREFUSED postgres://user:hunter2@db']);
  });

  it('fails a check that does not answer within the timeout', async () => {
    const report = await runHealthChecks('ingest', { keys: { required: true, run: () => new Promise(() => {}) } }, { timeoutMs: 20 });
    expect(report.checks.keys).toMatchObject({ status: 'fail', error: 'timeout' });
    expect(report.status).toBe('down');
  });

  it('keeps the reason and numbers of a HealthCheckError, and the numbers a passing check returns', async () => {
    const report = await runHealthChecks('server', {
      queue: failWith(new HealthCheckError('over_capacity', 'full', { pending: 95, capacity: 100 }), false),
      dlq: { required: false, run: async () => ({ pending: 3 }) },
    });
    expect(report.checks.queue).toMatchObject({ error: 'over_capacity', detail: { pending: 95, capacity: 100 } });
    expect(report.checks.dlq?.detail).toEqual({ pending: 3 });
  });
});

describe('healthChecks', () => {
  const db = (fail?: string) => ({
    prepare: (sql: string) => ({ first: async () => (fail && sql.includes(fail) ? Promise.reject(new Error('no such table: traces')) : null) }),
  });

  it('reports a missing binding as not_configured', async () => {
    const report = await runHealthChecks('api', { events: healthChecks.sql(undefined, 'd1'), secret: healthChecks.configured(''), limiter: healthChecks.configured(undefined, undefined, false) });
    expect(report.checks.events?.error).toBe('not_configured');
    expect(report.checks.secret?.error).toBe('not_configured');
    expect(report.checks.limiter).toMatchObject({ status: 'fail', required: false });
  });

  it('tells a reachable database without migrations apart (schema_missing)', async () => {
    const report = await runHealthChecks('api', { events: healthChecks.sql(db('traces'), 'postgres'), schema: healthChecks.schema(db('traces'), 'postgres') });
    expect(report.checks.events?.status).toBe('ok');
    expect(report.checks.schema).toMatchObject({ status: 'fail', error: 'schema_missing', backend: 'postgres' });
  });

  it('probes the blob and key stores with a read of a key that does not exist', async () => {
    const reads: string[] = [];
    const store = { get: async (key: string) => { reads.push(key); return null; } };
    const report = await runHealthChecks('api', { blobs: healthChecks.blobs(store, 'r2'), keys: healthChecks.keys(store, 'kv') });
    expect(report.status).toBe('ok');
    expect(reads).toEqual(['health/edgewatch-healthz-probe', 'edgewatch-healthz-probe']);
  });
});

describe('backendHealth', () => {
  it('reports a half-configured backend as a failing config check instead of throwing', async () => {
    const report = await backendHealth('api', { S3_BUCKET: 'traces' }, () => ({}));
    expect(report.status).toBe('down');
    expect(report.checks.config).toMatchObject({ status: 'fail', error: 'not_configured' });
    const res = healthResponse(report);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('passes the opened env and backend kinds to the checks', async () => {
    const report = await backendHealth('api', { S3_BUCKET: 'b', S3_ENDPOINT: 'http://s3.test', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }, (_env, kind) => ({ kinds: { required: true, backend: `${kind.events}/${kind.blobs}/${kind.keys}`, run: async () => {} } }));
    expect(report.checks.config?.status).toBe('ok');
    expect(report.checks.kinds?.backend).toBe('d1/s3/kv');
  });
});
