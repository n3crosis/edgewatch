import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';
const STORAGE_KEY = 'edgewatch.theme';

/** Stored choice, else the OS preference. index.html applies the same rule before first paint to avoid a flash. */
export function initialTheme(): Theme {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return themeFrom(stored, globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
}

export function initialPreference(): ThemePreference {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** A saved 'light'/'dark' wins; anything else (nothing saved, a stale value) follows the OS. */
export function themeFrom(stored: string | null, prefersLight: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersLight ? 'light' : 'dark';
}

/** Kumo reads `data-mode` and Tailwind reads `.dark` on the root element. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);

  useEffect(() => {
    document.documentElement.dataset.mode = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Until the user picks a theme, follow OS light/dark switches live (e.g. automatic dark mode at sunset).
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setTheme((t) => (localStorage.getItem(STORAGE_KEY) ? t : themeFrom(null, e.matches)));
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    if (next === 'system') {
      localStorage.removeItem(STORAGE_KEY);
      setTheme(themeFrom(null, globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ?? false));
    } else {
      localStorage.setItem(STORAGE_KEY, next);
      setTheme(next);
    }
  };

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setPreference(next);
  };

  return { theme, preference, setPreference, toggle };
}
