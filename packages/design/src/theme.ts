export type Theme = 'light' | 'dark' | 'system';

const KEY = 'pen.theme';

/**
 * Pen is paper and ink: light is the product's default look, not the OS's.
 * A learner who picks dark keeps it; nothing else follows the system.
 */
export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: theme still applied for this page */
  }
}
