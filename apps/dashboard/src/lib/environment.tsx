import { createContext, useContext, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { selectEnvironment, setActiveEnvironment } from './environment-scope';

const EnvironmentContext = createContext<{ environment: string | undefined; setEnvironment: (value: string | undefined) => void }>({ environment: undefined, setEnvironment: () => {} });

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const environment = params.get('environment') || undefined;
  setActiveEnvironment(environment);
  const setEnvironment = (value: string | undefined) => setParams((current) => selectEnvironment(current, value));
  return <EnvironmentContext.Provider value={{ environment, setEnvironment }}>{children}</EnvironmentContext.Provider>;
}

export const useEnvironment = () => useContext(EnvironmentContext);
