import { expect, it } from 'vitest';
import { traceView, updateTraceView } from './trace-view';
import type { Span } from './types';

const query: Span = { id: 'query-content', type: 'query', label: 'select 1', start_ms: 0, duration_ms: 1 };
const exception: Span = { ...query, id: 'exception-content', type: 'exception', label: 'Failed' };

it('restores a linked event from current records independently of the type filter', () => {
  const search = new URLSearchParams('span=query-content&type=exception');
  expect(traceView(search, [exception, query])).toMatchObject({ selected: query, visibleSpans: [exception] });
  expect(traceView(search, [exception]).selected).toBeNull();
  expect(traceView(new URLSearchParams('type=unsupported'), [query]).visibleSpans).toEqual([]);
});

it('preserves investigation scope when opening, closing and switching tabs', () => {
  const initial = new URLSearchParams('project=shop&environment=staging&range=custom:1:2&type=query');
  const opened = updateTraceView(initial, { tab: 'timeline', span: query.id });
  expect(traceView(opened, [query]).selected).toEqual(query);
  const records = updateTraceView(opened, { tab: 'records', span: null });
  expect(traceView(records, [query])).toMatchObject({ tab: 'records', selected: null });
  for (const [key, value] of initial) expect(records.get(key)).toBe(value);
  expect(records.has('span')).toBe(false);
  expect(initial.has('span')).toBe(false);
  expect(traceView(new URLSearchParams('tab=unknown'), []).tab).toBe('timeline');
});
