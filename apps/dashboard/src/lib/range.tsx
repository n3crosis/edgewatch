import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Range } from './types';

const RangeContext = createContext<{ range: Range; setRange: (r: Range) => void }>({ range: '24h', setRange: () => {} });

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<Range>('24h');
  return <RangeContext.Provider value={{ range, setRange }}>{children}</RangeContext.Provider>;
}

export const useRange = () => useContext(RangeContext);
