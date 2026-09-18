import { stripBasePath } from './base-path.js';

/**
 * How the page was opened decides what the shell may do before any screen
 * renders. The export renderer (services/api export/render.ts) opens
 * `/replay/:id?export=1` in headless Chromium: that page must stay a pure
 * player — no anonymous participant minted per render, no analytics session
 * started, nothing that touches the network beyond the replay itself.
 */
export type BootMode = 'app' | 'headless-render';

export function bootMode(
  location: { pathname: string; search: string },
  /**
   * Where the app is mounted (`Platform.basePath`). The renderer opens the
   * real public URL, so under a prefix the pathname is
   * `/testingxyzbdc/replay/:id` and the route has to be read past the prefix —
   * otherwise the export render mints a participant and starts analytics.
   */
  basePath?: string,
): BootMode {
  const exporting = new URLSearchParams(location.search).get('export') === '1';
  const route = stripBasePath(basePath, location.pathname);
  return exporting && /^\/replay\/[^/]+\/?$/.test(route) ? 'headless-render' : 'app';
}
