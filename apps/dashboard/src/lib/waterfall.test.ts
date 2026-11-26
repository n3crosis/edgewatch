import { describe, expect, it } from 'vitest';
import type { Span } from './types';
import { waterfallDuration, waterfallPosition } from './waterfall';

const event = (start_ms: number, duration_ms: number): Span => ({ id: 'event', type: 'exception', label: 'Failure', start_ms, duration_ms });

describe('waterfall scale', () => {
  it('renders an instantaneous trace without invalid CSS or an invented duration', () => {
    const span = event(0, 0);
    expect(waterfallDuration([span], 0)).toBe(0);
    expect(waterfallPosition(span, 0)).toEqual({ left: 0, width: 0, label: 0 });
  });
  it('includes late child events beyond the root duration', () => {
    const span = event(150, 50);
    const total = waterfallDuration([span], 100);
    expect(total).toBe(200);
    expect(waterfallPosition(span, total)).toEqual({ left: 75, width: 25, label: 88 });
  });
  it('bounds malformed timing values', () => {
    expect(waterfallDuration([event(-1, Number.NaN)], Number.POSITIVE_INFINITY)).toBe(0);
    expect(waterfallPosition(event(-5, 400), 100)).toEqual({ left: 0, width: 100, label: 88 });
    expect(waterfallPosition(event(150, 10), 100)).toEqual({ left: 100, width: 0, label: 88 });
  });
});
