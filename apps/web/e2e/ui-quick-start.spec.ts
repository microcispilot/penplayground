import { expect, test } from '@playwright/test';
import {
  endSession,
  shot,
  startLesson,
  UI_WEB,
  useTheme,
  VIEWPORTS,
  waitForInk,
} from './ui-helpers.js';

/**
 * Replay is a fresh session of your own, and a recording is its host's
 * (ADR-0035), as a learner meets them.
 *
 * The host's saved page carries Replay, Watch my recording and the download
 * with its choice; a visitor's page carries Replay and nothing of the host's
 * hour — no questions, no recording — and Replay puts them in a room of their
 * own. A free learner whose topic nobody has prepared is told so on Home,
 * with the lessons that are ready (ADR-0036). Pictures of each, light and
 * dark, at the three widths.
 */
test.describe('replay and the recording', () => {
  test.setTimeout(300_000);

  test('the host has the recording; a visitor has the lesson', async ({ page, browser }) => {
    await startLesson(page);
    await waitForInk(page);
    await page.waitForTimeout(4_000);
    const id = await endSession(page);
    expect(id).toBeTruthy();

    // The host's page: the board is the player, the recording, the download and its choice.
    await expect(page.getByTestId('player-play')).toBeVisible();
    await expect(page.getByTestId('session-watch-recording')).toBeVisible();
    // The pair's learner is on the free plan: the download is the locked
    // button that leads to Pricing, and the choice of recording comes with
    // the plan (the two variants are proved in services/api/test/features.test.ts).
    await expect(page.getByRole('button', { name: 'Download · Standard' })).toBeVisible();
    await expect(page.getByTestId('export-variant')).toHaveCount(0);
    await expect(page.getByText('Questions you asked')).toBeVisible();
    await shot(page, 'session-page-host');

    // A visitor: a fresh browser context is a fresh anonymous participant.
    const other = await browser.newContext({ permissions: ['microphone'] });
    const visitor = await other.newPage();
    await visitor.goto(`${UI_WEB}/sessions/${id}`);
    await expect(visitor.getByTestId('player-play')).toBeVisible();
    await expect(visitor.getByTestId('session-watch-recording')).toHaveCount(0);
    await expect(visitor.getByTestId('export-control')).toHaveCount(0);
    await expect(visitor.getByText('Questions you asked')).toHaveCount(0);
    await expect(visitor.getByText('Questions asked')).toHaveCount(0);
    await shot(visitor, 'session-page-visitor');

    // The recording itself is refused to the visitor, kindly, with the way in.
    await visitor.goto(`${UI_WEB}/replay/${id}`);
    await expect(visitor.getByTestId('replay-start-own')).toBeVisible({ timeout: 20_000 });
    await expect(visitor.getByText('Play the session')).toHaveCount(0);
    await shot(visitor, 'replay-refused-visitor');

    // Replay puts the visitor in a room of their own on the same lesson.
    await visitor.getByTestId('replay-start-own').click();
    await visitor.waitForURL(/\/room\//, { timeout: 30_000 });
    const roomId = new URL(visitor.url()).pathname.split('/').pop() ?? '';
    expect(roomId).not.toBe(id);
    await expect(visitor.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await other.close();
  });

  test('a topic nobody has prepared is answered on Home with the lessons that are ready', async ({
    page,
  }) => {
    // The topic carries the clock: the pair's data directory outlives a run,
    // and a topic prepared once — by a spec, or by a deployment that allowed
    // it — is a hit for ever after, which is the opposite of the premise.
    // The UI pair's participants are visitors without an account, and its
    // deployment keeps `prepare_new_topics` off for them (ADR-0040): the
    // topic is a miss, Home says so, and the door is the account.
    await page.goto(`${UI_WEB}/`);
    await page
      .getByLabel('What do you want to learn?')
      .fill(`Reading an ECG strip, take ${Date.now()}`);
    // The server's own answer travels with the assertion, so a refusal of a
    // different kind is named rather than guessed at.
    const [refusal] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/sessions') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Start', exact: true }).click(),
    ]);
    expect(refusal.status(), await refusal.text()).toBe(402);
    const answer = page.getByTestId('home-unprepared');
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(answer).toContainText('Nobody has prepared that topic yet');
    await expect(answer.getByTestId('home-sign-in')).toBeVisible();
    await answer.getByTestId('home-sign-in').click();
    await expect(page.getByTestId('auth-email')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
    await shot(page, 'home-unprepared');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the saved page and the answer on Home, ${theme}, at every width`, async ({ page }) => {
      await useTheme(page, theme);
      await startLesson(page);
      await waitForInk(page);
      const id = await endSession(page);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${UI_WEB}/sessions/${id}`);
        await expect(page.getByTestId('player-play')).toBeVisible();
        await shot(page, `session-page-host-${viewport.name}-${theme}`);
        await page.goto(`${UI_WEB}/`);
        await page
          .getByLabel('What do you want to learn?')
          .fill(`Reading an ECG strip, take ${Date.now()}`);
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.getByTestId('home-unprepared')).toBeVisible({ timeout: 20_000 });
        await shot(page, `home-unprepared-${viewport.name}-${theme}`);
      }
    });
  }
});
