import type { GroupPage, QuerySort, HandledFilter } from './group-list';
import { useEnvironment } from './environment';
import { environmentParams } from './environment-scope';
import { timeWindow } from '@edgewatch/shared/time-window';
import { useEffect, useRef, useState } from 'react';
import * as mock from './mock';
import { activeProjectId, useProject } from './project';
import { useRange } from './range';
import type { RequestTrend, Issue, IssueDetail, IssueStatus, RequestGroup, RequestGroups, DeadLetter, UsageDay, EventList, EventRow, ExceptionDetail, ExceptionGroup, Overview, Paginated, PipelineHealth, QueryDetail, QueryGroup, Range, TraceDetail, TraceFilters, TraceSummary } from './types';

import { fetchApi, UnauthorizedError } from './auth';
import { API_URL, USING_MOCK } from './config';

export { API_URL, USING_MOCK };

async function get<T>(path: string, params: Record<string, string | undefined> = {}, init: RequestInit = {}): Promise<T> {
  const url = new URL(`${API_URL}/v1/projects/${encodeURIComponent(activeProjectId())}${path}`, globalThis.location?.origin);
  Object.entries(environmentParams(path, params)).forEach(([k, v]) => v !== undefined && (v !== 'all' || ['q', 'route', 'user', 'server', 'environment'].includes(k)) && url.searchParams.set(k, v));
  const res = await fetchApi(url, init).catch((e: unknown) => {
    throw e instanceof UnauthorizedError ? e : new Error(`Could not reach the EdgeWatch API at ${url.origin}.`);
  });
  if (res.status === 404) return null as T;
  if (!res.ok) throw new Error(apiErrorMessage(res.status, await res.text().catch(() => '')));
  return res.json() as Promise<T>;
}

/** Turns an EdgeWatch error body ({error:{code,message}, request_id}) into one readable line; never shows raw bodies. */
export function apiErrorMessage(status: number, body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: { message?: unknown }; message?: unknown; request_id?: unknown }) : {};
  const message = typeof record.error?.message === 'string' ? record.error.message : typeof record.message === 'string' ? record.message : `Request failed (HTTP ${status}).`;
  return typeof record.request_id === 'string' ? `${message} Request ID: ${record.request_id}` : message;
}

const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120));

function mockRequests(range: Range, q: string, offset: number, user?: string): RequestGroups {
  const groups = new Map<string, { row: RequestGroup; durations: number[] }>();
  let cursor: string | null = null;
  do {
    const page = mock.traces({ source: 'request', range, user }, cursor);
    for (const t of page.data) {
      const route = t.route || t.route_path || '[unnamed]';
      const route_kind = t.route ? 'name' : t.route_path ? 'path' : 'unknown';
      const method = t.method ?? 'UNKNOWN';
      if (!`${method} ${route}`.toLowerCase().includes(q.toLowerCase())) continue;
      const key = JSON.stringify([method, route_kind, route]);
      const g = groups.get(key) ?? { row: { method, route, route_kind, requests: 0, avg_ms: 0, p95_ms: null, status_2xx: 0, status_3xx: 0, status_4xx: 0, status_5xx: 0, status_other: 0 }, durations: [] };
      g.row.requests++;
      g.durations.push(t.duration_ms);
      const family = Math.floor((t.status_code ?? 0) / 100);
      const field = family >= 2 && family <= 5 ? `status_${family}xx` as 'status_2xx' : 'status_other';
      g.row[field]++;
      groups.set(key, g);
    }
    cursor = page.next_cursor;
  } while (cursor);
  const data = [...groups.values()].map(({ row, durations }) => ({ ...row, avg_ms: durations.reduce((a, b) => a + b, 0) / durations.length, p95_ms: durations.sort((a, b) => a - b)[Math.ceil(durations.length * .95) - 1] })).sort((a, b) => b.requests - a.requests || a.method.localeCompare(b.method) || a.route.localeCompare(b.route));
  return { data: data.slice(offset, offset + 50), next_offset: data.length > offset + 50 ? offset + 50 : null };
}

