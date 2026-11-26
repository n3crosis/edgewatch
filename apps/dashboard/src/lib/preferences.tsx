import { createContext, useContext, useState, type ReactNode } from 'react';

const UTC_STORAGE_KEY = 'edgewatch.show-utc';

interface LocalPreferencesState {
  showUtc: boolean;
  setShowUtc: (utc: boolean) => void;
}

const LocalPreferencesContext = createContext<LocalPreferencesState>({
  showUtc: true,
  setShowUtc: () => {},
});

function readInitialUtc(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(UTC_STORAGE_KEY);
    return raw === null || raw === '' || raw === '1';
  } catch {
    return true;
  }
}

export function LocalPreferencesProvider({ children }: { children: ReactNode }) {
  const [showUtc, setState] = useState<boolean>(readInitialUtc);
  const setShowUtc = (utc: boolean) => {
    setState(utc);
    try {
      globalThis.localStorage?.setItem(UTC_STORAGE_KEY, utc ? '1' : '0');
    } catch {
      /* Ignore storage quota / private mode failures. */
    }
  };
  return (
    <LocalPreferencesContext.Provider value={{ showUtc, setShowUtc }}>
      {children}
    </LocalPreferencesContext.Provider>
  );
}

export const useLocalPreferences = () => useContext(LocalPreferencesContext);

interface LayoutScrollState {
  isScrolled: boolean;
  scrollToTop: () => void;
}

export const LayoutScrollContext = createContext<LayoutScrollState>({
  isScrolled: false,
  scrollToTop: () => {},
});

export const useLayoutScroll = () => useContext(LayoutScrollContext);
