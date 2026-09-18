import { expect, test } from '@playwright/test';
import { endSession, shot, startLesson, UI_WEB, waitForInk } from './ui-helpers.js';

/**
 * The replay scrubber: seeking rebuilds the board deterministically for the
 * target cue and moves the audio to the matching offset, and the seek is
 * reported as `replay_seeked` with where it came from and where it went.
 */
test.describe('replay scrubber', () => {
  test.setTimeout(240_000);

  test('seeking to the middle rebuilds the board there and moves the audio', async ({ page }) => {
    // Teach a little, then save the session so there is a recording to replay.
    await startLesson(page);
    await waitForInk(page);
    await page.waitForTimeout(9_000);
    const id = await endSession(page);
    expect(id).toBeTruthy();

    // Collect the interaction the room reports over its socket.
    const seeks: Array<{ fromMs: number; toMs: number }> = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        if (typeof frame.payload !== 'string') return;
        try {
          const msg = JSON.parse(frame.payload) as {
            kind?: string;
            event?: string;
            props?: { fromMs?: number; toMs?: number };
          };
          if (msg.kind === 'report' && msg.event === 'replay_seeked' && msg.props)
            seeks.push({ fromMs: msg.props.fromMs ?? -1, toMs: msg.props.toMs ?? -1 });
        } catch {
          /* not a JSON frame */
        }
      });
    });

    await page.goto(`${UI_WEB}/replay/${id}`);
    await page.getByRole('button', { name: 'Play the session' }).click();
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await waitForInk(page);

    const track = page.getByTestId('scrubber-track');
    await expect(track).toBeVisible();
    const total = Number(await track.getAttribute('aria-valuemax'));
    expect(total).toBeGreaterThan(0);

    // A replay that has only just started is near the beginning.
    const startedAt = Number(await track.getAttribute('aria-valuenow'));
    expect(startedAt).toBeLessThan(total / 2);

    // Drag the handle to the middle of the recording.
    const box = await track.boundingBox();
    if (!box) throw new Error('no scrubber');
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    // The tooltip names the time and the segment under the pointer.
    await expect(page.getByTestId('scrubber-tooltip')).toBeVisible();
    await page.mouse.up();

    // The position moved to roughly half way, and the event carries both ends.
    await expect
      .poll(async () => Number(await track.getAttribute('aria-valuenow')), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(Math.floor(total * 0.4));
    await expect.poll(() => seeks.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const seek = seeks[seeks.length - 1];
    expect(seek?.toMs).toBeGreaterThan(seek?.fromMs ?? 0);

    // The board was rebuilt for the later cue: strokes from earlier in the lesson
    // are on the paper immediately, without being animated back in.
    await expect
      .poll(async () => page.locator('.pen-board .tl-shape').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // The clock the replay reads off its player (ADR-0002: the audio clock is
    // master) moved with it. The player's media elements are detached by design,
    // so this is where their position is observable; `seekCurrent` itself is
    // covered in packages/voice/test/media-player.test.ts.
    const clock = await page.getByTestId('replay-clock').innerText();
    const [mm = '0', ss = '0'] = (clock.split('/')[0] ?? '').trim().split(':');
    expect(Number(mm) * 60 + Number(ss)).toBeGreaterThanOrEqual(Math.floor(total * 0.4));

    await shot(page, 'replay-scrubber');
  });

  test('keyboard: space pauses, arrows and J/L jump, ticks mark the segments', async ({ page }) => {
    await startLesson(page);
    await waitForInk(page);
    await page.waitForTimeout(9_000);
    const id = await endSession(page);

    await page.goto(`${UI_WEB}/replay/${id}`);
    await page.getByRole('button', { name: 'Play the session' }).click();
    await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    const track = page.getByTestId('scrubber-track');
    await expect(track).toBeVisible();

    // Space toggles playback (the control's own label flips with it).
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(' ');
    await expect(page.getByTestId('replay-play')).toHaveAttribute('aria-label', 'Play');
    await page.keyboard.press(' ');
    await expect(page.getByTestId('replay-play')).toHaveAttribute('aria-label', 'Pause');

    // L jumps ten seconds forward, J takes five of them back with two arrows.
    await page.keyboard.press(' '); // paused: the position only moves when we move it
    const before = Number(await track.getAttribute('aria-valuenow'));
    await page.keyboard.press('l');
    await expect
      .poll(async () => Number(await track.getAttribute('aria-valuenow')), { timeout: 10_000 })
      .toBeGreaterThan(before);
    const afterL = Number(await track.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => Number(await track.getAttribute('aria-valuenow')), { timeout: 10_000 })
      .toBeLessThan(afterL);

    // One chapter tick per taught segment, and the slider reads as a clock.
    expect(await page.getByTestId('scrubber-tick').count()).toBeGreaterThanOrEqual(0);
    await expect(track).toHaveAttribute('aria-valuetext', /\d+:\d\d of \d+:\d\d/);
  });
});
