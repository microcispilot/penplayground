import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * The UI pair from playwright.config.ts: fake model, silent voice, no ads.
 * Specs address it absolutely, the way rooms.spec.ts addresses its own pair.
 */
export const UI_WEB = process.env.PEN_E2E_UI_WEB ?? 'http://localhost:5183';

/** The same app, served as the production build by `vite preview`. */
export const UI_PREVIEW = process.env.PEN_E2E_PREVIEW ?? 'http://localhost:5184';

/** Git-ignored: the screenshots the report describes. */
export const SCREENS = resolve(process.cwd(), '../../.pen-data/screens');

export type Theme = 'light' | 'dark';

export const VIEWPORTS = [
  { name: 'desktop', width: 1024, height: 768 },
  { name: 'ipad', width: 834, height: 1194 },
  { name: 'iphone', width: 390, height: 844 },
] as const;

export type ViewportName = (typeof VIEWPORTS)[number]['name'];

/** Pick the theme before the app boots, the way the inline script in index.html reads it. */
export async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('pen.theme', t as string);
    } catch {
      /* a private window still gets the default theme */
    }
  }, theme);
}

/** Start a lesson from Explore and wait until the room is live and writing. */
export async function startLesson(
  page: Page,
  topic = 'How Transformers work in LLMs',
): Promise<void> {
  await page.goto(`${UI_WEB}/`);
  await page.getByLabel('What do you want to learn?').fill(topic);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // The board is a lazy chunk: wait for the paper, not just the route.
  await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
}

/** Wait until the expert has actually written something on the board. */
export async function waitForInk(page: Page): Promise<void> {
  await expect
    .poll(async () => page.locator('.pen-board .tl-shape').count(), { timeout: 45_000 })
    .toBeGreaterThan(0);
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  // Sheets and pills rise in; a screenshot taken on the first frame of that is a
  // picture of nothing. Wait for the animations to settle before capturing.
  await page
    .evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))))
    .catch(() => undefined);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

/** End the session and open the saved page, which is where a replay is linked from. */
export async function endSession(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.getByText('Session saved')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open the saved session' }).click();
  await page.waitForURL(/\/sessions\//, { timeout: 20_000 });
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';
  return id;
}
