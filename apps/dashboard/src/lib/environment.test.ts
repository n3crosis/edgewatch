import { afterEach, describe, expect, it } from 'vitest';
import { scopedPath, scopedSearch } from '../components/ScopedLink';
import { activeEnvironment, environmentParams, selectEnvironment, setActiveEnvironment } from './environment-scope';
import * as mock from './mock';

afterEach(() => setActiveEnvironment(undefined));

describe('environment scope', () => {
  it('preserves other URL filters and clears pagination when scope changes', () => {
    const before = new URLSearchParams('project=shop&range=custom:1:2&q=checkout&cursor=old&offset=50');
    const selected = selectEnvironment(before, 'all');
    expect(selected.get('environment')).toBe('all');
    expect(selected.get('project')).toBe('shop');
    expect(selected.get('range')).toBe('custom:1:2');
    expect(selected.get('q')).toBe('checkout');
    expect(selected.has('cursor')).toBe(false);
    expect(selected.has('offset')).toBe(false);
    expect(before.get('cursor')).toBe('old');
    expect(selectEnvironment(selected, undefined).has('environment')).toBe(false);
  });

  it('preserves scope in string and object destinations, including literal all and escaped names', () => {
    for (const environment of ['all', 'staging / EU', 'production']) {
      const link = new URL(scopedPath('/queries?sql=x#samples', 'shop', 'custom:1:2', environment), 'https://test');
      expect(link.searchParams.get('environment')).toBe(environment);
      expect(link.searchParams.get('project')).toBe('shop');
      expect(link.searchParams.get('range')).toBe('custom:1:2');
      expect(link.hash).toBe('#samples');
      expect(new URLSearchParams(scopedSearch('q=hello', 'shop', '1h', environment)).get('q')).toBe('hello');
    }
    expect(new URL(scopedPath('/traces?environment=staging', 'shop', '1h'), 'https://test').searchParams.has('environment')).toBe(false);
  });

  it('adds the active scope to investigation requests without scoping operational views', () => {
    setActiveEnvironment('all');
    expect(activeEnvironment()).toBe('all');
    for (const path of ['/overview', '/requests/trend', '/issues?status=open', '/traces/id', '/queries/hash', '/logs/error', '/users/7']) {
      expect(environmentParams(path, { range: '1h' })).toEqual({ range: '1h', environment: 'all' });
    }
    for (const path of ['/environments', '/permissions', '/pipeline', '/usage', '/dead-letters/replay', '/settings']) expect(environmentParams(path, {})).toEqual({});
    expect(environmentParams('/traces', { environment: 'staging' })).toEqual({ environment: 'staging' });
    setActiveEnvironment(undefined);
    expect(environmentParams('/overview', {}).environment).toBeUndefined();
  });
});

describe('demo environment isolation', () => {
  it('filters aggregate views, cached event tables, details and samples while keeping environment discovery complete', () => {
    mock.setMockProject(mock.MOCK_PROJECTS[0].id);
    // Build a cached event table while scoped; it must still support switching to another environment.
    setActiveEnvironment('production');
    expect(mock.events('/logs', '24h').data.length).toBeGreaterThan(0);
    setActiveEnvironment(undefined);
    const all = mock.traces({ range: '24h' }, null, 10000).data;
    const counts: Record<string, number> = {};
    const baseline = mock.overview('24h').requests;
    const queryCalls = (rows: ReturnType<typeof mock.queries>) => rows.reduce((n, row) => n + row.calls, 0);
    const allQueries = queryCalls(mock.queries('24h'));
    let scopedQueries = 0;
    for (const environment of ['production', 'staging']) {
      setActiveEnvironment(environment);
      const expected = all.filter((row) => row.environment === environment);
      expect(expected.length).toBeGreaterThan(0);
      const ids = new Set(expected.map((row) => row.trace_id));
      expect(mock.traces({ range: '24h' }, null, 10000).data).toEqual(expected);
      counts[environment] = mock.overview('24h').requests;
      expect(counts[environment]).toBe(expected.filter((row) => row.execution_source === 'request').length);
      expect(mock.trace(all.find((row) => row.environment !== environment)!.trace_id)).toBeNull();
      expect(mock.trace(expected[0].trace_id)?.trace.environment).toBe(environment);
      const queries = mock.queries('24h');
      scopedQueries += queryCalls(queries);
      for (const row of queries) expect(mock.query(row.sql_hash, '24h')!.samples.every((sample) => ids.has(sample.trace_id))).toBe(true);
      for (const row of mock.exceptions('24h')) expect(mock.exception(row.group, '24h')!.occurrences.every((event) => ids.has(event.trace_id))).toBe(true);
      for (const path of ['/logs', '/jobs', '/commands', '/mail', '/users']) {
        const groups = mock.events(path, '24h').data;
        expect(groups.length).toBeGreaterThan(0);
        for (const row of groups) expect(mock.eventRows(path, row.key, '24h')!.every((event) => ids.has(event.trace_id))).toBe(true);
      }
      expect(mock.environments().map((row) => row.name)).toEqual(['production', 'staging']);
    }
    expect(counts.production + counts.staging).toBe(baseline);
    expect(scopedQueries).toBe(allQueries);
    setActiveEnvironment('missing');
    expect(mock.overview('24h').requests).toBe(0);
    expect(mock.traces().data).toEqual([]);
    expect(mock.events('/logs', '24h').data).toEqual([]);
  });
});
