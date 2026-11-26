import { describe, expect, it } from 'vitest';
import type { Span } from './types';
import { filterSpansByQuery, formatStackTrace, inlineLogContext, traceTimeBreakdown, yAxisTicks } from './ui-helpers';

describe('yAxisTicks', () => {
  const nice = (n: number) => `${Math.round(n)}`;

  it('suppresses duplicate middle ticks for tiny ranges', () => {
    expect(yAxisTicks(1, nice)).toEqual(['1', '', '0']);
    expect(yAxisTicks(0, nice)).toEqual(['0', '', '0']);
  });

  it('keeps distinct middle ticks for normal ranges', () => {
    expect(yAxisTicks(100, nice)).toEqual(['100', '50', '0']);
  });
});

describe('traceTimeBreakdown', () => {
  it('computes leaf category shares and remaining application time', () => {
    const spans: Span[] = [
      { id: 'r', type: 'request', label: 'POST /checkout', start_ms: 0, duration_ms: 400 },
      { id: 'q1', type: 'query', label: 'select 1', start_ms: 10, duration_ms: 80 },
      { id: 'q2', type: 'query', label: 'update orders', start_ms: 90, duration_ms: 20 },
      { id: 'o1', type: 'outgoing-request', label: 'POST stripe', start_ms: 120, duration_ms: 200 },
    ];
    const segments = traceTimeBreakdown(spans, 400);
    expect(segments.map((s) => [s.key, Math.round(s.percent)])).toEqual([
      ['outgoing-request', 50],
      ['query', 25],
      ['app', 25],
    ]);
  });

  it('normalizes safely when overlapping leaf spans exceed trace duration', () => {
    const spans: Span[] = [
      { id: 'q1', type: 'query', label: 'q1', start_ms: 0, duration_ms: 150 },
      { id: 'o1', type: 'outgoing-request', label: 'o1', start_ms: 0, duration_ms: 150 },
    ];
    const segments = traceTimeBreakdown(spans, 200);
    expect(segments.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100, 5);
  });

  it('returns empty for zero-duration traces', () => {
    expect(traceTimeBreakdown([], 0)).toEqual([]);
  });
});

describe('filterSpansByQuery', () => {
  const spans: Span[] = [
    { id: 'q1', type: 'query', label: 'select * from orders', start_ms: 0, duration_ms: 5, meta: { connection: 'mysql' } },
    { id: 'o1', type: 'outgoing-request', label: 'POST https://api.stripe.com', start_ms: 5, duration_ms: 80, meta: { status: 402 } },
  ];

  it('matches across label, type, and meta values', () => {
    expect(filterSpansByQuery(spans, 'stripe').map((s) => s.id)).toEqual(['o1']);
    expect(filterSpansByQuery(spans, 'mysql').map((s) => s.id)).toEqual(['q1']);
    expect(filterSpansByQuery(spans, '402').map((s) => s.id)).toEqual(['o1']);
    expect(filterSpansByQuery(spans, '   ')).toHaveLength(2);
  });
});

describe('formatStackTrace', () => {
  it('formats exception header and numbered frames', () => {
    expect(
      formatStackTrace('RuntimeException', 'Out of memory', [
        { file: 'app/Jobs/Sync.php:42', source: 'Sync->handle()' },
        { file: 'vendor/laravel/Pipeline.php:10', source: 'Pipeline->then()' },
      ]),
    ).toBe('RuntimeException: Out of memory\n#0 app/Jobs/Sync.php:42 — Sync->handle()\n#1 vendor/laravel/Pipeline.php:10 — Pipeline->then()');
  });
});

describe('inlineLogContext', () => {
  it('hides empty objects/strings and truncates long values', () => {
    expect(inlineLogContext(null)).toBeNull();
    expect(inlineLogContext('')).toBeNull();
    expect(inlineLogContext('{}')).toBeNull();
    expect(inlineLogContext('{"status":500}')).toBe('{"status":500}');
    expect(inlineLogContext('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});
