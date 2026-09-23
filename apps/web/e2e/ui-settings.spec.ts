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
          expect(box?.height ?? 0, 'the preview is tall enough to read').toBeGreaterThanOrEqual(
            100,
          );
        }

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
