import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * The statistics console, driven in a real browser (ADR-0027).
 *
 * Two jobs. It asserts the things a unit test cannot see — that the tabs
 * navigate, that the range control rewrites the URL and every page picks the
 * new window up, that nothing throws into the console — and it produces the
 * review pictures: every page, light and dark, populated and empty, at the
 * width the product bar is reviewed at.
 *
 *   pnpm --filter @pen/admin e2e
 *
 * Output: `.pen-data/admin-review/<nn>-<page>-<state>-<theme>.png`, named so
 * that the light and dark pair of one page sort next to each other and can
 * be flipped between.
 */

const SHOTS = resolve(process.cwd(), '../../.pen-data/admin-review');
const FIXTURE = `http://127.0.0.1:${process.env.PEN_ADMIN_FIXTURE_PORT ?? '4210'}`;

/** 1440 × 900: the width the product bar is reviewed at. */
const WIDTH = 1440;
const HEIGHT = 900;

const PAGES = [
  { n: '01', slug: '', name: 'overview' },
  { n: '02', slug: '/money', name: 'money' },
  { n: '03', slug: '/sessions', name: 'sessions' },
  { n: '04', slug: '/sessions/s_00_how', name: 'session-detail' },
  { n: '05', slug: '/pipeline', name: 'pipeline' },
  { n: '06', slug: '/people', name: 'people' },
  { n: '07', slug: '/people/p_000', name: 'person-detail' },
  { n: '08', slug: '/visits', name: 'visits' },
  { n: '09', slug: '/audience', name: 'audience' },
] as const;

/** The seven tabs; the two detail pages are reached from their lists. */
const TABBED = PAGES.filter((p) => !p.name.endsWith('detail'));

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

/** Every console error the page produced, so a spec can refuse to pass over one. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  return problems;
}

async function settle(page: Page): Promise<void> {
  // Every page renders a skeleton first; `report-body` is the answer. A page
  // may hold more than one report (Sessions holds two), so the wait is "one
  // has arrived and none is still loading" rather than "the first is here" —
  // otherwise a screenshot catches half a page.
  await expect(page.getByTestId('report-body').first()).toBeVisible();
  await expect(page.getByTestId('report-loading')).toHaveCount(0);
  // The design system transitions colour over --duration-base (200 ms).
  await page.waitForTimeout(260);
}

/**
 * Switch the fixture between a month of data and a fresh deployment, and
 * *check that it switched*. A silent failure here would photograph the
 * populated pages twice and call the second set the empty states.
 */
async function useFixture(request: APIRequestContext, mode: 'full' | 'empty'): Promise<void> {
  const answer = await request.post(`${FIXTURE}/__fixture/${mode}`);
  expect(answer.ok(), `the fixture API did not answer at ${FIXTURE}`).toBe(true);
  expect(await answer.json()).toEqual({ mode });
}

test.describe('the statistics console', () => {
  test.beforeEach(async ({ request }) => {
    await useFixture(request, 'full');
  });

  test('every page loads, with no error in the browser console', async ({ page }) => {
    const problems = watchConsole(page);
    for (const target of PAGES) {
      await page.goto(`/statistics${target.slug}`);
      await settle(page);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the tabs navigate and the nav no longer says “soon”', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('admin-nav')).not.toContainText('Soon');
    await page.getByTestId('admin-nav').getByRole('link', { name: 'Statistics' }).click();
    await expect(page).toHaveURL(/\/statistics$/);
    await settle(page);

    for (const label of ['Money', 'Sessions', 'Pipeline', 'People', 'Visits', 'Audience']) {
      await page.getByTestId('statistics-tabs').getByRole('link', { name: label }).click();
      await settle(page);
      await expect(page).toHaveURL(new RegExp(`/statistics/${label.toLowerCase()}`));
    }
  });

  test('the range control rewrites the URL and the pages follow it', async ({ page }) => {
    await page.goto('/statistics/money');
    await settle(page);
    const before = await page.getByTestId('range-summary').textContent();

    await page.getByTestId('range-7d').click();
    await expect(page).toHaveURL(/range=7d/);
    await settle(page);
    expect(await page.getByTestId('range-summary').textContent()).not.toBe(before);

    // The bucket selector only appears where a page reads it, and it is
    // carried in the URL beside the range.
    await page.getByTestId('range-bucket').selectOption('week');
    await expect(page).toHaveURL(/bucket=week/);
    await settle(page);

    // Moving to another tab keeps the window: two pages must never describe
    // different periods at the same time.
    await page.getByTestId('statistics-tabs').getByRole('link', { name: 'Visits' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page).toHaveURL(/bucket=week/);
  });

  test('a lesson’s page names the searches it was reused for', async ({ page }) => {
    await page.goto('/statistics/sessions');
    await settle(page);
    await page
      .getByRole('link', { name: /Photosynthesis/ })
      .first()
      .click();
    await settle(page);
    await expect(page.getByTestId('reuse-searches')).toContainText('why are leaves green');
    await expect(page.getByText(/Reused by/)).toBeVisible();
  });

  test('the geography table keeps the region and city rows and says why they are empty', async ({
    page,
  }) => {
    await page.goto('/statistics/audience');
    await settle(page);
    await expect(page.getByRole('columnheader', { name: 'Region' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'City' })).toBeVisible();
    await expect(page.getByText('Not available').first()).toBeVisible();
    await expect(page.getByText(/no geo-IP is configured/)).toBeVisible();
  });

  test('nothing scrolls the page sideways at a phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const target of TABBED) {
      await page.goto(`/statistics${target.slug}`);
      await settle(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${target.name} overflows by ${overflow}px at 390`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('the review pictures', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`every page, populated, ${theme}`, async ({ page, request }) => {
      await useFixture(request, 'full');
      await useTheme(page, theme);
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      for (const target of PAGES) {
        await page.goto(`/statistics${target.slug}`);
        await settle(page);
        await page.screenshot({
          path: `${SHOTS}/${target.n}-${target.name}-full-${theme}.png`,
          fullPage: true,
        });
      }
    });

    test(`every page, with nothing in it yet, ${theme}`, async ({ page, request }) => {
      await useFixture(request, 'empty');
      await useTheme(page, theme);
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      for (const target of TABBED) {
        await page.goto(`/statistics${target.slug}`);
        await settle(page);
        // Prove the page really is in its empty state before photographing
        // it: an unswitched fixture would otherwise produce a second set of
        // populated screenshots under the wrong names.
        await expect(page.getByTestId('report-body').first()).toContainText(
          /No |Nobody |Nothing |not/,
        );
        await page.screenshot({
          path: `${SHOTS}/${target.n}-${target.name}-empty-${theme}.png`,
          fullPage: true,
        });
      }
      await useFixture(request, 'full');
    });

    test(`the overview at tablet and phone widths, ${theme}`, async ({ page, request }) => {
      await useFixture(request, 'full');
      await useTheme(page, theme);
      for (const [label, width, height] of [
        ['tablet', 834, 1112],
        ['phone', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto('/statistics');
        await settle(page);
        await page.screenshot({
          path: `${SHOTS}/10-overview-${label}-${theme}.png`,
          fullPage: true,
        });
        await page.goto('/statistics/money');
        await settle(page);
        await page.screenshot({ path: `${SHOTS}/11-money-${label}-${theme}.png`, fullPage: true });
      }
    });
  }
});