function mockRequestTrend(filters: TraceFilters): RequestTrend {
  const { now: until, width, since } = timeWindow(filters.range)!;
  const buckets = Array.from({ length: 24 }, () => ({ durations: [] as number[], errors: 0 }));
  let cursor: string | null = null;
  do {
    const page = mock.traces({ ...filters, source: 'request' }, cursor);
    for (const row of page.data) {
      const timestamp = Date.parse(row.timestamp);
      if (timestamp < since || timestamp > until) continue;
      const bucket = buckets[Math.min(23, Math.floor((timestamp - since) / width))];
      bucket.durations.push(row.duration_ms);
      if ((row.status_code ?? 0) >= 500 && (row.status_code ?? 0) < 600) bucket.errors++;
    }
    cursor = page.next_cursor;
  } while (cursor);
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), series: buckets.map((bucket, i) => {
    const values = bucket.durations.sort((a, b) => a - b);
    return { ts: new Date(since + i * width).toISOString(), requests: values.length, errors: bucket.errors, p95_ms: values[Math.ceil(values.length * .95) - 1] ?? 0 };
  }) };
}

export const api = {
  environments: () => USING_MOCK ? delay(mock.environments()) : get<{ data: { name: string; traces: number }[] }>('/environments').then((result) => result.data),
  requestTrend: (filters: TraceFilters) => USING_MOCK ? delay(mockRequestTrend(filters)) : get<RequestTrend>('/requests/trend', { ...filters }),
  issues: (range: Range, status: string, q: string, offset: number) => USING_MOCK
    ? delay<{ data: Issue[]; next_offset: number | null }>({ data: [], next_offset: null })
    : get<{ data: Issue[]; next_offset: number | null }>(`/issues?status=${encodeURIComponent(status)}`, { range, q, offset: String(offset) }),
  issue: (group: string) => USING_MOCK ? delay<IssueDetail | null>(null) : get<IssueDetail | null>(`/issues/${encodeURIComponent(group)}`),
  updateIssue: (group: string, status: IssueStatus, expected: IssueStatus, revision: number, reason: string) => get<{ status: IssueStatus }>(`/issues/${encodeURIComponent(group)}`, {}, { method: 'PUT', body: JSON.stringify({ status, expected_status: expected, expected_revision: revision, reason }) }),
  logEntries: (range: Range, level: string, q: string, cursor: string | null, user?: string) => USING_MOCK
    ? delay(mock.logEntries(range, level, q, cursor, user))
    : get<Paginated<EventRow>>('/log-entries', { range, level, q, cursor: cursor ?? undefined, user }),
  logEntry: (id: string, range: Range, user?: string) => USING_MOCK ? delay(mock.logEntry(id, range, user)) : get<EventRow | null>(`/log-entries/${encodeURIComponent(id)}`, { range, user }),
  requests: (range: Range, q = '', offset = 0, user?: string) => USING_MOCK ? delay(mockRequests(range, q, offset, user)) : get<RequestGroups>('/requests', { range, q, offset: String(offset), user }),
  permissions: () => (USING_MOCK ? delay({ can_manage: true }) : get<{ can_manage: boolean }>('/permissions')),
  overview: (range: Range) => (USING_MOCK ? delay(mock.overview(range)) : get<Overview>('/overview', { range })),
  traces: (filters: TraceFilters, cursor: string | null) =>
    USING_MOCK ? delay(mock.traces(filters, cursor)) : get<Paginated<TraceSummary>>('/traces', { ...filters, cursor: cursor ?? undefined }),
  trace: (id: string) => (USING_MOCK ? delay(mock.trace(id)) : get<TraceDetail | null>(`/traces/${id}`)),
  exceptions: (range: Range) => (USING_MOCK ? delay(mock.exceptions(range)) : get<{ data: ExceptionGroup[] }>('/exceptions', { range }).then((r) => r.data)),
  exception: (group: string, range: Range = '24h', user?: string) => (USING_MOCK ? delay(mock.exception(group, range, user)) : get<ExceptionDetail | null>(`/exceptions/${group}`, { range, user })),
  queryList: (range: Range, q: string, sort: QuerySort, offset: number): Promise<GroupPage<QueryGroup>> => {
    if (!USING_MOCK) return get('/queries', { range, q, sort, offset: String(offset) });
    const needle = q.toLowerCase().trim();
    const rows = mock.queries(range).filter((g) => [g.sql, g.connection, g.sql_hash].some((value) => value.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b[sort]) - Number(a[sort]) || a.sql_hash.localeCompare(b.sql_hash));
    return delay({ data: rows.slice(offset, offset + 200), next_offset: rows.length > offset + 200 ? offset + 200 : null });
  },
  exceptionList: (range: Range, q: string, handled: HandledFilter, offset: number, user?: string): Promise<GroupPage<ExceptionGroup>> => {
    if (!USING_MOCK) return get('/exceptions', { range, q, handled, offset: String(offset), user });
    const needle = q.toLowerCase().trim();
    const rows = mock.exceptions(range, user).filter((g) => (handled === 'all' || g.handled === (handled === 'handled'))
      && [g.class, g.message, g.file].some((value) => value.toLowerCase().includes(needle))).sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
    return delay({ data: rows.slice(offset, offset + 100), next_offset: rows.length > offset + 100 ? offset + 100 : null });
  },
  queries: (range: Range) => (USING_MOCK ? delay(mock.queries(range)) : get<{ data: QueryGroup[] }>('/queries', { range }).then((r) => r.data)),
  query: (hash: string, range: Range = '24h') => (USING_MOCK ? delay(mock.query(hash, range)) : get<QueryDetail | null>(`/queries/${hash}`, { range })),
  events: (path: string, range: Range, params: Record<string, string | undefined> = {}) =>
    USING_MOCK ? delay(mock.events(path, range, params)) : get<EventList>(path, { range, ...params }),
  eventRows: (path: string, key: string, range: Range = '24h', user?: string) =>
    USING_MOCK ? delay(mock.eventRows(path, key, range, user)) : get<{ data: EventRow[] } | null>(`${path}/${encodeURIComponent(key)}`, { range, user }).then((r) => r?.data ?? null),
  pipeline: () => (USING_MOCK ? delay(mock.pipeline()) : get<PipelineHealth>('/pipeline')),
  usage: () => (USING_MOCK ? delay(mock.usage()) : get<{ data: UsageDay[] }>('/usage', { days: '7' }).then((r) => r.data)),
  deadLetters: () => (USING_MOCK ? delay<DeadLetter[]>([]) : get<{ data: DeadLetter[] }>('/dead-letters').then((r) => r.data)),
  replayDeadLetters: (ids?: string[]) =>
    USING_MOCK ? delay({ requested: 0 }) : get<{ requested: number }>('/dead-letters/replay', {}, { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }),
};

