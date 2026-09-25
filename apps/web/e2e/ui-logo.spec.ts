import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { SCREENS, UI_WEB, useTheme, VIEWPORTS } from './ui-helpers.js';

/**
 * The mark, on the product, in both themes and at all three widths.
 *
 * The artwork the owner supplied is a single black — #000000 for the
 * lettering and both strokes — which is 21:1 on a white page and 1.27:1 on
 * `surface-container` in dark. Shipped as drawn it is a logo that half the
 * product cannot see, and no unit test catches that: the file is valid, the
 * component renders, the pixels are simply not there. So the guarantee is
 * made here, in a browser, against the computed colour the mark actually
 * takes and the contrast it actually reaches.
 *
 * What the mark is *painted with* moved in the current drawing, and reading it
 * the old way would have quietly turned this file into a test of nothing. The
 * two diagonals are no longer filled quadrilaterals: they are open curves with
 * `fill: none` and the ink on their `stroke`. A check that collected
 * `getComputedStyle(path).fill` would have come back with `none` for both of
 * them and a colour only for the lettering — still one ink, still passing,
 * while the strokes themselves went unchecked. So both painted properties are
 * collected, and `none` is dropped rather than counted as a colour.
 *
 * Three things are checked, and each one is a way the mark has already been
 * got wrong somewhere:
 *
 *   · the ink follows the theme, so the lockup is legible on both grounds;
 *   · the delta does *not* — it is `mark-accent`, the brand #8A1A41, the same
 *     hex in light and dark by the owner's ruling, and never the ink's colour,
 *     or the mark would be a silhouette;
 *   · the artwork's aspect is intact, because a mark is easy to squash and
 *     nobody notices in a diff.
 *
 *   pnpm --filter @pen/web exec playwright test e2e/ui-logo.spec.ts --project=chromium
 *
 * Output: `.pen-data/screens/logo-<screen>-<theme>-<viewport>.png`.
 */

/** `--color-mark-accent`: the brand, the one colour in the mark that does not move. */
const BRAND = 'rgb(138, 26, 65)';

const THEMES = ['light', 'dark'] as const;

/** sRGB relative luminance, for the contrast the ink actually reaches. */
function contrast(a: string, b: string): number {
  const lum = (css: string): number => {
    const [r = 0, g = 0, bl = 0] = (/rgba?\(([^)]+)\)/.exec(css)?.[1] ?? '0,0,0')
      .split(',')
      .slice(0, 3)
      .map((v) => Number(v.trim()) / 255);
    const d = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * d(r) + 0.7152 * d(g) + 0.0722 * d(bl);
  };
  const [x, y] = [lum(a), lum(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The header's lockup, and the ground it is drawn on. Addressed through the
 * home button's own label rather than `header svg`, which finds the hamburger
 * — hidden at desktop width, so that selector fails in a way that looks like
 * the mark is missing.
 */
const HOME = '[aria-label="Pen Playground home"]';

async function lockup(page: Page) {
  const svg = page.locator(`${HOME} svg`).first();
  await expect(svg).toBeVisible();
  return page.evaluate((home) => {
    const el = document.querySelector(`${home} svg`);
    if (!el) throw new Error('the header has no mark');
    // Both painted properties, minus the ones painting nothing. The delta is
    // a fill, the diagonals are strokes, and the lettering is both.
    const paths = [...el.querySelectorAll('path')].flatMap((p) => {
      const s = getComputedStyle(p);
      return [s.fill, s.stroke].filter((c) => c && c !== 'none');
    });
    const box = el.getBoundingClientRect();
    // The nearest ancestor that actually paints, which is what the ink is read against.
    let node: HTMLElement | null = el.parentElement;
    let ground = 'rgba(0, 0, 0, 0)';
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        ground = bg;
        break;
      }
      node = node.parentElement;
    }
    return {
      fills: paths,
      ground,
      width: box.width,
      height: box.height,
      viewBox: el.getAttribute('viewBox'),
    };
  }, HOME);
}

test.describe('the mark', () => {
  for (const theme of THEMES) {
    test(`${theme}: the ink follows the page and the delta does not`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto(`${UI_WEB}/`);
      const { fills, ground } = await lockup(page);

      // The delta: one fill, the brand, the same hex in both themes.
      const brand = fills.filter((f) => f === BRAND);
      expect(brand, `the header mark has no ${BRAND} delta in ${theme}`).toHaveLength(1);

      // The ink: everything else, and it has to be a single resolved colour
      // that a person can see against the bar it sits on. 3:1 is WCAG 1.4.11 —
      // the mark is a graphic, not text.
      const ink = fills.filter((f) => f !== BRAND);
      // Eight: the lettering filled and stroked (3 + 3), and the two diagonals
      // stroked. A drop to three would mean the strokes stopped being painted.
      expect(ink).toHaveLength(8);
      expect(new Set(ink).size, 'the lettering and the strokes are one ink').toBe(1);
      const measured = contrast(ink[0] ?? '', ground);
      expect(
        measured,
        `the mark is ${measured.toFixed(2)}:1 against ${ground} in ${theme}`,
      ).toBeGreaterThanOrEqual(3);
    });
  }

  test('the ink is a different colour in each theme, and the delta is not', async ({ page }) => {
    await useTheme(page, 'light');
    await page.goto(`${UI_WEB}/`);
    const light = await lockup(page);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await lockup(page);

    const inkOf = (f: string[]) => f.filter((x) => x !== BRAND)[0];
    expect(inkOf(light.fills)).not.toBe(inkOf(dark.fills));
    expect(light.fills.filter((f) => f === BRAND)).toEqual(dark.fills.filter((f) => f === BRAND));
  });

  test('the lockup keeps the artwork aspect', async ({ page }) => {
    await page.goto(`${UI_WEB}/`);
    const { width, height, viewBox } = await lockup(page);
    const [, , vw = 1, vh = 1] = (viewBox ?? '').split(/\s+/).map(Number);
    // A logo is trivially squashed and nobody sees it in a diff.
    expect(width / height).toBeCloseTo(vw / vh, 2);
  });
});

/**
 * The pictures. Not assertions — the owner's call — but taken the one way that
 * makes them worth looking at: the same page, the same state, only the theme
 * and the width moving between shots.
 */
test.describe('the review', () => {
  for (const { name, width, height } of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`${name} ${theme}`, async ({ page }) => {
        mkdirSync(SCREENS, { recursive: true });
        await page.setViewportSize({ width, height });
        await useTheme(page, theme);

        await page.goto(`${UI_WEB}/`);
        await expect(page.locator(`${HOME} svg`).first()).toBeVisible();
        await page.waitForTimeout(700);
        // The header and the footer are where the mark lives on a page.
        await page.screenshot({ path: join(SCREENS, `logo-home-${theme}-${name}.png`) });

        // 404 puts the icon alone in a tile at 28 px, which is the smallest
        // the mark is drawn anywhere in the product.
        await page.goto(`${UI_WEB}/nothing-here`);
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(SCREENS, `logo-404-${theme}-${name}.png`) });
      });
    }
  }

  test('the drawer, where the lockup carries the name', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useTheme(page, 'dark');
    await page.goto(`${UI_WEB}/`);
    const menu = page.getByRole('button', { name: /menu|sections/i }).first();
    if ((await menu.count()) > 0) {
      await menu.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(SCREENS, 'logo-drawer-dark-iphone.png') });
      // The drawer has no header above it, so this is the one mark that is
      // named rather than decorative.
      await expect(page.getByRole('img', { name: 'Pen Playground' })).toBeVisible();
    }
  });
});
