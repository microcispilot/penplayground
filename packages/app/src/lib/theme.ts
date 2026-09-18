import { applyTheme, readTheme, type Theme } from '@pen/design';
import { useSyncExternalStore } from 'react';

/**
 * One theme for the whole shell: the header, the sidebar's Settings row and
 * any future control read and write the same value, and the document follows.
 */
const listeners = new Set<() => void>();
let current: Theme | null = null;

function get(): Theme {
  if (current === null) current = readTheme();
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  if (typeof document !== 'undefined') applyTheme(theme);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme and a setter; the first mount applies the stored choice to the document. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, get, () => 'light' as const);
  return [theme, setTheme];
}

/** What the document is actually showing (system resolves to the OS setting). */
export function isDarkTheme(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
}
