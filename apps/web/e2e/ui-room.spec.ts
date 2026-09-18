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
async function checkSize(page: Page, vp: (typeof VIEWPORTS)[number], theme: Theme) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  // Let the resize observers and the board camera settle.
  await page.waitForTimeout(600);

  // Nothing may push the page sideways at any size.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${vp.name} overflows horizontally`).toBeLessThanOrEqual(0);

  // The board keeps the room: it is the biggest thing on the screen.
  const board = await page.locator('.pen-board').boundingBox();
  expect(board?.width ?? 0).toBeGreaterThan(vp.width * 0.8);
  expect(board?.height ?? 0).toBeGreaterThan(vp.height * 0.45);

  // The microphone is always reachable, and is a real touch target on a phone.
  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toBeVisible();
  const micBox = await mic.boundingBox();
  expect(micBox?.width ?? 0).toBeGreaterThanOrEqual(vp.name === 'iphone' ? 44 : 32);

  // The orb gives the board its room back as the screen narrows.
  const orb = page.getByRole('img', { name: /, (idle|speaking|listening|thinking|paused)$/ });
  const orbBox = await orb.first().boundingBox();
  const expectedOrb = vp.width < 640 ? 52 : vp.width < 1024 ? 68 : 88;
  expect(Math.round(orbBox?.width ?? 0)).toBe(expectedOrb);

  // And the captions are never painted underneath it.
  const caption = page.locator('[data-caption-box]');
  if (await caption.isVisible().catch(() => false)) {
    const capBox = await caption.boundingBox();
    expect((capBox?.x ?? 0) + (capBox?.width ?? 0)).toBeLessThanOrEqual(orbBox?.x ?? 0);
  }

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

    // The ask bar is a sheet, and the mic leads it.
    await page.getByRole('button', { name: 'Ask a question' }).click();
    await expect(page.getByTestId('ask-sheet')).toBeVisible();
    await expect(page.getByTestId('ask-mic')).toBeVisible();
    await shot(page, `room-${vp.name}-${theme}-ask`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ask-sheet')).toBeHidden();

    // The participants popover stays inside the screen.
    await page.getByTestId('participants-toggle').click();
    const panel = page.getByRole('dialog', { name: 'Participants' });
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(vp.width);
    await shot(page, `room-${vp.name}-${theme}-participants`);
    await page.keyboard.press('Escape');
  } else {
    // From the tablet up the pace control is in the bar itself.
    await expect(page.getByTestId('pace-pill')).toBeVisible();
  }

  await shot(page, `room-${vp.name}-${theme}`);
}

test.describe('the room fits the screen it is on', () => {
  test.setTimeout(240_000);

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
