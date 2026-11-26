import { describe, expect, it } from 'vitest';
import { timeWindow } from './time-window';

describe('time windows', () => {
  it('keeps absolute bounds fixed when the clock changes', () => {
    expect(timeWindow('custom:1000:25000', 100)).toEqual({ range: 'custom:1000:25000', since: 1000, now: 25000, width: 1000 });
    expect(timeWindow('custom:1000:25000', 999999)).toEqual(timeWindow('custom:1000:25000', 100));
    expect(timeWindow('1h', 4000000)?.since).toBe(400000);
    expect(timeWindow('constructor', 4000000)?.range).toBe('24h');
  });
  it('rejects reversed, empty, nonfinite and out-of-Date bounds', () => {
    for (const value of ['custom:', 'custom:1:1', 'custom:2:1', 'custom:-1:2', 'custom:1:NaN', 'custom:1:Infinity', 'custom:1:8640000000000001', 'custom:1:2:3']) expect(timeWindow(value)).toBeNull();
  });
});
