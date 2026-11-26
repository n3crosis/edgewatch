export type QuerySort = 'total_ms' | 'calls' | 'p95_ms';
export type HandledFilter = 'all' | 'handled' | 'unhandled';
export type GroupPage<T> = { data: T[]; next_offset: number | null };

export function groupListState(params: URLSearchParams) {
  const sort = params.get('sort');
  const handled = params.get('handled');
  const offset = Number(params.get('offset') ?? 0);
  return {
    q: params.get('q') ?? '',
    sort: (sort === 'calls' || sort === 'p95_ms' ? sort : 'total_ms') as QuerySort,
    handled: (handled === 'handled' || handled === 'unhandled' ? handled : 'all') as HandledFilter,
    offset: Number.isSafeInteger(offset) && offset >= 0 && offset <= Number.MAX_SAFE_INTEGER - 200 ? offset : 0,
  };
}

export function updateGroupList(params: URLSearchParams, patch: Record<string, string>) {
  const next = new URLSearchParams(params);
  if ('q' in patch || 'sort' in patch || 'handled' in patch) next.delete('offset');
  for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
  return next;
}

export function groupListLink(path: string, params: URLSearchParams) {
  const kept = new URLSearchParams();
  for (const key of ['project', 'environment', 'range', 'q', 'sort', 'handled', 'offset', 'user']) {
    const value = params.get(key);
    if (value !== null) kept.set(key, value);
  }
  return `${path}?${kept}`;
}
