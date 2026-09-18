import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * A lesson in Persian, end to end: the topic is typed in Persian, the fake
 * model teaches in Persian, and the page has to behave like it — `<html lang>`
 * follows the session, and every piece of the lesson's own text (captions, the
 * pinned note, the recap, the transcript) reads right to left.
 *
 * The screenshots are what the report shows.
 */
const SCREENS_DIR = join(process.cwd(), '..', '..', '.pen-data', 'screens');
const TOPIC = 'ترنسفورمرها در مدل‌های زبانی چطور کار می‌کنند';
const QUESTION = 'چرا بر جذر d تقسیم می‌کنیم؟';
/** Any Persian/Arabic letter: proof the text on screen is the lesson's, not a fallback. */
const PERSIAN = /[؀-ۿ]/;

test.describe('a session taught in Persian', () => {
  test('room and saved page follow the language and read right to left', async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(SCREENS_DIR, { recursive: true });

    await page.goto('/');
    await page.getByLabel('What do you want to learn?').fill(TOPIC);
    await page.getByRole('button', { name: 'Start', exact: true }).click();

    // The room opens and the expert starts teaching in Persian.
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    // The lesson's own words now live in the session panel's conversation
    // (ADR-0019); the board keeps its caption for when the panel is folded
    // away, and that is asserted from the same element either way.
    const said = page.getByTestId('conversation');
    await expect(said).toContainText(PERSIAN, { timeout: 30_000 });

    // The document speaks Persian; what was said reads right to left.
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('fa-IR');
    await expect(said).toHaveAttribute('dir', 'rtl');
    await expect(said).toHaveAttribute('lang', 'fa-IR');
    // Right to left is what the browser actually computed, not just an attribute we set.
    expect(await said.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');

    // Folded away, the board says it instead — and says it the same way.
    await page.getByTestId('session-panel-toggle').click();
    const caption = page.locator('[data-caption-box] [aria-live="polite"]').first();
    await expect(caption).toHaveAttribute('dir', 'rtl', { timeout: 30_000 });
    await expect(caption).toHaveAttribute('lang', 'fa-IR');
    await page.getByTestId('session-panel-toggle').click();
    await expect(said).toBeVisible();

    // The board writes Persian too: the title is drawn as one joined, right-to-left run.
    const boardTitle = page.locator('svg text[direction="rtl"]').first();
    await expect(boardTitle).toBeVisible({ timeout: 30_000 });
    expect(await boardTitle.textContent()).toMatch(PERSIAN);
    await page.screenshot({ path: join(SCREENS_DIR, 'persian-room.png') });

    // A Persian question pins a Persian note card on the board.
    await page.getByLabel('Ask a question').fill(QUESTION);
    await page.getByTestId('composer-send').click();
    const note = page.locator('.pen-note').first();
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toHaveAttribute('dir', 'rtl');
    await expect(note).toHaveAttribute('lang', 'fa-IR');
    expect(await note.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    expect(await note.locator('.pen-note__question').innerText()).toMatch(PERSIAN);

    await page.screenshot({ path: join(SCREENS_DIR, 'persian-note.png') });

    // The recap panel, which is the lesson's own words, reads right to left too.
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 30_000 });
    const recapTitle = page.locator('h3[dir="rtl"]').first();
    await expect(recapTitle).toBeVisible();
    expect(await recapTitle.innerText()).toMatch(PERSIAN);
    await page.screenshot({ path: join(SCREENS_DIR, 'persian-recap.png') });

    // The saved page keeps the language and the direction.
    await page.getByRole('button', { name: 'Open the saved session' }).click();
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('fa-IR');
    const heading = page.getByRole('heading', { level: 2 }).first();
    await expect(heading).toHaveAttribute('dir', 'rtl');
    const recapList = page.locator('ul[dir="rtl"]').first();
    await expect(recapList).toBeVisible({ timeout: 20_000 });
    expect(await recapList.innerText()).toMatch(PERSIAN);
    // The transcript decides direction per line: the expert's Persian lines read right to left.
    await page.getByRole('tab', { name: 'Transcript' }).click();
    const line = page.locator('span[dir="auto"]').filter({ hasText: PERSIAN }).first();
    await expect(line).toBeVisible({ timeout: 20_000 });
    expect(await line.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await page.getByRole('tab', { name: 'Recap' }).click();
    await page.screenshot({ path: join(SCREENS_DIR, 'persian-session.png'), fullPage: true });

    // Back in English, the document says so again.
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en');
  });
});
