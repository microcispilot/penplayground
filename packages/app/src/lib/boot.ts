/**
 * How the page was opened decides what the shell may do before any screen
 * renders. The export renderer (services/api export/render.ts) opens
 * `/replay/:id?export=1` in headless Chromium: that page must stay a pure
 * player — no anonymous participant minted per render, no analytics session
 * started, nothing that touches the network beyond the replay itself.
 */
export type BootMode = 'app' | 'headless-render';

export function bootMode(location: { pathname: string; search: string }): BootMode {
  const exporting = new URLSearchParams(location.search).get('export') === '1';
  return exporting && /^\/replay\/[^/]+\/?$/.test(location.pathname) ? 'headless-render' : 'app';
}
