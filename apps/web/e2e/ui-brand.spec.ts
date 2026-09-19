import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { endSession, startLesson, UI_WEB, useTheme, waitForInk } from './ui-helpers.js';

/**
 * The brand review: six families, two themes, six screens, one width.
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
 * The board matters more than the chrome here. Every sketch an expert draws is
 * drawn in `--color-ink-accent`, and a red app around teal drawings reads as
 * two products — that is the reason teal survived the last brand review. So
 * each family in `tokens.css` re-tunes the ink, and `theBoardIsDrawnInTheBrand`
 * below proves it on the live board before the picture is taken: a candidate
 * whose board still draws teal is not a candidate, and this spec will say so
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
 * `teal` first and last in spirit: it is the control, and every comparison
 * needs one. It is reached by *removing* the attribute, because teal is not a
 * family in `tokens.css` — it is the default that `@theme` declares.
 */
const FAMILIES = ['teal', 'youtube', 'vermilion', 'coral', 'ember', 'signal'] as const;
type Family = (typeof FAMILIES)[number];
const THEMES = ['light', 'dark'] as const;

/** Teal's ink, the value `@theme` pins (tokens.css: "#008EAA, the brand teal"). */
const TEAL_INK = 'oklch(0.597 0.107 218.3)';

async function applyFamily(page: Page, family: Family): Promise<void> {
  await page.evaluate((name) => {
    if (name === 'teal') document.documentElement.removeAttribute('data-brand');
    else document.documentElement.setAttribute('data-brand', name);
  }, family);
  // Colour transitions in the design system are --duration-base (200 ms).
  await page.waitForTimeout(260);
}

/**
 * That the family reached the page at all, and that it reached the *board*.
 *
 * Two separate claims. The first is that the cascade took the attribute. The
 * second is the one this whole exercise turns on: that a shape already drawn
 * on the live board is now painted in the candidate's ink rather than in
 * teal — the sketches are SVG filled with `var(--color-ink-accent)`
 * (packages/board/src/shapes/ink-text.tsx, ink-stroke.tsx), so a brand that
 * re-tunes the token repaints the drawing without re-teaching the lesson.
 */
async function theBoardIsDrawnInTheBrand(page: Page, family: Family): Promise<void> {
  const declared = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-ink-accent').trim(),
  );
  if (family === 'teal') expect(declared).toBe(TEAL_INK);
  else expect(declared, `${family} must re-tune the board ink`).not.toBe(TEAL_INK);

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
    `${family}: nothing on the board is painted in this family's ink (${resolved})`,
  ).toContain(resolved);
  seen.set(family, resolved);
}

/** What each family actually put on the board, so the run can prove they differ. */
const seen = new Map<Family, string>();

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
      await everyFamily(page, 'room', theme, (family) => theBoardIsDrawnInTheBrand(page, family));

      // Five families, five inks: the board is not merely repainting, it is
      // repainting differently. (Four distinct reds plus teal would be five;
      // what must never happen is a candidate silently drawing teal.)
      expect(new Set(seen.values()).size, `inks seen: ${[...seen].join(', ')}`).toBeGreaterThan(1);
      expect(seen.get('teal')).not.toBe(seen.get('youtube'));

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