/** Loads data for `deps`; manual refreshes silently re-fetch while keeping current data on screen. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  options?: { keepPreviousData?: boolean },
): { data: T | undefined; error: Error | null; loading: boolean; fetching: boolean } {
  const keepPrevious = options?.keepPreviousData ?? false;
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean; fetching: boolean }>({
    data: undefined,
    error: null,
    loading: true,
    fetching: true,
  });
  const { tick } = useRange();
  const { projectId } = useProject();
  const { environment } = useEnvironment();
  const scopeKey = JSON.stringify([projectId, environment]);
  const key = JSON.stringify([projectId, environment, ...deps]);
  const loadedScope = useRef<string | null>(null);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sameScope = loadedScope.current === scopeKey;
    const sameKey = loadedKey.current === key;
    if (!sameKey) {
      if (keepPrevious && sameScope) {
        setState((prev) => ({ data: prev.data, error: null, loading: prev.data === undefined, fetching: true }));
      } else {
        setState({ data: undefined, error: null, loading: true, fetching: true });
      }
    } else {
      setState((prev) => ({ ...prev, fetching: true }));
    }
    loadedScope.current = scopeKey;
    loadedKey.current = key;
    load().then(
      (data) => !cancelled && setState({ data, error: null, loading: false, fetching: false }),
      (error: Error) => !cancelled && setState({ data: undefined, error, loading: false, fetching: false }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scopeKey, tick, keepPrevious]);

  if (loadedKey.current === key) return state;
  if (keepPrevious && loadedScope.current === scopeKey && state.data !== undefined) {
    return { data: state.data, error: null, loading: false, fetching: true };
  }
  return { data: undefined, error: null, loading: true, fetching: true };
}
