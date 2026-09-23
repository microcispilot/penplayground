import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The Features console in a real browser (ADR-0036): the matrix reads, a
 * click on a cell and on a header changes what resolves, a save carries a
 * reason, nothing throws — and the review pictures, light and dark,
 * populated and with nothing decided, at the review width and on a phone.
 *
 *   pnpm --filter @pen/admin e2e
 *
 * Output: `.pen-data/admin-review/12-features-<state>-<theme>.png`,
 * `13-features-<width>-<theme>.png`.
 */
const SHOTS = resolve(process.cwd(), '../../.pen-data/admin-review');
const FIXTURE = `http://127.0.0.1:${process.env.PEN_ADMIN_FIXTURE_PORT ?? '4210'}`;
const WIDTH = 1440;
const HEIGHT = 900;

mkdirSync(SHOTS, { recursive: true });

async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('pen.theme', value as string);
    } catch {
      /* the boot script falls back to system, which is light */
    }
  }, theme);
}

async function useFixture(request: APIRequestContext, mode: 'full' | 'empty'): Promise<void> {
  const res = await request.post(`${FIXTURE}/__fixture/${mode}`);
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ mode });
}

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  return problems;
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByTestId('features-overview')).toBeVisible();
  await expect(page.getByTestId('features-loading')).toHaveCount(0);
  await page.waitForTimeout(260);
}

test.describe('the features console', () => {
  test('reads the matrix, moves a cell and a header, and saves with a reason', async ({
    page,
    request,
  }) => {
    await useFixture(request, 'full');
    const problems = watchConsole(page);
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.goto('/features');
    await settle(page);

    // The deployment's own decision is drawn: free on the web is on, free on iOS is not.
    const freeWeb = page.getByTestId('feature-prepare_new_topics-cell-free-web');
    await expect(freeWeb).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('feature-prepare_new_topics-cell-free-ios')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByTestId('feature-prepare_new_topics')).toContainText('Set here');

    // A platform head answers for its whole column.
    await page.getByTestId('feature-ads-platform-web').click();
    await page.getByTestId('feature-ads-platform-web').click();
    await expect(page.getByTestId('feature-ads-cell-free-web')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByTestId('feature-ads')).toContainText('Unsaved');

    const save = page.getByTestId('save-features');
    await expect(save).toBeDisabled();
    await page.getByTestId('features-save-reason').fill('No ads on the web this week.');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('features-notice')).toContainText('Saved as revision');
    expect(problems).toEqual([]);
  });

  test('nothing scrolls the page sideways at a phone width', async ({ page, request }) => {
    await useFixture(request, 'full');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/features');
    await settle(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the review pictures, ${theme}`, async ({ page, request }) => {
      await useTheme(page, theme);
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await useFixture(request, 'full');
      await page.goto('/features');
      await settle(page);
      await page.screenshot({ path: `${SHOTS}/12-features-full-${theme}.png`, fullPage: true });

      await useFixture(request, 'empty');
      await page.goto('/features');
      await settle(page);
      await expect(page.getByTestId('features-history-empty')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/12-features-empty-${theme}.png`, fullPage: true });

      await useFixture(request, 'full');
      for (const [label, width, height] of [
        ['tablet', 834, 1112],
        ['phone', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto('/features');
        await settle(page);
        await page.screenshot({
          path: `${SHOTS}/13-features-${label}-${theme}.png`,
          fullPage: true,
        });
      }
    });
  }
});
