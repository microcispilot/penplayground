import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { SCREENS, UI_WEB, useTheme } from './ui-helpers.js';

/**
 * How many lessons stand in a row.
 *
 * The catalogue used to auto-fill at a 272 px minimum, which fits *four* cards
 * inside the 1232 px content column. The owner asked for three: four made the
 * page read as a dense grid of small pictures rather than a shelf of lessons.
 *
 * A count like that is invisible to every other kind of test — the page
 * renders, the cards are right, nothing throws — and it is the sort of thing a
 * later `minmax()` tweak silently undoes. So it is measured here, off the
 * grid's own resolved `grid-template-columns`, at the widths that decide it.
 *
 * The breakpoints are the sidebar's rather than the page's. At a 1024 px
 * viewport the 240 px rail leaves about 736 px, and three cards there would be
 * 232 px each — narrower than the 272 px the card was drawn for. So two until
 * 1280, three above it, and the wide case is pinned as *exactly* three rather
 * than "at most three": the content column stops at 1280 px, so a fourth can
 * only ever come back by someone changing this on purpose.
 *
 *   pnpm --filter @pen/web exec playwright test e2e/ui-catalogue.spec.ts --project=chromium
 */

const CASES = [
  { name: 'phone', width: 390, height: 844, columns: 1 },
  { name: 'tablet', width: 834, height: 1194, columns: 2 },
  { name: 'laptop', width: 1024, height: 768, columns: 2 },
  { name: 'desktop', width: 1440, height: 900, columns: 3 },
  // Wider than the 1280 px content column: the grid must not grow with the window.
  { name: 'wide', width: 2560, height: 1440, columns: 3 },
] as const;

/** The catalogue grid: the one that holds the session cards on Home. */
const GRID = '[data-testid="catalogue"]';

async function columnCount(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const grid = document.querySelector(selector);
    if (!grid) throw new Error('Home has no catalogue');
    // A resolved `grid-template-columns` is one used value per column, so the
    // count is what a reader actually sees — not what the class name implies.
    return getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
  }, GRID);
}

test.describe('the catalogue stands three in a row', () => {
  for (const { name, width, height, columns } of CASES) {
    test(`${name} (${width}px): ${columns} across`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${UI_WEB}/`);
      await expect(page.locator(GRID)).toBeVisible({ timeout: 30_000 });
      expect(await columnCount(page)).toBe(columns);
    });
  }

  // One test per theme rather than a loop inside one: `useTheme` installs an
  // init script, and a second call on the same page stacks a second one.
  for (const theme of ['light', 'dark'] as const) {
    test(`the picture, at the width the owner looks at it (${theme})`, async ({ page }) => {
      mkdirSync(SCREENS, { recursive: true });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await useTheme(page, theme);
      await page.goto(`${UI_WEB}/`);
      await expect(page.locator(GRID)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(SCREENS, `catalogue-${theme}.png`), fullPage: true });
    });
  }
});
