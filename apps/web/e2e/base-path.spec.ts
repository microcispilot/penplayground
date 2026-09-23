import { expect, type Page, type Response, test } from '@playwright/test';
import { askByVoice, installFakeSpeech } from './speech.js';

/**
 * The whole product served under a URL path prefix rather than at the root of its origin
 * (playwright.basepath.config.ts builds it with `PEN_BASE_PATH` and serves it behind the real
 * nginx image, with the prefix stripped before it reaches the containers).
 *
 * A path prefix fails loudly in exactly one way — something is fetched from the wrong URL and
 * 404s — so this spec walks the same journey `session.spec.ts` walks, and watches every response
 * on the way. Nothing under the prefix may 404, no in-app navigation may leave it, and the
 * WebSocket the lesson streams over has to open under it too.
 */

const BASE = (process.env.PEN_BASE_PATH ?? '/testingxyzbdc').replace(/\/+$/, '');

/** Every response the page took that was not a success, with its status (and a count of all of them). */
function watchFailures(page: Page): { failures: string[]; total: () => number } {
  const failures: string[] = [];
  let seen = 0;
  page.on('response', (res: Response) => {
    seen += 1;
    if (res.status() >= 400)
      failures.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    // An aborted media/analytics request on teardown is not a broken URL; a refused one is.
    const failure = req.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|net::ERR_FAILED$/.test(failure)) failures.push(`${failure} ${req.url()}`);
  });
  return { failures, total: () => seen };
}

/** Same-origin URLs that are not under the prefix: the one thing a base path gets wrong. */
function offBase(urls: string[], origin: string): string[] {
  return urls.filter((u) => u.includes(origin) && !u.includes(`${origin}${BASE}/`));
}

test.describe('served under a base path', () => {
  test.setTimeout(240_000);

  test('home → room → question → end → saved → replay, with nothing off the prefix', async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    const watched = watchFailures(page);
    const { failures } = watched;
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    // Before the first navigation: the expert is asked things out loud now.
    await installFakeSpeech(page);

    // `/` is not the app here: the edge redirects into the prefix, which is what anyone who
    // types the hostname gets. Following it is the first assertion.
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/$`));
    await expect(page.getByRole('heading', { name: /What do you want to/ })).toBeVisible();

    // The document really was built for this prefix: every asset it asks for is under it.
    const entry = await page.locator('script[type="module"]').first().getAttribute('src');
    expect(entry).toMatch(new RegExp(`^${BASE}/assets/`));

    // A live session. The room is a lazy chunk and the board is a much larger one; both have to
    // resolve under the prefix or the screen never paints.
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/room/`));
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    // The lesson has started when the expert has written something. Not when a
    // caption says so: captions are off until the CC control turns them on, and
    // the expert's words are written nowhere else (apps/web/e2e/session.spec.ts
    // is where that rule itself is asserted).
    await expect
      .poll(async () => page.locator('.pen-board .tl-shape').count(), { timeout: 45_000 })
      .toBeGreaterThan(0);

    // The lesson streams over a WebSocket derived from the API base URL, so it carries the
    // prefix too: `ws://host/testingxyzbdc/ws/room`.
    expect(
      sockets.some((url) => url.includes(`${BASE}/ws/room`)),
      `lesson socket under the prefix (saw: ${sockets.join(', ')})`,
    ).toBe(true);
    expect(offBase(sockets, origin.replace(/^http/, 'ws')), 'sockets off the prefix').toEqual([]);

    // A spoken question interrupts and is answered.
    await askByVoice(page, 'Why do we divide by the square root of d?');
    await expect(page.getByText('keeps the dot products', { exact: false })).toBeVisible({
      timeout: 20_000,
    });

    // End → the saved session page, and the sketch the API renders in the background.
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Open the saved session' }).click();
    await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/sessions/`));
    await expect(page.getByRole('heading', { name: /Transformers/ })).toBeVisible();
    const id = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(id).toBeTruthy();

    // The thumbnail is built from the API base URL, so it is prefixed as well — and it loads.
    const thumb = page.getByTestId('session-thumb').first();
    // The card's picture, by the session's own route. The file extension is a
    // delivery detail and has already moved once (svg to png when thumbnails
    // became photographs); what this test owns is that the card shows the
    // session's generated picture at all.
    await expect(thumb.locator('img')).toHaveAttribute(
      'src',
      /\/api\/sessions\/[^/]+\/thumb\.\w+$/,
      { timeout: 30_000 },
    );
    expect(await thumb.locator('img').getAttribute('src')).toContain(`${BASE}/api/sessions/`);

    // The share URL shown on the page is the public one, prefix included.
    await expect(page.getByTestId('share-url')).toHaveText(`${origin}${BASE}/s/${id}`);
    // And it is a real page: the API's share renderer, reached through the prefix.
    const share = await page.request.get(`${origin}${BASE}/s/${id}`);
    expect(share.status()).toBe(200);
    expect(await share.text()).toContain(`${origin}${BASE}/sessions/${id}`);

    // The host's own recording (ADR-0035): "Replay" on this page starts the
    // lesson again as a fresh session, so the recording is its own control.
    await page.getByRole('button', { name: 'Watch my recording' }).click();
    await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/replay/${id}$`));
    await page.getByRole('button', { name: 'Play the session' }).click();
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });

    // Nothing anywhere in that journey came back 4xx/5xx. The count goes to the report on
    // purpose (as in ui-perf.spec.ts): "nothing 404ed" is only worth reading next to how many
    // requests were watched.
    console.log(
      `base path ${BASE}: ${watched.total()} responses, ${failures.length} with status >= 400`,
    );
    expect(failures, `responses >= 400:\n${failures.join('\n')}`).toEqual([]);
  });
});
