import type { Span } from './types';

export function traceView(search: URLSearchParams, spans: Span[]) {
  const tab = search.get('tab') === 'records' ? 'records' : 'timeline';
  const eventType = search.get('type') || '';
  const spanId = search.get('span');
  return {
    tab, eventType, spanId,
    selected: tab === 'timeline' ? spans.find((span) => span.id === spanId) ?? null : null,
    visibleSpans: eventType ? spans.filter((span) => span.type === eventType) : spans,
  };
}

export function updateTraceView(previous: URLSearchParams, values: Record<string, string | null>) {
  const next = new URLSearchParams(previous);
  for (const [key, value] of Object.entries(values)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}
