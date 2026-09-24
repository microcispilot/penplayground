import { expect, test } from '@playwright/test';
import { endSession, startLesson, UI_WEB, waitForInk } from './ui-helpers.js';

/**
 * The board is the player (ADR-0045): a saved session plays in place from
 * the watch page, a press on the board pauses and resumes it, and Full view
 * takes the player to the whole viewport and back.
 */
test('a saved session plays in place, pauses on a press, and has a full view', async ({
  page,
  browser,
}) => {
  await startLesson(page);
  await waitForInk(page);
  await page.waitForTimeout(3_000);
  const id = await endSession(page);
  expect(id).toBeTruthy();

  // A visitor, a fresh anonymous participant, opens the saved page directly:
  // the board with one play button, no Replay anywhere.
  const other = await browser.newContext({ permissions: ['microphone'] });
  const visitor = await other.newPage();
  await visitor.setViewportSize({ width: 1280, height: 900 });
  await visitor.goto(`${UI_WEB}/sessions/${id}`);
  await expect(visitor.getByTestId('player-play')).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Replay' })).toHaveCount(0);

  // Press play: the lesson again, live, in the same box; the URL does not change.
  await visitor.getByTestId('player-play').click();
  await expect(visitor.getByTestId('session-player')).toBeVisible({ timeout: 30_000 });
  expect(new URL(visitor.url()).pathname).toContain(`/sessions/${id}`);
  await expect(visitor.locator('[data-testid="player"] .pen-board')).toBeVisible({
    timeout: 45_000,
  });
  // The page is still the watch page around it.
  await expect(visitor.getByTestId('comments')).toBeVisible();
  await expect(visitor.getByTestId('session-description')).toBeVisible();

  // A press on the board pauses; another resumes.
  const press = visitor.getByTestId('board-press');
  await expect(press).toBeVisible({ timeout: 30_000 });
  await press.click();
  await expect(visitor.getByTestId('room-status-label')).toContainText('Paused', {
    timeout: 15_000,
  });
  await press.click();
  await expect(visitor.getByTestId('room-status-label')).not.toContainText('Paused', {
    timeout: 15_000,
  });

  // Full view: the player alone, the whole viewport; Escape brings the page back.
  await visitor.getByTestId('fullscreen-toggle').click();
  await expect(visitor.getByTestId('player')).toHaveAttribute('data-full', 'true');
  const box = await visitor.getByTestId('player').boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(1270);
  expect(box?.height).toBeGreaterThanOrEqual(890);
  await visitor.keyboard.press('Escape');
  await expect(visitor.getByTestId('player')).toHaveAttribute('data-full', 'false');
  await expect(visitor.getByTestId('comments')).toBeVisible();

  await other.close();
});
