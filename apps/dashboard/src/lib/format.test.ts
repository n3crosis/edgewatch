import { describe, expect, it } from 'vitest';
import { ago, ms, percentile } from './format';
import { scopedPath } from '../components/ScopedLink';
import { exception, exceptions, overview, queries, query, trace, traces } from './mock';

describe('format', () => {
  it('formats durations', () => {
    expect(ms(1.234)).toBe('1.23ms');
    expect(ms(42.5)).toBe('42.5ms');
    expect(ms(320.4)).toBe('320ms');
    expect(ms(1500)).toBe('1.50s');
  });

  it('computes percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });

  it('formats relative time', () => {
    expect(ago(new Date(Date.now() - 90_000).toISOString())).toBe('1m ago');
  });
});

describe('seed data', () => {
  it('is internally consistent', () => {
    const o = overview('24h');
    expect(o.requests).toBeGreaterThan(100);
    expect(o.series).toHaveLength(24);

    const first = traces({}, null).data[0];
    expect(trace(first.trace_id)?.trace).toMatchObject(first);
    expect(traces({ source: 'job' }).data.every((t) => t.execution_source === 'job')).toBe(true);
    expect(traces({ status: '5xx' }).data.every((t) => (t.status_code ?? 0) >= 500)).toBe(true);

    const e = exceptions('24h')[0];
    expect(exception(e.group)?.occurrences.length).toBeGreaterThan(0);

    const q = queries('24h')[0];
    expect(query(q.sql_hash)?.samples.length).toBeGreaterThan(0);
    expect(q.sql).not.toMatch(/'\w+'|\b\d+\b/);
  });
});

describe('exact trace filters', () => {
  it('combines user and server filters before pagination without treating wildcards specially', () => {
    const all = traces({}, null, 10000).data;
    const sample = all.find((row) => row.user && row.server)!;
    const filters = { user: sample.user!, server: sample.server! };
    const expected = all.filter((row) => row.user === filters.user && row.server === filters.server);
    expect(expected.length).toBeGreaterThan(1);
    const first = traces(filters, null, 1);
    const second = traces(filters, first.next_cursor, 1);
    expect([first.data[0], second.data[0]]).toEqual(expected.slice(0, 2));
    expect(traces({ user: '%' }).data).toEqual([]);
    expect(traces({ server: '%' }).data).toEqual([]);
    expect(traces({ server: 'all' }).data).toEqual([]);
    expect(traces({ environment: 'production' }, null, 10000).data).toEqual(all.filter((row) => row.environment === 'production'));
    expect(traces({ environment: 'staging' }).data.length).toBeGreaterThan(0);
    expect(traces({ environment: 'all' }).data).toEqual([]);
    expect(traces({ user: 'all' }).data).toEqual([]);
  });
});

describe('mock traces time range', () => {
  it('preserves fixed bounds in links and excludes records after the end', () => {
    const sample = traces({}, null, 10000).data.find((t) => t.execution_source === 'request')!;
    const start = Date.parse(sample.timestamp);
    const range = `custom:${start}:${start + 1}` as const;
    const rows = traces({ range }, null, 10000).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Date.parse(row.timestamp) >= start && Date.parse(row.timestamp) <= start + 1)).toBe(true);
    const result = overview(range);
    expect(result.requests).toBe(rows.filter((row) => row.execution_source === 'request').length);
    expect(result.series.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(result.requests);
    const link = new URL(scopedPath('/queries?q=select', 'shop', range), 'https://test');
    expect(link.searchParams.get('range')).toBe(range);
    expect(link.searchParams.get('project')).toBe('shop');
    expect(link.searchParams.get('q')).toBe('select');
  });

  it('only returns traces inside the selected range', () => {
    const hour = traces({ range: '1h' }, null, 10_000).data;
    const day = traces({ range: '24h' }, null, 10_000).data;
    expect(hour.length).toBeLessThan(day.length);
    expect(hour.every((t) => Date.now() - Date.parse(t.timestamp) <= 3600e3 + 5_000)).toBe(true);
  });
});

describe('two-project seed data', () => {
  it('has two projects whose data never overlaps', async () => {
    const { MOCK_PROJECTS, setMockProject } = await import('./mock');
    expect(MOCK_PROJECTS.length).toBeGreaterThanOrEqual(2);

    setMockProject(MOCK_PROJECTS[0].id);
    const shop = traces({}, null, 2000).data;
    setMockProject(MOCK_PROJECTS[1].id);
    const billing = traces({}, null, 2000).data;
    setMockProject(MOCK_PROJECTS[0].id);

    expect(shop.some((t) => t.name.includes('/checkout'))).toBe(true);
    expect(billing.some((t) => t.name.includes('/v1/invoices'))).toBe(true);
    const shopIds = new Set(shop.map((t) => t.trace_id));
    expect(billing.some((t) => shopIds.has(t.trace_id))).toBe(false);
    expect(billing.every((t) => !t.name.includes('/checkout'))).toBe(true);
  });
});

