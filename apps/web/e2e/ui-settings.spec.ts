import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SCREENS, UI_WEB, useTheme, VIEWPORTS } from './ui-helpers.js';

/**
 * Settings, as pictures and as two measurements the owner asked for.
 *
 * The board previews carry real board work (Pythagoras, in the board's own
 * ink) rather than a bar, and are tall enough to read it; the colour dots sit
 * on one line whether or not a plan tag hangs under them. Review pictures:
 * `.pen-data/screens/settings-{light,dark}-{desktop,ipad,iphone}.png`.
 */
for (const theme of ['light', 'dark'] as const) {
  test.describe(`settings, ${theme}`, () => {
    test('the board previews are written on, and the colour dots share one line', async ({
      page,
    }) => {
      await useTheme(page, theme);
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(`${UI_WEB}/settings`);
        await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible({ timeout: 30_000 });

        // Every board preview shows the writing, masked in the board's ink.
        const previews = page.locator('[data-testid^="board-"]');
        expect(await previews.count()).toBe(6);
        for (const preview of await previews.all()) {
          const handwriting = preview.locator(
            'span[style*="mask-image"], span[style*="-webkit-mask-image"]',
          );
          expect(await handwriting.count(), 'a preview with nothing written on it').toBeGreaterThan(
            0,
          );
          const box = await preview.locator('> span').first().boundingBox();
          // 100 px at the browser's default root size; the desktop scale is 85 % of it
          // (packages/design/src/styles/index.css), so the bar is read in rem, not px.
          const rem = await page.evaluate(
            () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 16,
          );
          expect(box?.height ?? 0, 'the preview is tall enough to read').toBeGreaterThanOrEqual(
            100 * rem,
          );
        }

        // The tool is its own choice, on any board (ADR-0041): three cards.
        expect(await page.locator('[data-testid^="tool-"]').count()).toBe(3);

        // Every colour is offered on every board except the board's own,
        // which is disabled rather than hidden: a whiteboard by day refuses
        // white, a blackboard at night refuses black.
        const own = theme === 'light' ? 'white' : 'black';
        await expect(page.getByTestId(`ink-${own}`)).toBeDisabled();
        expect(await page.locator('[data-testid^="ink-"][disabled]').count()).toBe(1);

        // The dots are one row: every dot's top edge is the first dot's top edge.
        const tops = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="ink-"]')].map((el) =>
            Math.round(el.querySelector('span')?.getBoundingClientRect().top ?? -1),
          ),
        );
        expect(tops.length, 'no colour dots on the page').toBeGreaterThan(1);
        expect(new Set(tops).size, `dot tops: ${tops.join(', ')}`).toBe(1);

        // The whole page: the colour row and the theme switch sit below the fold.
        await page.waitForTimeout(700);
        await page.screenshot({
          path: join(SCREENS, `settings-${theme}-${vp.name}.png`),
          fullPage: true,
        });
      }
    });
  });
}
