import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

/**
 * Human-to-human audio in a room, end to end: a Professional host starts a
 * session, a guest joins by link, both connect to a local LiveKit server, each
 * subscribes to the other's microphone, the host mutes the guest from the
 * participants popover and the guest unmutes themselves.
 *
 * Needs `livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1` on :7880 (docs/DEPLOY.md →
 * "Rooms audio")
 * and the rooms API/web pair from playwright.config.ts (:4014 / :5174, plan
 * forced to professional). Skips itself when LiveKit is not reachable.
 */
const LIVEKIT_HTTP = process.env.PEN_E2E_LIVEKIT_HTTP ?? 'http://127.0.0.1:7880/';
const ROOMS_WEB = process.env.PEN_E2E_ROOMS_WEB ?? 'http://localhost:5174';

// `window.__penAudioRoom` is the livekit-client Room the app exposes for devtools and this
// test (declared in packages/app/src/room/audio/livekit.ts).

async function livekitReachable(): Promise<boolean> {
  try {
    const res = await fetch(LIVEKIT_HTTP, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Seat {
  ctx: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

async function openSeat(browser: Browser): Promise<Seat> {
  const ctx = await browser.newContext({ baseURL: ROOMS_WEB, permissions: ['microphone'] });
  const page = await ctx.newPage();
  return { ctx, page, close: () => ctx.close() };
}

/**
 * The guest gets its own Chromium process. A second *context* in the same headless
 * process shares the fake audio device, and every AudioContext it opens (our player,
 * livekit-client's) stalls ~20 s in "The AudioContext encountered an error from the
 * audio device" — a browser-harness limitation, not a product path. Two processes are
 * also the honest model of two people on two machines.
 */
async function openGuestSeat(): Promise<Seat> {
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const seat = await openSeat(browser);
  return { ...seat, close: () => seat.ctx.close().then(() => browser.close()) };
}

const connectionState = (page: Page) =>
  page.evaluate(() => window.__penAudioRoom?.state ?? 'absent');

/** True once `page` has a live, subscribed audio track from the participant `identity`. */
const hearsParticipant = (page: Page, identity: string) =>
  page.evaluate((id) => {
    const p = window.__penAudioRoom?.remoteParticipants.get(id);
    if (!p) return false;
    return [...p.audioTrackPublications.values()].some(
      (pub) => pub.isSubscribed && pub.track !== undefined && !pub.isMuted,
    );
  }, identity);

const localAudioMuted = (page: Page) =>
  page.evaluate(() => {
    const pubs = [
      ...(window.__penAudioRoom?.localParticipant.audioTrackPublications.values() ?? []),
    ];
    return pubs.length > 0 && pubs.every((pub) => pub.isMuted);
  });

test.describe('rooms: voice between participants', () => {
  test('host and guest connect, hear each other, host mutes the guest, guest unmutes', async ({
    browser,
  }) => {
    test.skip(!(await livekitReachable()), `LiveKit is not reachable at ${LIVEKIT_HTTP}`);
    test.setTimeout(120_000);

    const host = await openSeat(browser);
    await host.page.goto('/');
    await host.page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
    await host.page.getByRole('button', { name: 'Start', exact: true }).click();
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(host.page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(host.page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    const roomUrl = host.page.url();
    expect(roomUrl).toMatch(/\/room\//);

    // The host is on voice as soon as the room says the session has it.
    await expect.poll(() => connectionState(host.page), { timeout: 20_000 }).toBe('connected');
    const hostId = await host.page.evaluate(
      () => window.__penAudioRoom?.localParticipant.identity ?? '',
    );
    expect(hostId).not.toBe('');

    // A guest joins by link in a second browser context (its own participant).
    const guest = await openGuestSeat();
    await guest.page.goto(roomUrl);
    // The room is up when its board and its bottom bar are. The old
    // "Live session" label is gone: RoomStatus shows a calm, transient pill
    // instead, so no one string is always on screen. The board is a lazy chunk
    // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
    await expect(guest.page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
    await expect(guest.page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => connectionState(guest.page), { timeout: 20_000 }).toBe('connected');
    const guestId = await guest.page.evaluate(
      () => window.__penAudioRoom?.localParticipant.identity ?? '',
    );
    expect(guestId).not.toBe('');
    expect(guestId).not.toBe(hostId);

    // Each side publishes its (shared, cloned) microphone and subscribes to the other's.
    await expect.poll(() => hearsParticipant(host.page, guestId), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hearsParticipant(guest.page, hostId), { timeout: 20_000 }).toBe(true);
    // Remote audio is attached to a hidden element on both sides.
    await expect(host.page.locator(`audio[data-pen-participant="${guestId}"]`)).toHaveCount(1);
    await expect(guest.page.locator(`audio[data-pen-participant="${hostId}"]`)).toHaveCount(1);

    // The participants popover on the host shows the guest on voice with a Mute button.
    await host.page.getByTestId('participants-toggle').click();
    const guestRow = host.page.getByTestId(`participant-${guestId}`);
    await expect(guestRow).toBeVisible();
    await expect(guestRow).toHaveAttribute('data-voice', /on|speaking/, { timeout: 10_000 });
    await host.page.getByTestId(`mute-${guestId}`).click();
    await expect(host.page.getByText('Muted', { exact: true }).first()).toBeVisible();

    // The server-side mute reaches the guest's own track, the guest's UI and the host's list.
    await expect.poll(() => localAudioMuted(guest.page), { timeout: 15_000 }).toBe(true);
    await expect(guest.page.getByText('The host muted you', { exact: false })).toBeVisible();
    const unmute = guest.page.getByRole('button', { name: 'Muted by the host — unmute' });
    await expect(unmute).toBeVisible();
    await expect(guestRow).toHaveAttribute('data-voice', 'muted', { timeout: 10_000 });
    await expect(host.page.getByTestId(`mute-${guestId}`)).toBeDisabled();
    await expect.poll(() => hearsParticipant(host.page, guestId)).toBe(false);

    // Nobody can unmute the guest but the guest.
    await unmute.click();
    await expect.poll(() => localAudioMuted(guest.page), { timeout: 15_000 }).toBe(false);
    await expect(guest.page.getByRole('button', { name: 'Mute microphone' })).toBeVisible();
    await expect(guestRow).toHaveAttribute('data-voice', /on|speaking/, { timeout: 10_000 });
    await expect.poll(() => hearsParticipant(host.page, guestId), { timeout: 10_000 }).toBe(true);

    // "Mute everyone" mutes the guest again (never the host).
    await host.page.getByTestId('mute-all').click();
    await expect.poll(() => localAudioMuted(guest.page), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => localAudioMuted(host.page)).toBe(false);

    // Leaving tears the media connection down cleanly on both sides.
    await guest.page.getByRole('button', { name: 'Leave' }).click();
    await expect
      .poll(
        () =>
          host.page.evaluate((id) => window.__penAudioRoom?.remoteParticipants.has(id), guestId),
        { timeout: 15_000 },
      )
      .toBe(false);
    await expect.poll(() => connectionState(guest.page)).toBe('absent');

    await host.page.keyboard.press('Escape');
    await host.page.getByRole('button', { name: 'End' }).click();
    await expect(host.page.getByText('Session saved')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => connectionState(host.page)).toBe('absent');

    await guest.close();
    await host.close();
  });
});
