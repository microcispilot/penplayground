import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * TURN, proven rather than assumed (ADR-0012).
 *
 * A network that blocks UDP *and* outbound TCP 7881 can only join a room by
 * relaying through the media server's TURN server. Two things have to be true
 * for that to work, and both are checked here against a real server:
 *
 *   1. every client is handed the deployment's TURN server automatically —
 *      LiveKit puts it in the join response, so nothing in the app configures
 *      it (and nothing in the app may set `iceServers`, or the SDK would keep
 *      ours instead);
 *   2. that TURN server really allocates a relay for those credentials — a
 *      peer connection allowed to use nothing but relay candidates
 *      (`iceTransportPolicy: 'relay'`) gathers one.
 *
 * The control for 2 is the same probe with no TURN server: it gathers nothing.
 * A third case checks the everyday path is unaffected: an ordinary browser is
 * never relayed, because relaying media the network does not need is pure cost.
 *
 * What is deliberately NOT tested here: connecting the app itself with
 * `iceTransportPolicy: 'relay'`. livekit-client 2.22.3 creates the peer
 * connection before the join response arrives, so a policy passed to
 * `Room.connect` applies while the SDK still has no ICE servers and the client
 * gathers nothing at all. Forcing relay is the media server's job (it moves a
 * participant onto TURN itself when direct candidates fail) — see ADR-0012.
 *
 * Needs a LiveKit server with TURN enabled (`deploy/livekit/livekit.dev.yaml`):
 *
 *   docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp -p 3478:3478/udp \
 *     -p 30000-30010:30000-30010/udp \
 *     -v "$PWD/deploy/livekit/livekit.dev.yaml:/etc/livekit.yaml:ro" \
 *     livekit/livekit-server:v1.9.12 --config /etc/livekit.yaml
 *
 * It skips itself when that server is not running, and reports honestly when the
 * server is running without TURN.
 */
const LIVEKIT_HTTP = process.env.PEN_E2E_LIVEKIT_HTTP ?? 'http://127.0.0.1:7880/';
const ROOMS_WEB = process.env.PEN_E2E_ROOMS_WEB ?? 'http://localhost:5174';

async function livekitReachable(): Promise<boolean> {
  try {
    const res = await fetch(LIVEKIT_HTTP, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A seat on the rooms pair (its own API and web server, host plan forced to professional). */
async function openSeat(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: ROOMS_WEB, permissions: ['microphone'] });
  return { ctx, page: await ctx.newPage() };
}

/** Start a session as the host and wait until its media connection is up. */
async function joinAsHost(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('What do you want to learn?').fill('How Transformers work in LLMs');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // The room is up when its board and its bottom bar are. The old
  // "Live session" label is gone: RoomStatus shows a calm, transient pill
  // instead, so no one string is always on screen. The board is a lazy chunk
  // (2 MB of tldraw), so it gets the budget ui-helpers.ts gives it.
  await expect(page.locator('.pen-board')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('mic-toggle')).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(() => page.evaluate(() => window.__penAudioRoom?.state ?? 'absent'), { timeout: 30_000 })
    .toBe('connected');
}

/** The ICE servers this browser was handed by the media server, credentials included. */
async function iceServersFromJoin(
  page: Page,
): Promise<Array<{ urls: string[]; username: string; credential: string }>> {
  return page.evaluate(() => {
    const engine = (
      window.__penAudioRoom as unknown as {
        engine?: {
          latestJoinResponse?: {
            iceServers?: Array<{ urls: string[]; username: string; credential: string }>;
          };
        };
      }
    )?.engine;
    return (engine?.latestJoinResponse?.iceServers ?? []).map((s) => ({
      urls: [...s.urls],
      username: s.username,
      credential: s.credential,
    }));
  });
}

/** Which kind of candidate the room's media is actually flowing over. */
async function selectedCandidateTypes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const room = window.__penAudioRoom;
    if (!room) return [];
    const engine = (
      room as unknown as {
        engine?: {
          pcManager?: {
            publisher?: { pc?: RTCPeerConnection };
            subscriber?: { pc?: RTCPeerConnection };
          };
        };
      }
    ).engine;
    const types: string[] = [];
    for (const pc of [engine?.pcManager?.publisher?.pc, engine?.pcManager?.subscriber?.pc]) {
      if (!pc) continue;
      const report = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      report.forEach((stat) => {
        byId.set(String(stat.id), stat as unknown as Record<string, unknown>);
      });
      for (const stat of byId.values()) {
        if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded') continue;
        if (stat.nominated !== true && stat.selected !== true) continue;
        const local = byId.get(String(stat.localCandidateId));
        if (local?.candidateType) types.push(String(local.candidateType));
      }
    }
    return types;
  });
}

