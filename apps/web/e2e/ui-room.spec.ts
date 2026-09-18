import { expect, test } from '@playwright/test';
import { shot, startLesson, type Theme, useTheme, VIEWPORTS, waitForInk } from './ui-helpers.js';

/**
 * The live room on a small laptop, an iPad in portrait and a phone, in both
 * themes. Each size asserts the reflow it is responsible for and leaves a
 * screenshot in `.pen-data/screens/` for the review.
 */
test.describe('the room fits the screen it is on', () => {
  test.setTimeout(180_000);

  for (const vp of VIEWPORTS) {
    for (const theme of ['light', 'dark'] as Theme[]) {
      test(`${vp.name} ${vp.width}×${vp.height} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await useTheme(page, theme);
        await startLesson(page);
        await waitForInk(page);

        // Nothing may push the page sideways at any size.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        // The board keeps the room: it is the tallest thing on the screen.
        const board = await page.locator('.pen-board').boundingBox();
        expect(board?.width ?? 0).toBeGreaterThan(vp.width * 0.8);
        expect(board?.height ?? 0).toBeGreaterThan(vp.height * 0.45);

        // The microphone is always reachable, and is a real touch target on a phone.
        const mic = page.getByTestId('mic-toggle');
        await expect(mic).toBeVisible();
        const micBox = await mic.boundingBox();
        expect(micBox?.width ?? 0).toBeGreaterThanOrEqual(vp.name === 'iphone' ? 44 : 32);

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
        } else {
          // From the tablet up the pace control is in the bar itself.
          await expect(page.getByTestId('pace-pill')).toBeVisible();
        }

        // The orb gives the board its room back as the screen narrows.
        const orb = page.getByRole('img', { name: /, (idle|speaking|listening|thinking|paused)$/ });
        const orbBox = await orb.first().boundingBox();
        const expected = vp.width < 640 ? 52 : vp.width < 1024 ? 68 : 88;
        expect(Math.round(orbBox?.width ?? 0)).toBe(expected);

        // And the captions are never painted underneath it.
        const caption = page.locator('[data-caption-box]');
        if (await caption.isVisible().catch(() => false)) {
          const capBox = await caption.boundingBox();
          expect((capBox?.x ?? 0) + (capBox?.width ?? 0)).toBeLessThanOrEqual(orbBox?.x ?? 0);
        }

        await shot(page, `room-${vp.name}-${theme}`);
      });
    }
  }
});

test.describe('the participants popover fits the screen', () => {
  test.setTimeout(120_000);
  test('opens inside the viewport on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startLesson(page);
    await page.getByTestId('participants-toggle').click();
    const panel = page.getByRole('dialog', { name: 'Participants' });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await shot(page, 'room-iphone-participants');
  });
});
