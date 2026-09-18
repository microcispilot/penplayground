import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * The Content-Security-Policy is derived from what the app actually asks the
 * network for, not from memory (docs/DEPLOY.md). This spec is both halves of
 * that: it records every origin a full session touches, and it fails if the
 * policy the web tier serves would have blocked any of them.
 *
 * It walks the whole product, because the policy has to hold on every screen
 * and every lazily-fetched chunk: Home, Experts, a shelf, the legal pages, a
 * live room (board, mic, captions), the saved session page and a replay. The
 * ad path is the one part left to `ads.spec.ts`, which runs under this same
 * header and asserts the same emptiness — an ad is slow enough that measuring
 * it twice in one suite buys nothing.
 *
 * Run against the dev servers with the fake providers, so the network traffic
 * is real even though the model and the voice are not.
 */

const OUT = resolve(process.cwd(), '../../.pen-data/csp-origins.json');

test.describe('content security policy', () => {
  test.setTimeout(300_000);

  test('every screen and every chunk stays inside the policy', async ({ page }) => {
    const origins = new Set<string>();
    const consoleErrors: string[] = [];

    page.on('request', (r) => {
      try {
        const url = new URL(r.url());
        if (url.protocol === 'http:' || url.protocol === 'https:')
          origins.add(`${url.origin} ${r.resourceType()}`);
        else origins.add(`${url.protocol} ${r.resourceType()}`);
      } catch {
        /* about:blank and friends */
      }
    });
    page.on('websocket', (ws) => {
      try {
        origins.add(`${new URL(ws.url()).origin} websocket`);
      } catch {
        /* ignore */
      }
    });
    // A CSP violation surfaces as a console error in Chromium; the page also
    // gets a securitypolicyviolation event, which is the reliable signal.
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(text))
        consoleErrors.push(text);
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        const detail = `${e.effectiveDirective} ${e.blockedURI}`;
        (window as unknown as { __cspViolations?: string[] }).__cspViolations ??= [];
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(detail);
      });
    });

    const recorded: string[] = [];
    const seen = async (): Promise<string[]> =>
      page
        .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
        .catch(() => [] as string[]);
    /** Each navigation drops the page's own list, so it is collected as we go. */
    const step = async (name: string, fn: (p: Page) => Promise<void>) => {
      await fn(page);
      const violations = await seen();
      expect(violations, `${name} was blocked:\n${violations.join('\n')}`).toEqual([]);
      recorded.push(...violations);
    };

    // ── the shell and its lazy routes ────────────────────────────────────────
    await step('home', async (p) => {
      await p.goto('/');
      await expect(p.getByLabel('What do you want to learn?')).toBeVisible({ timeout: 20_000 });
      await p.waitForTimeout(2_000); // analytics and the error sink make their first calls
    });
    await step('experts', async (p) => {
      await p.goto('/experts');
      await expect(p.getByRole('heading', { name: 'Experts' })).toBeVisible({ timeout: 20_000 });
    });
    await step('a shelf', async (p) => {
      await p.goto('/history');
      await expect(p.getByTestId('sidebar-aside')).toBeVisible({ timeout: 20_000 });
    });
    await step('the legal pages (their own chunk)', async (p) => {
      await p.goto('/terms');
      await expect(p.getByRole('heading', { name: /Terms/ }).first()).toBeVisible({
        timeout: 20_000,
      });
      await p.goto('/privacy');
      await expect(p.getByRole('heading', { name: /Privacy/ }).first()).toBeVisible({
        timeout: 20_000,
      });
    });
    await step('google identity services behind the account sheet', async (p) => {
      await p.goto('/');
      await p.getByTestId('account-chip').click();
      await expect(p.getByTestId('google-signin')).toBeVisible({ timeout: 20_000 });
      await p.waitForTimeout(3_000);
      await p.keyboard.press('Escape');
    });

    // ── a live room: the board chunk, the mic worklet, the room socket ───────
    await step('a live lesson', async (p) => {
      await p.goto('/');
      await p.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
      await p.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(p.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
      await expect(p.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
      // The lesson clock is the audio clock; headless Chromium needs a gesture.
      await p.mouse.click(40, 40);
      // Long enough for the board to write and the lesson to stream.
      await expect(p.locator('.pen-board .tl-shape').first()).toBeAttached({ timeout: 60_000 });
      await p.waitForTimeout(8_000);
    });

    let id = '';
    await step('the saved session page', async (p) => {
      await p.getByRole('button', { name: 'End' }).click();
      await expect(p.getByText('Session saved')).toBeVisible({ timeout: 40_000 });
      await p.getByRole('button', { name: 'Open the saved session' }).click();
      await p.waitForURL(/\/sessions\//, { timeout: 20_000 });
      id = new URL(p.url()).pathname.split('/').pop() ?? '';
      await p.waitForTimeout(3_000);
    });
    await step('a replay (its own chunk, blob audio, blob worker)', async (p) => {
      await p.goto(`/replay/${id}`);
      await p.getByRole('button', { name: 'Play the session' }).click();
      await expect(p.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
      await p.waitForTimeout(12_000);
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        { origins: [...origins].sort(), violations: recorded, consoleErrors },
        null,
        2,
      ),
    );

    // A blocked request is a broken product, so any violation fails the run.
    expect(recorded, `CSP violations:\n${recorded.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console CSP errors:\n${consoleErrors.join('\n')}`).toEqual([]);

    // Privacy without a banner (ADR-0018): nothing asks for consent, because
    // nothing is stored that would need it.
    const cookies = await page.context().cookies();
    expect(
      cookies.filter((c) => /^(ph_|_p)/.test(c.name)),
      `analytics cookies: ${cookies.map((c) => c.name).join(', ')}`,
    ).toEqual([]);
    const stored = await page.evaluate(() => Object.keys(localStorage));
    // Only what the learner asked us to remember (`pen.*`: their bearer, name,
    // pace, theme and privacy choice) and the board library's own first-party
    // UI preferences. Nothing that identifies anyone anywhere else.
    expect(stored.filter((k) => !k.startsWith('pen.') && !k.startsWith('TLDRAW_'))).toEqual([]);
    expect(stored.some((k) => /posthog|^ph_|^_ga|^_fb/i.test(k))).toBe(false);
    // And no consent wall anywhere on the page.
    await expect(page.getByText(/accept (all )?cookies|consent/i)).toHaveCount(0);
  });
});