/**
 * Ask for a relay-only allocation with the credentials the media server just
 * handed this browser. `typ relay` in the result means the TURN server
 * allocated a relay address for a real client — which is the whole feature.
 */
async function relayCandidates(
  page: Page,
  server: { urls: string[]; username: string; credential: string } | null,
): Promise<{ candidates: string[]; errors: Array<{ url: string; code: number }> }> {
  return page.evaluate(async (ice) => {
    const pc = new RTCPeerConnection({
      iceServers: ice
        ? [{ urls: ice.urls, username: ice.username, credential: ice.credential }]
        : [],
      iceTransportPolicy: 'relay',
    });
    const candidates: string[] = [];
    const errors: Array<{ url: string; code: number }> = [];
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) candidates.push(e.candidate.candidate);
    });
    pc.addEventListener('icecandidateerror', (e) => {
      const err = e as RTCPeerConnectionIceErrorEvent;
      errors.push({ url: err.url, code: err.errorCode });
    });
    pc.createDataChannel('turn-probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState === 'complete') resolve(undefined);
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(() => resolve(undefined), 10_000);
    });
    pc.close();
    return { candidates, errors };
  }, server);
}

test.describe('rooms: TURN', () => {
  test.beforeEach(async () => {
    test.skip(!(await livekitReachable()), `LiveKit is not reachable at ${LIVEKIT_HTTP}`);
  });

  test('every client is handed the TURN server, and it really allocates a relay', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { ctx, page } = await openSeat(browser);
    await joinAsHost(page);

    // 1. Nothing in the app configures ICE: the media server sent it with the join response.
    const servers = await iceServersFromJoin(page);
    const urls = servers.flatMap((s) => s.urls);
    test.skip(
      urls.every((u) => !u.startsWith('turn:') && !u.startsWith('turns:')),
      'this LiveKit server has no TURN enabled (deploy/livekit/livekit.dev.yaml)',
    );
    const turn = servers.find((s) => s.urls.some((u) => u.startsWith('turn')));
    expect(turn, 'a TURN server in the join response').toBeDefined();
    expect(turn?.username, 'a per-participant TURN credential').toBeTruthy();
    expect(turn?.credential).toBeTruthy();

    // 2. A relay-only peer connection with those credentials gets a relay candidate.
    const relay = await relayCandidates(page, turn ?? null);
    // Printed so a failing deployment shows what the browser actually got.
    console.log(
      `[turn] ${turn?.urls.join(', ')} → ${relay.candidates.filter((c) => c.includes(' typ relay')).join(' | ') || 'no relay candidate'}`,
    );
    expect(
      relay.candidates.some((c) => c.includes(' typ relay')),
      `relay candidates from ${turn?.urls.join(', ')} (errors: ${JSON.stringify(relay.errors)})`,
    ).toBe(true);

    // 3. The control: relay-only with nothing to relay through gathers nothing at all.
    const none = await relayCandidates(page, null);
    expect(none.candidates).toEqual([]);

    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 30_000 });
    await ctx.close();
  });

  test('an ordinary browser is not relayed', async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page } = await openSeat(browser);
    await joinAsHost(page);
    await expect.poll(() => selectedCandidateTypes(page), { timeout: 30_000 }).not.toEqual([]);
    const types = await selectedCandidateTypes(page);
    expect(types.length).toBeGreaterThan(0);
    // Relaying media through the server when the network does not need it is pure cost.
    expect(types.includes('relay')).toBe(false);
    await page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(page.getByText('Session saved')).toBeVisible({ timeout: 30_000 });
    await ctx.close();
  });
});
