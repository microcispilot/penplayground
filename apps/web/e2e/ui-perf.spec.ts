import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { SCREENS, UI_PREVIEW } from './ui-helpers.js';

/**
 * A Lighthouse-shaped measurement of what the two heavy routes actually cost to
 * load, on a fresh profile (Playwright gives every test its own): when the
 * document is ready, and when the largest thing a learner looks at has painted.
 *
 * It runs against `vite preview` — the real production build — because the dev
 * server ships a few hundred unbundled modules and would measure nothing we
 * ever deploy. The budgets are a regression fence on a developer's machine, not
 * a benchmark; the numbers it writes to `.pen-data/screens/timings.json` are
 * the point, and the assertions only catch a collapse.
 */
interface Timing {
  route: string;
  domContentLoadedMs: number;
  loadMs: number;
  lcpMs: number;
  /** Bytes of script the document actually fetched before it was interactive. */
  scriptBytes: number;
  scriptRequests: number;
}

/** Install the LCP observer before any application code runs. */
async function observeLcp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp?: number };
    w.__lcp = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
}

async function readTiming(page: Page, route: string): Promise<Timing> {
  // LCP is only final once the page settles; nudge the observer to flush.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 400))));
  return page.evaluate((name) => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const scripts = performance
      .getEntriesByType('resource')
      .filter(
        (e): e is PerformanceResourceTiming =>
          (e as PerformanceResourceTiming).initiatorType === 'script',
      );
    return {
      route: name,
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadMs: Math.round(nav.loadEventEnd || nav.responseEnd),
      lcpMs: Math.round((window as unknown as { __lcp?: number }).__lcp ?? 0),
      scriptBytes: scripts.reduce((n, e) => n + (e.decodedBodySize || e.transferSize || 0), 0),
      scriptRequests: scripts.length,
    };
  }, route);
}

const results: Timing[] = [];

test.afterAll(() => {
  if (results.length === 0) return;
  mkdirSync(SCREENS, { recursive: true });
  writeFileSync(join(SCREENS, 'timings.json'), JSON.stringify(results, null, 2));
});

test.describe('route load performance', () => {
  test.setTimeout(180_000);

  /**
   * The board engine alone is ~2 MB decoded. A budget well under that is the
   * assertion that Explore does not ship it, and it survives content-hashed
   * chunk names in a way that matching on "tldraw" in a URL cannot.
   */
  const HOME_SCRIPT_BUDGET = 1_200_000;

  test('Explore paints without the board engine', async ({ page }) => {
    await observeLcp(page);
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));

    await page.goto(`${UI_PREVIEW}/`, { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: /What do you want to/ })).toBeVisible();

    const timing = await readTiming(page, 'home');
    results.push(timing);
    console.log('[perf] home', JSON.stringify(timing));

    expect(timing.scriptBytes).toBeLessThan(HOME_SCRIPT_BUDGET);
    // Nor the ad SDK, nor the media stack: both are fetched by the moment that needs them.
    expect(requested.some((u) => /imasdk\.googleapis/i.test(u))).toBe(false);
    expect(requested.some((u) => /livekit/i.test(u))).toBe(false);

    expect(timing.lcpMs).toBeGreaterThan(0);
    expect(timing.lcpMs).toBeLessThan(6_000);
  });

  test('the room paints, and only the room pays for the board', async ({ page }) => {
    // Start a lesson so there is a live room to load cold.
    await page.goto(`${UI_PREVIEW}/`);
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    const roomUrl = page.url();

    // Reload it as a cold navigation, with the observer in from the first byte.
    await observeLcp(page);
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto(roomUrl, { waitUntil: 'load' });
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });

    const timing = await readTiming(page, 'room');
    results.push(timing);
    console.log('[perf] room', JSON.stringify(timing));

    // Here the board engine is fetched — lazily, and only here.
    expect(timing.scriptBytes).toBeGreaterThan(HOME_SCRIPT_BUDGET);
    expect(timing.lcpMs).toBeGreaterThan(0);
    expect(timing.lcpMs).toBeLessThan(15_000);
  });
});
