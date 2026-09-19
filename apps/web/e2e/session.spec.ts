import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** Git-ignored: `.pen-data*` holds runtime data and, here, the screenshots the report describes. */
const SCREENS_DIR = join(process.cwd(), '..', '..', '.pen-data', 'screens');

test.describe('a learner starts a session', () => {
  test('home → live room → captions → typed question → end → saved session → insights', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /What do you want to/ })).toBeVisible();
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();

    // The room opens live (prepared topic) and the expert starts speaking.
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Let's start with a sentence", { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // The host opens the pace menu and picks 1.3×: the room broadcasts the new pace and the pill follows.
    const pill = page.getByTestId('pace-pill');
    await expect(pill).toHaveText(/^1×/);
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    await pill.click();
    const menu = page.getByRole('group', { name: 'Pace' });
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('pace-option-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('pace-option-1.3')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('pace-option-1.3').click();
    await expect(menu).toBeHidden();
    await expect(pill).toHaveText(/^1\.3×/);
    await expect(pill).toHaveAttribute('aria-label', 'Pace: 1.3×');
    // Reopen: the broadcast state marks 1.3× as the pressed preset; Escape closes and returns focus.
    await pill.click();
    await expect(page.getByTestId('pace-option-1.3')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(pill).toBeFocused();
    // The choice is remembered for the next hosted session.
    expect(await page.evaluate(() => localStorage.getItem('pen.pace'))).toBe('1.3');

    // A typed question interrupts; the acknowledgement and answer arrive; the lesson resumes.
    await page.getByLabel('Ask a question').fill('Why do we divide by the square root of d?');
    await page.getByTestId('composer-send').click();
    await expect(page.getByText('keeps the dot products', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // A couple of interactions the ledger must carry.
    await page.getByRole('button', { name: 'Captions' }).click();
    await page.getByRole('button', { name: 'Captions' }).click();

    // Host ends the session → recap panel → saved session page.
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open the saved session' }).click();
    await expect(page.getByRole('heading', { name: /Transformers/ })).toBeVisible();
    // The sketch drawn in the background (ADR-0013) replaces the placeholder without a reload.
    const thumb = page.getByTestId('session-thumb').first();
    // The card's picture, by the session's own route. The file extension is a
    // delivery detail and has already moved once (svg to png when thumbnails
    // became photographs); what this test owns is that the card shows the
    // session's generated picture at all.
    await expect(thumb.locator('img')).toHaveAttribute(
      'src',
      /\/api\/sessions\/[^/]+\/thumb\.\w+$/,
      { timeout: 20_000 },
    );
    await expect(thumb).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
    await page.getByRole('tab', { name: 'Transcript' }).click();
    await expect(page.getByText('square root of d', { exact: false })).toBeVisible();

    // Insights (host only): latency cards, cost, reuse, the stage timeline, interactions, errors.
    await page.getByRole('tab', { name: 'Insights' }).click();
    const insights = page.getByTestId('insights');
    await expect(insights).toBeVisible({ timeout: 15_000 });
    await expect(insights.getByText('Time to first audio')).toBeVisible();
    await expect(insights.getByText('Question → answer')).toBeVisible();
    await expect(page.getByTestId('insights-total-usd')).toContainText('$');
    await expect(insights.getByText('Model', { exact: true }).first()).toBeVisible();
    await expect(insights.getByText('Voice', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('insights-reuse')).toContainText('Knowledge pack reused');
    await expect(insights.getByText('Typed a question')).toBeVisible();
    await expect(insights.getByText('Captions off')).toBeVisible();
    await expect(insights.getByText('First audio heard')).toBeVisible();
    await expect(insights.getByText('Nothing went wrong.')).toBeVisible();
    // The timeline has bars for the model and the voice.
    await expect(insights.getByRole('button', { name: /^Model at/ }).first()).toBeVisible();
    await expect(insights.getByRole('button', { name: /^Voice at/ }).first()).toBeVisible();

    mkdirSync(SCREENS_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENS_DIR, 'insights.png'), fullPage: true });
  });
});
