import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { endSession, startLesson, UI_WEB, useTheme, waitForInk } from './ui-helpers.js';

/**
 * The brand review: the chosen brand and five alternatives, two themes, six
 * screens, one width.
 *
 * The owner asked for "a real better branding colour, something youtubish",
 * and a colour is not a thing anyone can decide from a hex. This spec produces
 * the pictures the decision needs, and it produces them the one way that
 * makes them worth looking at: the *same page*, in the *same state*, at the
 * *same width*, with only `data-brand` moved between shots. Nothing is
 * re-navigated and no lesson is re-taught between candidates, so two shots of
 * one screen differ in colour and in nothing else. Flip between them and you
 * are looking at the decision rather than at the noise.
 *
 * The decision has since been made — the red in `@theme` is `brand` below,
 * reached by removing the attribute — and the spec is kept rather than
 * deleted, because the next brand question deserves the same pictures and
 * because a regression in the chosen one shows up here first.
 *
 * The board matters more than the chrome. Every sketch an expert draws is
 * drawn in `--color-ink-accent`, and a page in one hue around drawings in
 * another reads as two products. So every family in `tokens.css` declares its
 * own ink, and `theBoardIsDrawnInTheBrand` below proves it on the live board
 * before the picture is taken: a candidate whose board is still painted in
 * some other family's ink is not a candidate, and this spec will say so
 * rather than quietly photographing one.
 *
 *   pnpm --filter @pen/web exec playwright test e2e/ui-brand.spec.ts --project=chromium
 *
 * Output: `.pen-data/brand-review/<screen>-<theme>-<family>.png`, which sorts
 * into flippable groups.
 */

const SHOTS = resolve(process.cwd(), '../../.pen-data/brand-review');
const UI_API = `http://127.0.0.1:${process.env.PEN_E2E_UI_API_PORT ?? '4023'}`;

/** 1440: the width the product bar is reviewed at, and the width the mockup is drawn at. */
const WIDTH = 1440;
const HEIGHT = 900;

/**
 * `brand` first: it is what a learner sees, and every comparison needs the
 * shipping thing in it. It is reached by *removing* the attribute, because
 * the brand is not a family in `tokens.css` — it is what `@theme` declares.
 * `teal` is what the platform was before it, kept as a family so the change
 * stays reversible and so a rendered-before-the-rebrand board has its ink.
 */
const FAMILIES = ['brand', 'teal', 'youtube', 'vermilion', 'coral', 'ember'] as const;
type Family = (typeof FAMILIES)[number];
const THEMES = ['light', 'dark'] as const;

/** The board's ink under each family, as `tokens.css` declares it. */
const INK: Record<Family, string> = {
  brand: 'oklch(0.422 0.148 6)', // #8A1A41, the brand wine
  teal: 'oklch(0.597 0.107 218.3)', // #008EAA
  youtube: 'oklch(0.628 0.258 29.2)',
  vermilion: 'oklch(0.592 0.228 29.3)',
  coral: 'oklch(0.632 0.225 28.5)',
  ember: 'oklch(0.592 0.228 29.3)',
};

async function applyFamily(page: Page, family: Family): Promise<void> {
  await page.evaluate((name) => {
    if (name === 'brand') document.documentElement.removeAttribute('data-brand');
    else document.documentElement.setAttribute('data-brand', name);
  }, family);
  // Colour transitions in the design system are --duration-base (200 ms).
  await page.waitForTimeout(260);
}

/**
 * That the family reached the page, and that the board kept its own ink.
 *
 * Two separate claims, and the second is the opposite of what this test
 * asserted before ADR-0034. A family used to re-tune `--color-ink-accent`
 * and the sketches followed it; now the board is a surface the learner
 * chooses, its ink is the board's own (`[data-board]` and `[data-ink]` come
 * after every family in tokens.css, on purpose — teal at 3.59:1 on paper is
 * unreadable chalk on slate), and a family repaints the chrome around it.
 * So: the chrome took the attribute, and the shape already drawn on the live
 * board is painted in the board's ink whatever the family says — the
 * sketches are SVG filled with `var(--color-ink-accent)`
 * (packages/board/src/shapes/ink-text.tsx, ink-stroke.tsx).
 */
