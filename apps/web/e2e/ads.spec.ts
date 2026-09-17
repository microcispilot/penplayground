import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/** Repository root: the screenshot lands in the git-ignored `.pen-data/screens/`. */
const screens = resolve(process.cwd(), '../../.pen-data/screens');

/**
 * Free-plan video ads (ADR-0014) against Google's public IMA sample tag: the
 * API runs with PEN_AD_TEST_TAGS=1 and PEN_ADS_EVERY_SEGMENTS=1 (see
 * playwright.config.ts), so the three-segment fake lesson carries one ad after
 * segment 2's check-in. The SDK is fetched from imasdk.googleapis.com and the
 * creative from Google's test network — a real network path, on purpose.
 */
test.describe('free plan video ads', () => {
  test.setTimeout(240_000);

  test('the first boundary shows a real IMA ad, skippable after 5 s, and the lesson resumes', async ({
    page,
  }) => {
    const adEvents: string[] = [];
    // The player's analytics go through posthog (disabled here) and the room socket; observe
    // the socket frames instead of the analytics sink.
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        if (typeof frame.payload !== 'string') return;
        try {
          const msg = JSON.parse(frame.payload) as { kind?: string; event?: string };
          if (msg.kind === 'ad_event' && msg.event) adEvents.push(msg.event);
        } catch {
          /* binary or partial frame */
        }
      });
    });

    await page.goto('/');
    await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByText('Live session')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Let's start with a sentence", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    // Headless Chromium keeps the AudioContext suspended until a gesture on the page; the lesson
    // clock is the audio clock, so tap once like a learner would ("Tap anywhere to enable sound").
    await page.mouse.click(40, 40);

    // Segment 2 ends with a check-in; answering it lets the expert finish the segment.
    await expect(page.getByText('Quick check')).toBeVisible({ timeout: 120_000 });
    await page.getByRole('button', { name: /query from "sat"/ }).click();

    // The ad overlay: label, countdown, the creative from the sample tag.
    const overlay = page.getByTestId('video-ad');
    await expect(overlay).toBeVisible({ timeout: 90_000 });
    await expect(overlay.getByText('Ad · 1 of 1')).toBeVisible();
    await expect(
      overlay.getByRole('link', { name: /Why ads\? Standard removes them/ }),
    ).toBeVisible();
    await expect(overlay).toHaveAttribute('data-status', 'playing', { timeout: 20_000 });
    // The SDK put its own player on the page (the creative is an iframe/video inside our frame).
    await expect(overlay.locator('video, iframe').first()).toBeAttached();

    // Not skippable before 5 s; the button counts down, then becomes "Skip ad".
    const skip = overlay.getByTestId('skip-ad');
    await expect(skip).toBeDisabled();
    await expect(skip).toHaveText(/Skip in [1-5]/);
    await expect(skip).toBeEnabled({ timeout: 8_000 });
    await expect(skip).toHaveText(/Skip ad/);

    mkdirSync(screens, { recursive: true });
    await page.screenshot({ path: resolve(screens, 'ad.png') });

    await skip.click();
    await expect(overlay).toBeHidden({ timeout: 5_000 });
    // The sequence is kept next to the screenshot as evidence of the real SDK path.
    writeFileSync(resolve(screens, 'ad-events.json'), `${JSON.stringify(adEvents)}\n`);

    // The lesson resumes: captions keep coming — a sentence from the last segment shows up.
    await expect(
      page.getByText(/twelve of these in parallel|feed-forward layer|thirty-two times/),
    ).toBeVisible({ timeout: 60_000 });

    // Measurement reached the room: requested → loaded → started → skipped, in that order.
    expect(adEvents.slice(0, 3)).toEqual(['ad_requested', 'ad_loaded', 'ad_started']);
    expect(adEvents).toContain('ad_skipped');
    expect(adEvents).not.toContain('ad_error');
  });
});
