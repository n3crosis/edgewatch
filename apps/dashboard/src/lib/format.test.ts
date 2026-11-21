import { describe, expect, it } from 'vitest';
import { ago, ms, percentile } from './format';
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
    expect(trace(first.trace_id)?.trace).toEqual(first);
    expect(traces({ source: 'job' }).data.every((t) => t.execution_source === 'job')).toBe(true);
    expect(traces({ status: '5xx' }).data.every((t) => (t.status_code ?? 0) >= 500)).toBe(true);

    const e = exceptions('24h')[0];
    expect(exception(e.group)?.occurrences.length).toBeGreaterThan(0);

    const q = queries('24h')[0];
    expect(query(q.sql_hash)?.samples.length).toBeGreaterThan(0);
    expect(q.sql).not.toMatch(/'\w+'|\b\d+\b/);
  });
});