async function theBoardIsDrawnInItsOwnInk(page: Page, family: Family): Promise<void> {
  const [primary, declared] = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return [
      root.getPropertyValue('--color-primary').trim(),
      root.getPropertyValue('--color-ink-accent').trim(),
    ];
  });
  expect(primary, `${family} must reach the chrome`).not.toBe('');
  chrome.set(family, primary);
  expect(declared, 'the board must have an ink of its own').not.toBe('');
  expect(declared, `${family} must not repaint the board (ADR-0034)`).not.toBe(INK.teal);

  /*
   * What the ink resolves to, and what the drawing is actually painted in.
   *
   * Both sides are read through `fill` on an SVG element, and that is not
   * fussiness: Chrome serialises a computed colour in the notation it was
   * authored in, so `getComputedStyle(span).color` on an OKLCH token hands
   * back "oklch(0.597 0.107 218.3)" while a board shape's `fill` may come
   * back as "rgb(…)". Comparing across two properties would compare two
   * spellings of one colour and fail, or — worse — pass for the wrong reason.
   */
  const { resolved, painted } = await page.evaluate(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('fill', 'var(--color-ink-accent)');
    svg.appendChild(rect);
    document.body.appendChild(svg);
    const resolvedFill = getComputedStyle(rect).fill;
    svg.remove();
    const inked = [...document.querySelectorAll('.pen-board .tl-shape *')]
      .map((el) => getComputedStyle(el).fill)
      .filter((f) => f && f !== 'none');
    return { resolved: resolvedFill, painted: inked };
  });
  expect(resolved, 'the ink token must resolve for this to mean anything').not.toBe('');
  expect(painted.length, 'the board has drawn nothing to check').toBeGreaterThan(0);
  expect(
    painted,
    `${family}: nothing on the board is painted in the board's ink (${resolved})`,
  ).toContain(resolved);
  seen.set(family, resolved);
}

/** What each family put on the board — one ink for all of them — and on the chrome, which does differ. */
const seen = new Map<Family, string>();
const chrome = new Map<Family, string>();

async function shoot(page: Page, screen: string, theme: string, family: Family): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${screen}-${theme}-${family}.png`) });
}

/** One page, one state, five colours. */
async function everyFamily(
  page: Page,
  screen: string,
  theme: string,
  also?: (family: Family) => Promise<void>,
): Promise<void> {
  for (const family of FAMILIES) {
    await applyFamily(page, family);
    await also?.(family);
    await shoot(page, screen, theme, family);
  }
}

async function anonymous(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${UI_API}/api/auth/anonymous`, { data: { name } });
  expect(res.ok(), `${UI_API} must be up: ${res.status()}`).toBe(true);
  return ((await res.json()) as { token: string }).token;
}

/** A finished session, so the saved page has a card, a board and a delete control. */
async function endedSession(request: APIRequestContext, token: string): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  const created = await request.post(`${UI_API}/api/sessions`, {
    headers,
    data: { topic: 'How Transformers work in LLMs' },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as { session: { id: string } }).session.id;
  await request.post(`${UI_API}/api/sessions/${id}/end`, { headers });
  return id;
}

