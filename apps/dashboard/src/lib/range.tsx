import { timeWindow } from '@edgewatch/shared/time-window';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProject } from './project';
import type { Range } from './types';

interface RangeState {
  range: Range;
  setRange: (r: Range) => void;
  /** Increments on manual refresh so active views re-fetch fresh data. */
  tick: number;
  lastUpdated: number;
  refresh: () => void;
}

const RangeContext = createContext<RangeState>({
  range: '24h',
  setRange: () => {},
  tick: 0,
  lastUpdated: Date.now(),
  refresh: () => {},
});

export function RangeProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { projectId } = useProject();
  const [fallbackRange, setFallbackRange] = useState<Range>('24h');
  const value = params.get('range');
  const range: Range = value && (['1h', '6h', '24h', '7d', '14d', '30d'].includes(value) || (value.startsWith('custom:') && timeWindow(value))) ? value as Range : fallbackRange;
  const setRange = (r: Range) => {
    setFallbackRange(r);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('range', r);
      next.delete('cursor');
      next.delete('offset');
      return next;
    });
  };
  useEffect(() => {
    setFallbackRange(range);
    if (params.get('range') !== range || params.get('project') !== projectId) {
      const next = new URLSearchParams(params);
      next.set('range', range);
      next.set('project', projectId);
      setParams(next, { replace: true });
    }
  }, [params, range, projectId, setParams]);
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(Date.now());

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    setLastUpdated(Date.now());
  }, []);

  return <RangeContext.Provider value={{ range, setRange, tick, lastUpdated, refresh }}>{children}</RangeContext.Provider>;
}

export const useRange = () => useContext(RangeContext);

export const rangeLabel = (range: Range) => range.startsWith('custom:') ? 'selected window' : `last ${range}`;
