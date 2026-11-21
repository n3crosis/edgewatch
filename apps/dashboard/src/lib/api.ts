import { useEffect, useState } from 'react';
import * as mock from './mock';
import type { ExceptionDetail, ExceptionGroup, Overview, Paginated, QueryDetail, QueryGroup, Range, TraceDetail, TraceFilters, TraceSummary } from './types';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const API_KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? '';
export const PROJECT_ID = (import.meta.env.VITE_PROJECT_ID as string | undefined) || 'demo';
export const USING_MOCK = API_URL === '';

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(`${API_URL}/v1/projects/${PROJECT_ID}${path}`);
  Object.entries(params).forEach(([k, v]) => v && v !== 'all' && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${API_KEY}` } });
  if (res.status === 404) return null as T;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const delay = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120));

export const api = {
  overview: (range: Range) => (USING_MOCK ? delay(mock.overview(range)) : get<Overview>('/overview', { range })),
  traces: (filters: TraceFilters, cursor: string | null) =>
    USING_MOCK ? delay(mock.traces(filters, cursor)) : get<Paginated<TraceSummary>>('/traces', { ...filters, cursor: cursor ?? undefined }),
  trace: (id: string) => (USING_MOCK ? delay(mock.trace(id)) : get<TraceDetail | null>(`/traces/${id}`)),
  exceptions: (range: Range) => (USING_MOCK ? delay(mock.exceptions(range)) : get<{ data: ExceptionGroup[] }>('/exceptions', { range }).then((r) => r.data)),
  exception: (group: string) => (USING_MOCK ? delay(mock.exception(group)) : get<ExceptionDetail | null>(`/exceptions/${group}`)),
  queries: (range: Range) => (USING_MOCK ? delay(mock.queries(range)) : get<{ data: QueryGroup[] }>('/queries', { range }).then((r) => r.data)),
  query: (hash: string) => (USING_MOCK ? delay(mock.query(hash)) : get<QueryDetail | null>(`/queries/${hash}`)),
};

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: Error | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error: Error) => !cancelled && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
