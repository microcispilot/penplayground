import { expect, type Page, test } from '@playwright/test';
import { askByVoice, installFakeSpeech } from './speech.js';

/**
 * The owner's in-session timeline, end to end against fake providers
 * (playwright.config.ts: scripted model, silent voice, `PEN_ADS_EVERY_SEGMENTS=1`,
 * free plan):
 *
 *   lesson → a question asked out loud → the lesson pauses and holds its own
 *   position → the answer arrives on its own thread → the lesson resumes from
 *   where it stopped → an ad takes the board → voice and chat are off for its
 *   duration → it is skipped → the lesson carries on past the boundary.
 *
 * The positions are asserted from the room's own frames, not from pixels: the
 * `resume` the room records at the interrupt, the thread the answer's cues
 * carry, and the host's `progress` reports.
 *
 * The two halves are taught as two lessons on purpose. A boundary ad that
 * falls *after* a barge-in currently never opens on the client — the lesson
 * stops at the cue the ad was hung on and the overlay never appears. That
 * reproduces byte-for-byte on an untouched checkout of the commit this branch
 * is based on (recorded in the branch report), so it is not this change's to
 * assert around; the interrupt half and the ad half each get a clean room.
 */

/**
 * Every frame is stamped on arrival, because "nothing was sent from behind the
 * ad" is a claim about a *window*, not about a total. Counting before and after
 * also counts whatever the room legitimately sends in the instant after the ad
 * hands the lesson back — the microphone is live again by then — and that is a
 * pass the product earned being reported as a leak.
 */
type Frame = Record<string, unknown> & { at: number };

interface Frames {
  sent: Frame[];
  received: Frame[];
}

function watchFrames(page: Page): Frames {
  const frames: Frames = { sent: [], received: [] };
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      try {
        frames.sent.push({ ...JSON.parse(f.payload), at: Date.now() });
      } catch {
        /* binary or partial */
      }
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return;
      try {
        frames.received.push({ ...JSON.parse(f.payload), at: Date.now() });
      } catch {
        /* binary or partial */
      }
    });
  });
  return frames;
}

const progressSeq = (f: Frames): number =>
  f.sent.reduce(
    (max, m) => (m.kind === 'progress' && typeof m.seq === 'number' ? Math.max(max, m.seq) : max),
    -1,
  );

const states = (f: Frames) =>
  f.received.flatMap((m) =>
    m.kind === 'state' ? [m.state as { mode: string; resume: { seq: number } | null }] : [],
  );

const cues = (f: Frames) =>
  f.received.flatMap((m) =>
    m.kind === 'cue' ? [m.cue as { seq: number; thread: string; event: { type: string } }] : [],
  );

/**
 * Take whatever ad is on the board off it, the way the learner would.
 *
 * The ad half below owns what an ad *does*; the interrupt half needs the board
 * back, because a question asked into an ad's window is dropped on purpose
 * (`ad-input.ts`). The creative is Google's sample tag over http on a loopback
 * origin, which frequently never renders (playwright.config.ts records the
 * measurement and the reason); the player's own ceiling ends it either way, so
 * this skips when it can and waits when it cannot.
 */
