import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The Content-Security-Policy is derived from what the app actually asks the
 * network for, not from memory (docs/DEPLOY.md). This spec is both halves of
 * that: it records every origin a full session touches, and it fails if the
 * policy the web tier serves would have blocked any of them.
 *
 * Run against the dev servers with the fake providers and the IMA sample tag,
 * exactly as `ads.spec.ts` does, so the ad path is real network traffic.
 */

const OUT = resolve(process.cwd(), '../../.pen-data/csp-origins.json');

/** Directives a browser reports as violated, mapped to the origin that tripped them. */
interface Violation {
  directive: string;
  blockedURI: string;
}

test.describe('content security policy', () => {
  test.setTimeout(240_000);

  test('a whole session touches only the origins the policy allows', async ({ page }) => {
    const origins = new Set<string>();
    const violations: Violation[] = [];
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
      consoleErrors.push(text);
      if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(text))
        violations.push({ directive: 'console', blockedURI: text });
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        const detail = `${e.effectiveDirective} ${e.blockedURI}`;
        (window as unknown as { __cspViolations?: string[] }).__cspViolations ??= [];
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(detail);
      });
    });

    await page.goto('/');
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByText('Live session')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Let's start with a sentence", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // The lesson clock is the audio clock; headless Chromium needs a gesture.
    await page.mouse.click(40, 40);

    // The three places the app reaches beyond its own origin: the board's
    // assets while it writes, the ad slot at the first segment boundary, and
    // Google Identity Services behind the account sheet.
    // Long enough for the board to write, the lesson to stream and the analytics
    // and error sinks to make their first calls.
    await page.waitForTimeout(45_000);

    // Google Identity Services loads behind the account sheet, and nowhere else.
    // (The ad path runs under this same header in ads.spec.ts, so a policy that
    // blocked the IMA SDK or its creative would fail there.)
    await page.goto('/');
    await page.getByTestId('account-chip').click();
    await expect(page.getByTestId('google-signin')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);

    const pageViolations = await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        { origins: [...origins].sort(), violations: pageViolations, consoleErrors },
        null,
        2,
      ),
    );

    // A blocked request is a broken product, so any violation fails the run.
    expect(pageViolations, `CSP violations:\n${pageViolations.join('\n')}`).toEqual([]);
    expect(
      violations,
      `console CSP errors:\n${violations.map((v) => v.blockedURI).join('\n')}`,
    ).toEqual([]);

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
