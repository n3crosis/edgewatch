import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Range } from './types';

export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS ?? 15_000) || 15_000;

interface RangeState {
  range: Range;
  setRange: (r: Range) => void;
  /** Live mode re-fetches every POLL_INTERVAL_MS; `tick` increments on each poll. */
  live: boolean;
  setLive: (live: boolean) => void;
  tick: number;
  lastUpdated: number;
}

const RangeContext = createContext<RangeState>({ range: '24h', setRange: () => {}, live: false, setLive: () => {}, tick: 0, lastUpdated: Date.now() });

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<Range>('24h');
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(Date.now());

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setLastUpdated(Date.now());
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live]);

  return <RangeContext.Provider value={{ range, setRange, live, setLive, tick, lastUpdated }}>{children}</RangeContext.Provider>;
}

export const useRange = () => useContext(RangeContext);
