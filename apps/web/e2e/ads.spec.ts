import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GOOGLE_IMA_SAMPLE_TAG } from '@pen/contracts';
import { expect, type Locator, test } from '@playwright/test';
import { cspViolations, watchCsp } from './csp-guard.js';

/** Repository root: the screenshot lands in the git-ignored `.pen-data/screens/`. */
const screens = resolve(process.cwd(), '../../.pen-data/screens');

/**
 * Whether the ad comes from Google's public sample tag (the manual check) or
 * from the VAST fixture this deployment serves itself. The sample tag is the
 * default today; the fixture waits on an https e2e origin (tasks/todo.md).
 * The SDK is Google's either way: that is the integration, and stubbing it
 * would test nothing.
 */
const LIVE = process.env.PEN_E2E_AD_FIXTURE !== '1';

/**
 * The IMA SDK is fetched from Google on every run. On a runner without egress
 * that is an environment failure, not ours, so the spec skips itself rather
 * than going red — the same rule `rooms.spec.ts` applies to LiveKit. With
 * the sample tag has to answer as well; the fixture path has nothing else to
 * reach.
 */
async function adStackReachable(): Promise<boolean> {
  const urls = ['https://imasdk.googleapis.com/js/sdkloader/ima3.js'];
  if (LIVE) urls.push(GOOGLE_IMA_SAMPLE_TAG);
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * How the ad ended up. Two endings are correct and the product must reach one
 * of them: the creative plays and the learner skips it, or it renders nothing
 * and the player gives the lesson its time back.
 */
type Outcome = 'skippable' | 'ended';

/** Poll until the ad is skippable or gone, whichever the run produces. */
async function settle(overlay: Locator, skip: Locator, timeoutMs: number): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await overlay.isVisible().catch(() => false))) return 'ended';
    if (await skip.isEnabled({ timeout: 1_000 }).catch(() => false)) return 'skippable';
    if (Date.now() > deadline)
      throw new Error('the ad neither became skippable nor ended: the lesson is stuck behind it');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Free-plan video ads (ADR-0014), end to end against the real IMA SDK: the API
 * runs with PEN_ADS_EVERY_SEGMENTS=1 (see playwright.config.ts), so the
 * three-segment fake lesson carries one ad after segment 2's check-in.
 *
 * The creative comes from Google's public sample tag, over the open internet,
 * on purpose — that is the integration. It does not always render, and the
 * reason is measured rather than guessed: the same tag on a bare page plays
 * through with 29 `AD_PROGRESS` events and its clock at 7.5 s, and then — after
 * a room has been opened in that same browser — the identical run reaches
 * `start` and stops, 0 `AD_PROGRESS`, clock at 0.00. That is the browser, not
 * the product: this spec runs on real Chrome for exactly that reason
 * (playwright.config.ts), and a learner whose blocker kills the media request
 * after the SDK has begun sees the same shape anyway. The rule is the same
 * either way — the lesson never waits for an ad
 * (AD_RULES.progressTimeoutMs) — so the spec asserts the shape of the run and
 * that the lesson always gets its time back, and checks the full happy path
 * when the creative does play.
 *
 * `PEN_E2E_AD_FIXTURE=1` swaps in a VAST fixture the API serves itself, which
 * would make the creative deterministic; it needs the e2e page on https first,
 * and tasks/todo.md carries the measurement of why.
 */