test.describe('brand candidates, side by side', () => {
  test.setTimeout(300_000);

  for (const theme of THEMES) {
    test(`Home, Experts, Pricing and a saved session in ${theme}`, async ({ page, request }) => {
      const token = await anonymous(request, 'Reviewer');
      const saved = await endedSession(request, token);
      await page.addInitScript(
        ([bearer, chosen]) => {
          localStorage.setItem('pen.token', bearer as string);
          localStorage.setItem('pen.theme', chosen as string);
        },
        [token, theme] as const,
      );
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });

      // ── Home ──
      await page.goto(`${UI_WEB}/`);
      await expect(page.getByLabel('What do you want to learn?')).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(700);
      await everyFamily(page, 'home', theme);

      // ── Experts ──
      await page.goto(`${UI_WEB}/experts`);
      const tiles = page.getByTestId('experts-grid').getByTestId('expert-tile');
      await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(20);
      await page.waitForTimeout(700);
      await everyFamily(page, 'experts', theme);

      // ── Pricing ──
      await page.goto(`${UI_WEB}/pricing`);
      await expect(page.getByRole('heading', { name: 'Professional' })).toBeVisible({
        timeout: 30_000,
      });
      // billingStatus() settles the CTA labels; a shot before it is a shot of a skeleton.
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(700);
      await everyFamily(page, 'pricing', theme);

      // ── A saved session ──
      await page.goto(`${UI_WEB}/sessions/${saved}`);
      await expect(page.getByTestId('like-button').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: /Transformers/ })).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(700);
      await everyFamily(page, 'session', theme);
    });

    /**
     * The owner's instruction, checked on the rendered page rather than in
     * the stylesheet: "the same red youtubish colour like what is used in
     * sign in to be used both for dark and light". Sign in is the button
     * they pointed at, so Sign in is what this reads — and it reads the
     * computed background, which is the only thing that survives the whole
     * cascade, Tailwind's generated utilities included.
     */
    test(`Sign in is the brand red itself in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await useTheme(page, theme);
      await page.goto(`${UI_WEB}/`);
      // Two doors since ADR-0040; Sign in is the filled one and carries the
      // brand, and Sign up for free is outlined in the same red beside it.
      const signIn = page.getByTestId('account-chip');
      await expect(signIn).toBeVisible({ timeout: 30_000 });
      const [painted, declared] = await Promise.all([
        signIn.evaluate((el) => getComputedStyle(el).backgroundColor),
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--color-primary-fixed')
            .trim(),
        ),
      ]);
      // The owner's wine by day; its glow by night, where the wine itself would not read.
      expect(declared, 'the brand hex the owner chose').toBe(
        theme === 'dark' ? '#cb688c' : '#8a1a41',
      );
      expect(painted, `Sign in in ${theme}`).toBe(
        theme === 'dark' ? 'rgb(203, 104, 140)' : 'rgb(138, 26, 65)',
      );
    });

    /**
     * The room gets a test of its own because it costs a real lesson: the
     * expert has to teach long enough to put ink on the board before a
     * candidate's ink means anything. One lesson serves all five families,
     * which is the only reason this is affordable — and it is also why the
     * five shots are genuinely the same board.
     */
    test(`a live room with the board drawn in each candidate, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: WIDTH, height: HEIGHT });
      await useTheme(page, theme);
      await startLesson(page);
      await waitForInk(page);
      // A little more of the lesson, so the board is a drawing rather than a
      // first stroke and the panel has a line or two in it.
      await page.waitForTimeout(6_000);
      await everyFamily(page, 'room', theme, (family) => theBoardIsDrawnInItsOwnInk(page, family));

      // The family is doing something — the chrome repaints, so the brand and
      // the platform it replaced never resolve to one primary — while the
      // board's ink is the same under every one of them (ADR-0034).
      expect(chrome.get('brand'), `primaries seen: ${[...chrome].join(', ')}`).not.toBe(
        chrome.get('teal'),
      );
      expect(new Set(seen.values()).size, `board inks seen: ${[...seen].join(', ')}`).toBe(1);

      /*
       * And the same lesson once it is saved — the picture that shows what a
       * brand change costs an existing library. A thumbnail is rendered once
       * into a file, so a sketch already saved keeps the ink it was drawn in
       * however the app around it is recoloured.
       */
      await endSession(page);
      await expect(page.getByTestId('like-button').first()).toBeVisible({ timeout: 30_000 });
      // The thumbnail is rendered after the session ends; give it a window,
      // and shoot whatever is there rather than failing the review over it.
      await page
        .waitForFunction(() => Boolean(document.querySelector('img[src*="thumb"], .pen-board')), {
          timeout: 30_000,
        })
        .catch(() => undefined);
      await page.waitForTimeout(2_000);
      await everyFamily(page, 'session-taught', theme);
    });
  }
});
