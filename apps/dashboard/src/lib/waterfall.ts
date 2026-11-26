import type { Span } from './types';

const positive = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** Include late child events without inventing a duration for instantaneous traces. */
export function waterfallDuration(spans: Span[], total: number): number {
  return spans.reduce((end, span) => Math.max(end, positive(span.start_ms) + positive(span.duration_ms)), positive(total));
}

export function waterfallPosition(span: Span, total: number) {
  const scale = positive(total) || 1;
  const left = Math.min(100, positive(span.start_ms) / scale * 100);
  const width = Math.min(100 - left, positive(span.duration_ms) / scale * 100);
  return { left, width, label: Math.min(88, left + width) };
}