test.describe('free plan video ads', () => {
  test.setTimeout(240_000);

  test('the first boundary shows a real IMA ad and the lesson always gets its time back', async ({
    page,
  }) => {
    test.skip(!(await adStackReachable()), 'the IMA SDK is unreachable from here');
    // The dev server serves the production policy: if it blocks the IMA SDK or
    // the creative, this run must say so rather than just timing out.
    const csp = watchCsp(page);
    const adEvents: string[] = [];
    const adErrors: string[] = [];
    /** The cue the ad was scheduled after, and how far the host has played. */
    let adAfterSeq: number | null = null;
    let progressSeq = -1;
    // The player's analytics go through posthog (disabled here) and the room socket; observe
    // the socket frames instead of the analytics sink.
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        try {
          const msg = JSON.parse(frame.payload) as { kind?: string; afterSeq?: number };
          if (msg.kind === 'ad' && typeof msg.afterSeq === 'number') adAfterSeq = msg.afterSeq;
        } catch {
          /* binary or partial frame */
        }
      });
      ws.on('framesent', (frame) => {
        if (typeof frame.payload !== 'string') return;
        try {
          const msg = JSON.parse(frame.payload) as {
            kind?: string;
            event?: string;
            code?: string;
            seq?: number;
          };
          // How far the conductor says the learner has actually heard.
          if (msg.kind === 'progress' && typeof msg.seq === 'number')
            progressSeq = Math.max(progressSeq, msg.seq);
          if (msg.kind !== 'ad_event' || !msg.event) return;
          adEvents.push(msg.event);
          if (msg.event === 'ad_error' && msg.code) adErrors.push(msg.code);
        } catch {
          /* binary or partial frame */
        }
      });
    });

    await page.goto('/');
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Let's start with a sentence", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // Headless Chromium keeps the AudioContext suspended until a gesture on the page; the lesson
    // clock is the audio clock, so tap once like a learner would ("Tap anywhere to enable sound").
    await page.mouse.click(40, 40);

    // Segment 2 ends with a check-in; answering it lets the expert finish the segment.
    await expect(page.getByText('Quick check')).toBeVisible({ timeout: 120_000 });
    await page.getByRole('button', { name: /query from "sat"/ }).click();

    // The ad overlay: label, position, and the honest way out of ads.
    const overlay = page.getByTestId('video-ad');
    await expect(
      overlay,
      `CSP violations: ${(await cspViolations(page, csp)).join(' | ')}`,
    ).toBeVisible({ timeout: 90_000 });
    await expect(overlay.getByText('Ad · 1 of 1')).toBeVisible();
    await expect(
      overlay.getByRole('link', { name: /Why ads\? Standard removes them/ }),
    ).toBeVisible();
    mkdirSync(screens, { recursive: true });
    await page.screenshot({ path: resolve(screens, 'ad.png') });

    // The real SDK path, all the way to a started creative.
    await expect
      .poll(() => adEvents.slice(0, 3), { timeout: 40_000 })
      .toEqual(['ad_requested', 'ad_loaded', 'ad_started']);

    // Not skippable at once: the button counts down first, whatever the VAST
    // says. Read in one evaluate rather than two assertions, because the
    // recovery path below can end the ad before the countdown finishes — which
    // is the whole point of it — and two queries could straddle that moment.
    // The 5 s rule itself is pinned by packages/app/test/ad-player.test.ts.
    const skip = overlay.getByTestId('skip-ad');
    const countdown = await skip
      .evaluate((el) => ({ disabled: (el as HTMLButtonElement).disabled, text: el.textContent }))
      .catch(() => null);
    if (countdown) {
      expect(countdown.disabled, 'an ad is never skippable the instant it appears').toBe(true);
      expect(countdown.text).toMatch(/Skip in [1-5]/);
    }

    // From here the run takes one of the two endings above, and the ad must
    // reach one of them well inside the conductor's 30 s ceiling. With the
    // served fixture the creative is always there, so "it played" is the only
    // acceptable ending; only the live sample tag is allowed to show nothing.
    const outcome = await settle(overlay, skip, 20_000);
    if (!LIVE) expect(outcome, 'the fixture creative must actually play').toBe('skippable');
    if (outcome === 'skippable') {
      // The creative is really playing: the SDK put its own player on the page,
      // the button flipped at 5 s, and the learner skips it.
      await expect(overlay.locator('video, iframe').first()).toBeAttached();
      await expect(overlay).toHaveAttribute('data-status', 'playing');
      await expect(skip).toHaveText(/Skip ad/);
      await skip.click();
    }
    await expect(overlay).toBeHidden({ timeout: 10_000 });
    // The sequence is kept next to the screenshot as evidence of the real SDK path.
    writeFileSync(resolve(screens, 'ad-events.json'), `${JSON.stringify(adEvents)}\n`);

    // Whichever ending it was, the lesson gets its time back and carries on
    // past the boundary the ad sat on. Asserted from the host's own progress
    // reports rather than from a caption: a caption is on screen for as long
    // as its sentence is being spoken, and on a lesson whose voice is already
    // stored the last ones can come and go faster than a query can catch them.
    expect(adAfterSeq, 'the room scheduled an ad at a segment boundary').not.toBeNull();
    await expect
      .poll(() => progressSeq, { timeout: 90_000 })
      .toBeGreaterThan(adAfterSeq ?? Number.POSITIVE_INFINITY);

    // Measurement reached the room, and the ending is named rather than silent.
    expect(adEvents.slice(0, 3)).toEqual(['ad_requested', 'ad_loaded', 'ad_started']);
    if (outcome === 'skippable') {
      expect(adEvents).toContain('ad_skipped');
      expect(adErrors).toEqual([]);
    } else {
      // A creative that started and then showed nothing: reported through the
      // same ad telemetry every other outcome uses, with the reason on it.
      expect(adEvents).toContain('ad_error');
      expect(adErrors).toContain('STALLED');
    }

    // And nothing the ad stack needs was blocked on the way.
    expect(await cspViolations(page, csp)).toEqual([]);
  });
});
