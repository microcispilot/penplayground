import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { endSession, startLesson, UI_WEB, waitForInk } from './ui-helpers.js';

/**
 * The accessibility floor, enforced rather than described. axe-core runs on
 * every screen a learner meets; anything it flags at serious or critical is a
 * failure, not a note.
 *
 * tldraw's own canvas is excluded: it is a third-party drawing surface we
 * render with the UI hidden, and the teaching content it paints reaches a
 * screen reader through the captions, which are a live region.
 */
async function scan(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('.tl-canvas')
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const detail = serious
    .map(
      (v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.help}\n    ${v.nodes[0]?.html ?? ''}`,
    )
    .join('\n  ');
  expect(serious, `${name} has accessibility violations:\n  ${detail}`).toEqual([]);
  return results;
}

test.describe('accessibility', () => {
  test.setTimeout(240_000);

  test('Explore has no serious violations', async ({ page }) => {
    await page.goto(`${UI_WEB}/`);
    await expect(page.getByRole('heading', { name: /What do you want to/ })).toBeVisible();
    await scan(page, 'Home');
  });

  test('the live room has no serious violations, and the board is reachable by keyboard', async ({
    page,
  }) => {
    await startLesson(page);
    await waitForInk(page);
    await scan(page, 'Room');

    // A skip link is the first thing a keyboard reaches, and it lands on the board.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the board' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page.locator('#room-board')).toBeFocused();

    // Every control in the bar is named.
    for (const name of ['Captions', 'Full screen']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // The room's status is a polite live region, so a change is announced once.
    await expect(page.locator('[data-status]')).toHaveAttribute('aria-live', 'polite');
  });

  test('the saved session and its replay have no serious violations', async ({ page }) => {
    await startLesson(page);
    await waitForInk(page);
    await page.waitForTimeout(5_000);
    const id = await endSession(page);
    await scan(page, 'SessionPage');

    await page.goto(`${UI_WEB}/replay/${id}`);
    await page.getByRole('button', { name: 'Play the session' }).click();
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await scan(page, 'Replay');

    // The scrubber is a real slider for assistive technology.
    const track = page.getByTestId('scrubber-track');
    await expect(track).toHaveAttribute('role', 'slider');
    await expect(track).toHaveAttribute('aria-label', 'Seek');
  });

  test('reduced motion is respected on the room', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await startLesson(page);
    // The design system collapses every animation to a hair under a frame.
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .slice(0, 400)
        .map((el) => getComputedStyle(el).animationDuration)
        .filter((d) => d !== '0s' && d !== ''),
    );
    for (const d of durations) expect(Number.parseFloat(d)).toBeLessThan(0.01);
    await ctx.close();
  });
});
