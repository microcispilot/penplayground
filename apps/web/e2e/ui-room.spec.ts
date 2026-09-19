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
const DOCK_WIDTH = 1024;

async function boardWidth(page: Page): Promise<number> {
  return (await page.locator('.pen-board').boundingBox())?.width ?? 0;
}

async function checkSize(page: Page, vp: (typeof VIEWPORTS)[number], theme: Theme) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  // Let the resize observers and the board camera settle.
  await page.waitForTimeout(600);
  const docked = vp.width >= DOCK_WIDTH;

  // Nothing may push the page sideways at any size.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${vp.name} overflows horizontally`).toBeLessThanOrEqual(0);

  const panel = page.getByTestId('session-panel');
  if (docked) {
    // The panel is part of the layout, and the board still has the larger half.
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(panel).toHaveAttribute('data-mode', 'docked');
    await expect(page.getByTestId('conversation')).toBeVisible();
    expect(await boardWidth(page)).toBeGreaterThan(vp.width * 0.5);
  } else {
    // Too narrow to dock: the board keeps the whole width until it is asked for.
    await expect(panel).toBeHidden();
    expect(await boardWidth(page)).toBeGreaterThan(vp.width * 0.85);
  }
  const board = await page.locator('.pen-board').boundingBox();
  expect(board?.height ?? 0).toBeGreaterThan(vp.height * 0.45);

  // The microphone is always reachable, and is a real touch target on a phone.
  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toBeVisible();
  const micBox = await mic.boundingBox();
  expect(micBox?.width ?? 0).toBeGreaterThanOrEqual(vp.name === 'iphone' ? 44 : 32);

  // The AI human lives in the panel now, not over the board — so with the
  // panel up the board carries no caption (the conversation is the record),
  // and the board never has an orb painted on it at any size.
  await expect(page.locator('#room-board [data-presence]')).toHaveCount(0);
  if (docked) await expect(page.locator('[data-caption-box]')).toHaveCount(0);

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

    // The panel comes over the board as a drawer, and takes focus with it.
    await page.getByTestId('panel-toggle').click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-mode', 'drawer');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('roster-cards')).toBeVisible();
    await shot(page, `room-${vp.name}-${theme}-panel`);
    // Everyone on the call, from the panel's own overflow control.
    await page.getByTestId('participants-toggle').click();
    await expect(page.getByTestId('participants-toggle')).toHaveAttribute('aria-expanded', 'true');
    await shot(page, `room-${vp.name}-${theme}-participants`);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  } else {
    // From the tablet up the pace control is in the bar itself.
    await expect(page.getByTestId('pace-pill')).toBeVisible();
  }

  if (docked) {
    // Folding the panel from the chevron on its own edge gives the board the
    // rest of the screen, and leaves that one control behind to bring it back.
    const wide = await boardWidth(page);
    await page.getByTestId('session-panel-toggle').click();
    await page.waitForTimeout(500);
    await expect(panel).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('conversation')).toHaveCount(0);
    expect(await boardWidth(page)).toBeGreaterThan(wide);
    expect(await boardWidth(page)).toBeGreaterThan(vp.width * 0.9);
    // …and with the panel gone the board says what was said again.
    await expect(page.getByTestId('session-panel-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await shot(page, `room-${vp.name}-${theme}-collapsed`);
    await page.getByTestId('session-panel-toggle').click();
    await page.waitForTimeout(500);
    await expect(panel).toHaveAttribute('data-open', 'true');
  }

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
