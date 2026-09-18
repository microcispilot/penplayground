import type { Page } from '@playwright/test';

/**
 * Collect Content-Security-Policy violations for a page.
 *
 * The dev server serves the same policy the web container does (vite.config.ts
 * → apps/web/csp.ts), so every e2e run doubles as a check that the policy does
 * not block anything the product needs. A blocked request is a broken product,
 * so specs assert this list is empty.
 */
export function watchCsp(page: Page): { violations: string[] } {
  const violations: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && /Content Security Policy|Refused to /i.test(text))
      violations.push(text);
  });
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const w = window as unknown as { __cspViolations?: string[] };
      w.__cspViolations ??= [];
      w.__cspViolations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  return { violations };
}

/** Everything the page itself recorded, plus what the console showed. */
export async function cspViolations(
  page: Page,
  collected: { violations: string[] },
): Promise<string[]> {
  const fromPage = await page
    .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
    .catch(() => [] as string[]);
  return [...new Set([...fromPage, ...collected.violations])];
}
