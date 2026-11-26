export const RELATIVE_WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
export type TimeRange = keyof typeof RELATIVE_WINDOWS | `custom:${number}:${number}`;

/** Absolute windows use inclusive Unix millisecond bounds, independent of client timezone. */
export function timeWindow(value: string | undefined, clock = Date.now()) {
  if (value?.startsWith('custom:')) {
    const match = /^custom:(\d+):(\d+)$/.exec(value);
    if (!match) return null;
    const since = Number(match[1]);
    const now = Number(match[2]);
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(now) || now > 8640000000000000 || since >= now) return null;
    return { range: value as TimeRange, since, now, width: (now - since) / 24 };
  }
  const range = value && Object.hasOwn(RELATIVE_WINDOWS, value) ? value as keyof typeof RELATIVE_WINDOWS : '24h';
  return { range, since: clock - RELATIVE_WINDOWS[range], now: clock, width: RELATIVE_WINDOWS[range] / 24 };
}
