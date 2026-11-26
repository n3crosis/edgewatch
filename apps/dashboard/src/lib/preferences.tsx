import { createContext, useContext, useState, type ReactNode } from 'react';

const UTC_STORAGE_KEY = 'edgewatch.show-utc';
const URL_FORMAT_STORAGE_KEY = 'edgewatch.url-format';

export type UrlFormat = 'path' | 'full';

interface LocalPreferencesState {
  showUtc: boolean;
  setShowUtc: (utc: boolean) => void;
  urlFormat: UrlFormat;
  setUrlFormat: (format: UrlFormat) => void;
}

const LocalPreferencesContext = createContext<LocalPreferencesState>({
  showUtc: true,
  setShowUtc: () => {},
  urlFormat: 'path',
  setUrlFormat: () => {},
});

function readInitialUtc(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(UTC_STORAGE_KEY);
    return raw === null || raw === '' || raw === '1';
  } catch {
    return true;
  }
}

function readInitialUrlFormat(): UrlFormat {
  try {
    const raw = globalThis.localStorage?.getItem(URL_FORMAT_STORAGE_KEY);
    return raw === 'full' ? 'full' : 'path';
  } catch {
    return 'path';
  }
}

export function LocalPreferencesProvider({ children }: { children: ReactNode }) {
  const [showUtc, setUtcState] = useState<boolean>(readInitialUtc);
  const [urlFormat, setUrlFormatState] = useState<UrlFormat>(readInitialUrlFormat);

  const setShowUtc = (utc: boolean) => {
    setUtcState(utc);
    try {
      globalThis.localStorage?.setItem(UTC_STORAGE_KEY, utc ? '1' : '0');
    } catch {
      /* Ignore storage quota / private mode failures. */
    }
  };

  const setUrlFormat = (format: UrlFormat) => {
    setUrlFormatState(format);
    try {
      globalThis.localStorage?.setItem(URL_FORMAT_STORAGE_KEY, format);
    } catch {
      /* Ignore storage quota / private mode failures. */
    }
  };

  return (
    <LocalPreferencesContext.Provider value={{ showUtc, setShowUtc, urlFormat, setUrlFormat }}>
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
