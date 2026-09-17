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