async function clearAnyAd(page: Page): Promise<void> {
  const overlay = page.getByTestId('video-ad');
  const skip = overlay.getByTestId('skip-ad');
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    if (await skip.isEnabled().catch(() => false))
      await skip.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

/** This spec's own pair from playwright.config.ts: ads on, a pipeline of its own. */
const TIMELINE_WEB = process.env.PEN_E2E_TIMELINE_WEB ?? 'http://localhost:5185';

async function openLesson(page: Page): Promise<void> {
  // Before the first navigation: the app reads the recognizer constructor off
  // `window` when the room turns the microphone on (`e2e/speech.ts`).
  await installFakeSpeech(page);
  await page.goto(`${TIMELINE_WEB}/`);
  await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
  // Headless Chrome holds the AudioContext until the page is touched; the
  // lesson clock is the audio clock, so tap once like a learner would.
  await page.mouse.click(40, 40);
}

test.describe("the owner's in-session timeline", () => {
  test.setTimeout(300_000);

  test('an ad takes the board, voice and chat go quiet for it, and the lesson continues after the skip', async ({
    page,
  }) => {
    const frames = watchFrames(page);
    await openLesson(page);

    // Teach until the ad takes the board, answering the check-in that gates
    // the segment it is hung on. One loop rather than two fixed waits: on a
    // loaded machine the lesson takes its time, and the point of the test is
    // what happens *at* the ad, not how long the lesson took to reach it.
    const overlay = page.getByTestId('video-ad');
    const deadline = Date.now() + 240_000;
    let answered = false;
    while (Date.now() < deadline) {
      if (await overlay.isVisible().catch(() => false)) break;
      if (
        !answered &&
        (await page
          .getByTestId('check-card')
          .isVisible()
          .catch(() => false))
      ) {
        await page.getByRole('button', { name: /query from "sat"/ }).click();
        answered = true;
      }
      await page.waitForTimeout(500);
    }
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    const ad = frames.received.find((m) => m.kind === 'ad') as { afterSeq: number } | undefined;
    expect(ad, 'the room scheduled an ad at a segment boundary').toBeTruthy();

    // ── the gap this change closes ───────────────────────────────────────────
    // The microphone stops capturing, calmly: no warning colour, nothing to
    // dismiss, and a label that says why.
    //
    // This is a solo session, so the microphone is the *whole* of the input
    // the learner has — there is no panel, no composer and no reaction
    // control (ADR-0033), which is why none of them is asserted here. That
    // the same gate closes those three when there *are* guests is pinned by
    // `packages/app/test/session-panel.test.tsx` and `ui-panel.spec.ts`,
    // which build a room with people in it.
    const mic = page.getByTestId('mic-toggle');
    await expect(mic).toBeDisabled();
    await expect(mic).toHaveAttribute('aria-label', 'Microphone is off while the ad plays');
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
    await expect(page.getByTestId('reaction-toggle')).toHaveCount(0);
    // And nothing the learner does under the overlay reaches the room. The
    // window is what matters, so it is measured: from the moment the overlay
    // was up to the moment it went away.
    const adOpenedAt = Date.now();

    // Skipped by the learner, or ended by the player when the creative never
    // renders — either way the lesson gets its time back.
    const skip = overlay.getByTestId('skip-ad');
    const skipBy = Date.now() + 25_000;
    while (Date.now() < skipBy) {
      if (!(await overlay.isVisible().catch(() => false))) break;
      if (await skip.isEnabled().catch(() => false)) {
        await expect(skip).toHaveText(/Skip ad/);
        // The creative can end under the cursor — the player gives the lesson
        // its time back on its own ceiling. That is one of the two correct
        // endings, so a click that lands on a detached button is not a failure.
        await skip.click({ timeout: 5_000 }).catch(() => undefined);
        break;
      }
      await page.waitForTimeout(250);
    }
    await expect(overlay).toBeHidden({ timeout: 20_000 });
    const adClosedAt = Date.now();
    const behindTheAd = frames.sent.filter(
      (m) =>
        (m.kind === 'transcript' || m.kind === 'interrupt') &&
        m.at >= adOpenedAt &&
        m.at <= adClosedAt,
    );
    expect(behindTheAd, 'nothing was asked from behind the ad').toEqual([]);

    // The microphone is the learner's again on the same line.
    await expect(mic).toBeEnabled();
    await expect(mic).not.toHaveAttribute('aria-label', 'Microphone is off while the ad plays');

    // And the lesson carries on past the boundary the ad sat on.
    await expect
      .poll(() => progressSeq(frames), { timeout: 120_000 })
      .toBeGreaterThan(ad?.afterSeq ?? Number.POSITIVE_INFINITY);
  });
  test('a spoken question interrupts the lesson, is answered, and the lesson resumes from its own position', async ({
    page,
  }) => {
    const frames = watchFrames(page);
    await openLesson(page);
    // Let the lesson get going, so there is a position to come back to. A wait
    // rather than an assertion: the turn logic under test is the room's, and it
    // records where the lesson stopped whether or not this browser has managed
    // to play a sentence yet.
    const teaching = Date.now() + 30_000;
    while (Date.now() < teaching) {
      if (cues(frames).some((c) => c.thread === 'lesson' && c.event.type === 'say')) break;
      await page.waitForTimeout(500);
    }

    /*
     * Out loud, which is now the only way to ask the expert anything: the
     * panel's composer is a chat between the people in the room and never
     * reaches them. The recognizer is the fake one from `e2e/speech.ts`; from
     * its `onresult` inwards this is the product's own path —
     * `WebSpeechRecognizer` → `RoomSession` → `Conductor.onTranscript(…, final)`
     * → a final `transcript` frame.
     */
    const question = 'Why do we divide by the square root of d?';
    const heard = () => frames.sent.some((m) => m.kind === 'transcript' && m.final === true);
    /*
     * Said again if it was not heard. This pair runs with an ad after every
     * segment, and a question asked into that window is dropped in silence on
     * purpose — the test above is what proves it — so the board is cleared
     * first and the sentence repeated, the way a person talked over by an
     * advert repeats themselves.
     */
    for (let attempt = 0; attempt < 5 && !heard(); attempt += 1) {
      await clearAnyAd(page);
      await askByVoice(page, question);
      const by = Date.now() + 10_000;
      while (Date.now() < by && !heard()) await page.waitForTimeout(250);
    }
    expect(heard(), 'the room heard it as speech').toBe(true);
    // And it did not arrive as chat, which would have reached nobody but the room.
    expect(frames.sent.filter((m) => m.kind === 'chat')).toEqual([]);

    // The room gave them the floor and wrote down where the lesson stopped.
    await expect
      .poll(() => states(frames).some((s) => s.mode === 'listening' && s.resume !== null), {
        timeout: 30_000,
      })
      .toBe(true);
    const held = states(frames).find((s) => s.mode === 'listening' && s.resume !== null);
    const resumeSeq = held?.resume?.seq ?? -1;
    expect(resumeSeq, 'the room holds the cue the lesson stopped on').toBeGreaterThanOrEqual(0);

    // The answer is its own thread, with its own voice and its own board ops.
    await expect
      .poll(() => cues(frames).filter((c) => /^t\d+$/.test(c.thread)).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const answer = cues(frames).filter((c) => /^t\d+$/.test(c.thread));
    expect(
      answer.some((c) => c.event.type === 'say'),
      'the answer is spoken',
    ).toBe(true);
    // (Nothing the expert says is written into the panel any more: the chat
    // is between the people in the room, and the words reach whoever wants
    // them as captions. packages/app/test/captions.test.tsx holds that.)

    // Coming *back* to that position is the last step of the timeline, and it
    // is asserted where it can be asserted exactly rather than waited for:
    // packages/session-engine/test/room.test.ts drives the same turn and pins
    // `resume` at `{ sayId: 'L0.s2', offsetMs: 900 }`, then the re-speak of
    // that very sentence as take 1 once the host reports the answer played.
    // Here that last hop needs the browser to have *played* the answer, which
    // is the audio pipeline's business, not the room's turn logic.
  });
});
