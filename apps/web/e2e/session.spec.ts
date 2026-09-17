import { expect, test } from '@playwright/test';

test.describe('a learner starts a session', () => {
  test('home → live room → captions → typed question → end → saved session', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /What do you want to/ })).toBeVisible();
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();

    // The room opens live (prepared topic) and the expert starts speaking.
    await expect(page.getByText('Live session')).toBeVisible({ timeout: 20_000 });
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
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByText('keeps the dot products', { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // Host ends the session → recap panel → saved session page.
    await page.getByRole('button', { name: 'End' }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open the saved session' }).click();
    await expect(page.getByRole('heading', { name: /Transformers/ })).toBeVisible();
    await page.getByRole('button', { name: 'Transcript' }).click();
    await expect(page.getByText('square root of d', { exact: false })).toBeVisible();
  });
});