describe('seed event tables', () => {
  it('derives the Jobs view from the generated job traces', async () => {
    const { events, eventRows, traces } = await import('./mock');
    const jobs = events('/jobs', '24h');
    const jobTraces = traces({ source: 'job' }, null, 10_000).data;
    expect(jobs.summary?.attempts).toBe(jobTraces.length);
    expect(jobs.data.length).toBeGreaterThan(0);
    const first = jobs.data[0];
    expect(eventRows('/jobs', first.key)?.every((r) => r.name === first.key)).toBe(true);
    expect(events('/jobs', '24h', { status: 'failed' }).data.every((g) => Number(g.failed) > 0)).toBe(true);
    expect(eventRows('/jobs', 'Nope')).toBeNull();
  });
});

describe('seed commands view', () => {
  it('derives the Commands view from the generated command traces', async () => {
    const { events, eventRows, traces } = await import('./mock');
    const commandTraces = traces({ source: 'command' }, null, 10_000).data;
    const cmds = events('/commands', '24h');
    expect(cmds.summary?.runs).toBe(commandTraces.length);
    expect(cmds.summary?.failed).toBe(commandTraces.filter((t) => t.exception_count > 0).length);
    expect(eventRows('/commands', cmds.data[0].key)?.[0]).toHaveProperty('exit_code');
    expect(events('/commands', '24h', { status: 'failed' }).data.every((g) => Number(g.failed) > 0)).toBe(true);
  });
});

describe('seed cache view', () => {
  it('reports a hit ratio consistent with its own counts', async () => {
    const { events, eventRows } = await import('./mock');
    const cache = events('/cache', '24h');
    const s = cache.summary!;
    expect(s.hits + s.misses).toBeGreaterThan(0);
    expect(s.hit_ratio).toBeCloseTo(s.hits / (s.hits + s.misses), 3);
    expect(events('/cache', '24h', { type: 'miss' }).data.every((g) => Number(g.misses) > 0 && Number(g.hits) === 0)).toBe(true);
    expect(eventRows('/cache', cache.data[0].key)?.length).toBeGreaterThan(0);
  });
});

describe('seed outgoing HTTP view', () => {
  it('derives one Stripe call per checkout trace', async () => {
    const { events, traces } = await import('./mock');
    const checkouts = traces({}, null, 10_000).data.filter((t) => t.name === 'POST /checkout');
    const out = events('/outgoing-requests', '24h');
    expect(out.summary?.requests).toBe(checkouts.length);
    expect(out.summary?.failed).toBe(checkouts.filter((t) => t.exception_count > 0).length);
    expect(events('/outgoing-requests', '24h', { status: '4xx' }).data.every((g) => Number(g.failed) > 0)).toBe(true);
  });
});

describe('seed mail and notification views', () => {
  it('sends one email and one notification per successful checkout', async () => {
    const { events, traces } = await import('./mock');
    const ok = traces({}, null, 10_000).data.filter((t) => t.name === 'POST /checkout' && !t.exception_count).length;
    expect(events('/mail', '24h').summary?.sent).toBe(ok);
    expect(events('/notifications', '24h').summary?.sent).toBe(ok);
    expect(events('/notifications', '24h', { channel: 'mail' }).data).toEqual([]);
  });
});

describe('seed scheduled tasks view', () => {
  it('reports one run per seeded command trace', async () => {
    const { events, traces } = await import('./mock');
    const runs = traces({}, null, 10_000).data.filter((t) => t.execution_source === 'command').length;
    const out = events('/scheduled-tasks', '24h');
    expect(out.summary?.runs).toBe(runs);
    expect(out.data[0]?.cron).toBe('0 * * * *');
  });
});

describe('seed logs view', () => {
  it('logs one error per failed request and filters by level', async () => {
    const { events, traces } = await import('./mock');
    const failed = traces({}, null, 10_000).data.filter((t) => t.execution_source === 'request' && t.exception_count > 0).length;
    expect(events('/logs', '24h').summary?.errors).toBe(failed);
    expect(events('/logs', '24h', { level: 'info' }).data.map((g) => g.key)).toEqual(['info']);
  });
});

describe('seed users view', () => {
  it('counts distinct users across request traces', async () => {
    const { events, traces } = await import('./mock');
    const reqs = traces({}, null, 10_000).data.filter((t) => t.execution_source === 'request' && t.user);
    const out = events('/users', '24h');
    expect(out.summary?.users).toBe(new Set(reqs.map((t) => t.user)).size);
    expect(out.summary?.traces).toBe(reqs.length);
  });
});
