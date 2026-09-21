import { expect, type Page, test } from '@playwright/test';
import { shot, startLesson, type Theme, useTheme, VIEWPORTS, waitForInk } from './ui-helpers.js';

/**
 * The live room on a small laptop, an iPad in portrait and a phone, in both
 * themes.
 *
 * One lesson per theme, resized through the three sizes: a room is an expensive
 * thing to boot, and resizing a *live* one is the stronger test anyway — it
 * proves the room reflows while the expert is mid-sentence, not just that it
 * renders correctly if you happen to load it at that width. Each size leaves a
 * screenshot in `.pen-data/screens/` for the review.
 */

/** Where the session panel is docked beside the board rather than drawn over it. */

async function boardWidth(page: Page): Promise<number> {
  return (await page.locator('.pen-board').boundingBox())?.width ?? 0;
}

async function checkSize(page: Page, vp: (typeof VIEWPORTS)[number], theme: Theme) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  // Let the resize observers and the board camera settle.
  await page.waitForTimeout(600);
  // Nothing may push the page sideways at any size.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${vp.name} overflows horizontally`).toBeLessThanOrEqual(0);

  /*
   * This is a solo session — one learner, one expert — so there is no panel
   * at any width (ADR-0033). A roster of two and a chat nobody else can read
   * are furniture pretending to be features, so the board keeps the whole
   * room and the expert is one tile over it.
   *
   * The docked/drawer behaviour the panel still has for a session *with*
   * guests is covered by `ui-panel.spec.ts`, which builds that roster.
   */
  await expect(page.getByTestId('session-panel')).toHaveCount(0);
  await expect(page.getByTestId('panel-toggle')).toHaveCount(0);
  // And nothing to react to, so no reaction control either.
  await expect(page.getByTestId('reaction-button')).toHaveCount(0);
  expect(await boardWidth(page)).toBeGreaterThan(vp.width * 0.85);

  // The expert is here, and says what they are doing: a voice-first lesson
  // with a silent expert and nothing on screen is indistinguishable from a
  // page that stopped loading.
  const soloExpert = page.getByTestId('solo-expert');
  await expect(soloExpert).toBeVisible();
  await expect(soloExpert).toHaveAttribute('data-presence', /idle|listening|thinking|speaking/);
  const soloBox = await soloExpert.boundingBox();
  const boardBox = await page.locator('.pen-board').boundingBox();
  // Over the board's lower corner, inside it, and small: it is a presence,
  // not a second panel.
  expect(soloBox?.width ?? 0, 'the tile does not take the room over').toBeLessThan(
    (boardBox?.width ?? 0) * 0.6,
  );
  const board = await page.locator('.pen-board').boundingBox();
  expect(board?.height ?? 0).toBeGreaterThan(vp.height * 0.45);

  // The microphone is always reachable, and is a real touch target on a phone.
  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toBeVisible();
  const micBox = await mic.boundingBox();
  expect(micBox?.width ?? 0).toBeGreaterThanOrEqual(vp.name === 'iphone' ? 44 : 32);

  // Nothing is painted *on* the paper: the solo tile sits over the board in
  // its own container, and no presence marker is drawn into the board
  // itself. And the board carries no caption either —
  // captions are off until the CC control turns them on, at every width and
  // whether the panel is up or folded away. (The hint line is not a caption:
  // it is guidance, and it has its own box.)
  // `.pen-board` is the paper itself; the solo tile is a sibling of it inside
  // the board's section, which is the difference between "over the board" and
  // "written on it".
  await expect(page.locator('.pen-board [data-presence]')).toHaveCount(0);
  await expect(page.getByTestId('caption')).toHaveCount(0);
  // `IconButton` only carries `aria-pressed` while it is on, so "off" is the
  // absence of it rather than the string "false".
  const cc = page.getByRole('button', { name: 'Captions', exact: true });
  if (await cc.isVisible().catch(() => false))
    await expect(cc).not.toHaveAttribute('aria-pressed', 'true');

  if (vp.name === 'iphone') {
    // Icon-only bar: the labelled controls live in a sheet.
    await expect(page.getByTestId('more-controls')).toBeVisible();
    await expect(page.getByTestId('pace-pill')).toBeHidden();
    await page.getByTestId('more-controls').click();
    const sheet = page.getByTestId('more-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Captions' })).toBeVisible();
    await expect(sheet.getByTestId('pace-pill')).toBeVisible();
    await shot(page, `room-${vp.name}-${theme}-sheet`);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // No drawer to open: see the solo note above. The pace control is what
    // the sheet is for on a phone, and it is there.
  } else {
    // From the tablet up the pace control is in the bar itself.
    await expect(page.getByTestId('pace-pill')).toBeVisible();
  }

  // Folding the panel is `ui-panel.spec.ts`'s: it needs a panel, and this
  // session does not have one.

  await shot(page, `room-${vp.name}-${theme}`);
}

test.describe('the room fits the screen it is on', () => {
  test.setTimeout(300_000);

  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`${theme}: 1024×768, iPad portrait and iPhone`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await useTheme(page, theme);
      await startLesson(page);
      await waitForInk(page);
      for (const vp of VIEWPORTS) await checkSize(page, vp, theme);
    });
  }
});
