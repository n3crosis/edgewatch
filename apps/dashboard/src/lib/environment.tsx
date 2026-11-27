import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { selectEnvironment, setActiveEnvironment } from './environment-scope';
import type { EnvironmentColor } from './types';

export const ENV_COLOR_OPTIONS: { value: EnvironmentColor; label: string; dotClass: string }[] = [
  { value: 'emerald', label: 'Emerald', dotClass: 'bg-emerald-500' },
  { value: 'blue', label: 'Blue', dotClass: 'bg-blue-500' },
  { value: 'amber', label: 'Amber', dotClass: 'bg-amber-500' },
  { value: 'rose', label: 'Rose', dotClass: 'bg-rose-500' },
  { value: 'violet', label: 'Violet', dotClass: 'bg-violet-500' },
  { value: 'cyan', label: 'Cyan', dotClass: 'bg-cyan-500' },
  { value: 'orange', label: 'Orange', dotClass: 'bg-orange-500' },
  { value: 'pink', label: 'Pink', dotClass: 'bg-pink-500' },
  { value: 'neutral', label: 'Neutral', dotClass: 'bg-neutral-500' },
];

const DOT_BY_COLOR = new Map<string, string>(ENV_COLOR_OPTIONS.map((o) => [o.value, o.dotClass]));

export function defaultEnvColor(name: string, index = 0): EnvironmentColor {
  const lower = name.toLowerCase();
  if (lower.includes('prod')) return 'emerald';
  if (lower.includes('stag')) return 'amber';
  if (lower.includes('local') || lower.includes('dev')) return 'blue';
  return ENV_COLOR_OPTIONS[index % ENV_COLOR_OPTIONS.length].value;
}

export function envDotClass(name: string, color?: string | null, index = 0): string {
  if (color && DOT_BY_COLOR.has(color)) return DOT_BY_COLOR.get(color)!;
  return DOT_BY_COLOR.get(defaultEnvColor(name, index)) ?? 'bg-blue-500';
}

const EnvironmentContext = createContext<{
  environment: string | undefined;
  setEnvironment: (value: string | undefined, options?: { replace?: boolean }) => void;
  envRevision: number;
  refreshEnvironments: () => void;
}>({
  environment: undefined,
  setEnvironment: () => {},
  envRevision: 0,
  refreshEnvironments: () => {},
});

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const [envRevision, setEnvRevision] = useState(0);
  const environment = params.get('environment') || undefined;
  setActiveEnvironment(environment);
  const setEnvironment = useCallback(
    (value: string | undefined, options?: { replace?: boolean }) =>
      setParams((current) => selectEnvironment(current, value), options),
    [setParams],
  );
  const refreshEnvironments = () => setEnvRevision((n) => n + 1);
  return (
    <EnvironmentContext.Provider value={{ environment, setEnvironment, envRevision, refreshEnvironments }}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export const useEnvironment = () => useContext(EnvironmentContext);
