import type { LedgerEntry, PlanCode } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import { SessionMetrics } from '../src/metrics.js';
import {
  AD_WINDOW_GRACE_MS,
  type AdOutcome,
  type AdPolicy,
  type KnowledgeAcquirer,
  SessionRoom,
} from '../src/room.js';
import {
  CANONICAL_ID,
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  segmentScript,
  sleep,
  until,
} from './fixtures.js';

const HOST = 'host-1234';
const SEGMENTS = 6;
const TAG = 'https://ads.example.test/vast?slot=pen';
const ADS = { everySegments: 2, durationMs: 15_000, skippableAfterMs: 5_000, tagUrl: TAG };

function model() {
  return new FakeLanguageModel(
    Array.from({ length: SEGMENTS }, (_, i) => segmentScript(i + 1)),
    [planCompletion(SEGMENTS), { purpose: 'recap', value: { points: ['x'] } }],
  );
}

async function makeRoom(opts: {
  plan: PlanCode;
  miss: boolean;
  sessionId: string;
  onEvent?: AdPolicy['onEvent'];
  revenuePerCompletionUsd?: number;
  /** A clock the test drives, for the ceiling a silent client is released on. */
  now?: () => number;
  observed?: Array<{ name: string; data: Record<string, unknown> }>;
}) {
  const { onten, packId, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const hit = await onten.registry.resolveTopic({
    text: 'How Transformers work in LLMs',
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  expect(hit.match).toBe('hit');
  const prepare = { calls: 0, adsWhenCalled: -1, adsWhenResolved: -1 };
  const acquirer: KnowledgeAcquirer = {
    async prepare() {
      prepare.calls += 1;
      prepare.adsWhenCalled = transport.ads().length;
      await sleep(60);
      prepare.adsWhenResolved = transport.ads().length;
      return { packId, provisional: false, background: Promise.resolve(null) };
    },
  };
  // The session's own telemetry (ADR-0011): what the ledger would hold.
  const entries: LedgerEntry[] = [];
  const metrics = new SessionMetrics({
    sessionId: opts.sessionId,
    startedAt: Date.now(),
    ledger: { append: (_id, entry) => void entries.push(entry) },
  });
  const room = new SessionRoom({
    sessionId: opts.sessionId,
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: opts.plan },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    resolution: opts.miss
      ? { ...hit, match: 'miss', packId: null, score: 0 }
      : { ...hit, canonicalKnowledgeId: CANONICAL_ID },
    onten,
    runtime: onten.newRuntime(),
    memo,
    model: model(),
    synthesizer: new SilentSynthesizer(),
    voice: 'v',
    sampleRate: 44100,
    transport,
    acquirer,
    targetMinutes: 6,
    metrics,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.observed
      ? {
          observer: {
            event: (name, data) => void opts.observed?.push({ name, data }),
            error: () => null,
          },
        }
      : {}),
    ads: {
      ...ADS,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.revenuePerCompletionUsd !== undefined
        ? { revenuePerCompletionUsd: opts.revenuePerCompletionUsd }
        : {}),
    },
  });
  return { room, transport, prepare, entries };
}

/** Plays the whole lesson as the host would: report each segment heard so the next one generates. */
async function teachAll(room: SessionRoom, transport: MemoryTransport): Promise<number[]> {
  const lastSeq: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    await until(
      () => transport.cues().filter((c) => c.thread === 'lesson' && c.segment === i).length >= 2,
    );
    const seqs = transport
      .cues()
      .filter((c) => c.thread === 'lesson' && c.segment === i)
      .map((c) => c.seq);
    const last = Math.max(...seqs);
    lastSeq[i] = last;
    room.handle(HOST, { kind: 'progress', seq: last, clockMs: 1000 * (i + 1) });
  }
  return lastSeq;
}

describe('SessionRoom ad budget', () => {
  it('shows a card only at segment boundaries 2 and 4 of a prepared six-segment lesson', async () => {
    const { room, transport, prepare } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-a',
    });
    await room.start();
    expect(room.getState().plan?.segments).toHaveLength(SEGMENTS);
    expect(prepare.calls).toBe(0);
    expect(transport.ads()).toEqual([]);

    const lastSeq = await teachAll(room, transport);
    await sleep(50);
    const ads = transport.ads();
    expect(ads.map((a) => a.afterSeq)).toEqual([lastSeq[2], lastSeq[4]]);
    expect(ads.map((a) => a.adId)).toEqual(['ad-sess-a-1', 'ad-sess-a-2']);
    expect(ads[0]).toMatchObject({
      skippableAfterMs: 5_000,
      durationMs: 15_000,
      format: 'video',
      tagUrl: TAG,
      slot: 'boundary',
    });
    // Never before the first sentence, never after the last segment.
    const firstCue = transport.messages.findIndex((m) => m.kind === 'cue');
    const firstAd = transport.messages.findIndex((m) => m.kind === 'ad');
    expect(firstAd).toBeGreaterThan(firstCue);
    const lastSegmentStart = transport.messages.findIndex(
      (m) => m.kind === 'cue' && m.cue.segment === SEGMENTS - 1,
    );
    const lastAd = transport.messages.findLastIndex((m) => m.kind === 'ad');
    expect(lastAd).toBeLessThan(lastSegmentStart);
    // The card is broadcast right after its segment's last cue, before the next segment starts.
    const seg3Start = transport.messages.findIndex((m) => m.kind === 'cue' && m.cue.segment === 3);
    expect(firstAd).toBeLessThan(seg3Start);
    await room.end();
  });

  it('on a topic miss shows the preparation card first and skips the first boundary card', async () => {
    const { room, transport, prepare } = await makeRoom({
      plan: 'free',
      miss: true,
      sessionId: 'sess-b',
    });
    await room.start();
    expect(room.getState().phase).toBe('live');
    expect(prepare.calls).toBe(1);
    // The card was already on its way to the learner when acquisition started.
    expect(prepare.adsWhenCalled).toBe(1);
    expect(prepare.adsWhenResolved).toBe(1);
    expect(transport.ads()[0]).toEqual({
      kind: 'ad',
      adId: 'ad-sess-b-prep',
      afterSeq: -1,
      skippableAfterMs: 5_000,
      durationMs: 15_000,
      format: 'video',
      tagUrl: TAG,
      slot: 'preparation',
    });
    await until(() => transport.messages.some((m) => m.kind === 'cue'));
    const prepAt = transport.messages.findIndex((m) => m.kind === 'ad');
    const firstCue = transport.messages.findIndex((m) => m.kind === 'cue');
    expect(prepAt).toBeGreaterThanOrEqual(0);
    expect(prepAt).toBeLessThan(firstCue);

    const lastSeq = await teachAll(room, transport);
    await sleep(50);
    const ads = transport.ads();
    expect(ads.map((a) => a.afterSeq)).toEqual([-1, lastSeq[4]]);
    expect(ads.map((a) => a.adId)).toEqual(['ad-sess-b-prep', 'ad-sess-b-2']);
    expect(ads.some((a) => a.afterSeq === lastSeq[2])).toBe(false);
    await room.end();
  });

  it('never sends a card to a standard-plan host, prepared or not', async () => {
    const miss = await makeRoom({ plan: 'standard', miss: true, sessionId: 'sess-c' });
    await miss.room.start();
    expect(miss.prepare.calls).toBe(1);
    expect(miss.prepare.adsWhenCalled).toBe(0);
    await teachAll(miss.room, miss.transport);
    await sleep(50);
    expect(miss.transport.ads()).toEqual([]);
    await miss.room.end();

    const hit = await makeRoom({ plan: 'standard', miss: false, sessionId: 'sess-d' });
    await hit.room.start();
    await teachAll(hit.room, hit.transport);
    await sleep(50);
    expect(hit.transport.ads()).toEqual([]);
    await hit.room.end();
  });
});

describe('SessionRoom ad outcomes (ad_event)', () => {
  it('accepts each lifecycle step once from the host, attributed to the ad slot', async () => {
    const outcomes: AdOutcome[] = [];
    const { room, transport, entries } = await makeRoom({
      plan: 'free',
      miss: true,
      sessionId: 'sess-e',
      onEvent: (o) => outcomes.push(o),
      revenuePerCompletionUsd: 0.008,
    });
    await room.start();
    const prep = transport.ads()[0];
    expect(prep?.adId).toBe('ad-sess-e-prep');
    room.handle(HOST, { kind: 'ad_event', adId: 'ad-sess-e-prep', event: 'ad_started', atMs: 0 });
    room.handle(HOST, {
      kind: 'ad_event',
      adId: 'ad-sess-e-prep',
      event: 'ad_completed',
      atMs: 15_000,
    });
    // A repeat of a step is dropped: the client cannot inflate the tally.
    room.handle(HOST, {
      kind: 'ad_event',
      adId: 'ad-sess-e-prep',
      event: 'ad_completed',
      atMs: 15_000,
    });
    expect(outcomes).toEqual([
      {
        sessionId: 'sess-e',
        adId: 'ad-sess-e-prep',
        slot: 'preparation',
        event: 'ad_started',
        atMs: 0,
        code: null,
      },
      {
        sessionId: 'sess-e',
        adId: 'ad-sess-e-prep',
        slot: 'preparation',
        event: 'ad_completed',
        atMs: 15_000,
        code: null,
      },
    ]);
    // Each accepted step is a ledger interaction (ADR-0011) — the repeat is not — and the
    // completed ad books the estimated revenue as one `ads` cost line beside the spend.
    const adInteractions = entries.flatMap((e) =>
      e.kind === 'interaction' && e.interaction.event.startsWith('ad_') ? [e.interaction] : [],
    );
    expect(adInteractions.map((i) => [i.participantId, i.event, i.props])).toEqual([
      [HOST, 'ad_started', { adId: 'ad-sess-e-prep', slot: 'preparation', atMs: 0 }],
      [HOST, 'ad_completed', { adId: 'ad-sess-e-prep', slot: 'preparation', atMs: 15_000 }],
    ]);
    const revenue = entries.flatMap((e) =>
      e.kind === 'cost' && e.line.component === 'ads' ? [e.line] : [],
    );
    expect(revenue).toEqual([
      {
        component: 'ads',
        unit: 'requests',
        units: 1,
        usd: 0.008,
        meta: {
          purpose: 'ad_revenue',
          estimate: true,
          adId: 'ad-sess-e-prep',
          slot: 'preparation',
        },
      },
    ]);
    await room.end();
  });

  it('drops reports for ads the room never sent and reports from anyone but the host', async () => {
    const outcomes: AdOutcome[] = [];
    const { room, transport, entries } = await makeRoom({
      plan: 'free',
      miss: true,
      sessionId: 'sess-f',
      onEvent: (o) => outcomes.push(o),
      revenuePerCompletionUsd: 0.008,
    });
    await room.start();
    room.handle(HOST, {
      kind: 'ad_event',
      adId: 'ad-someone-else',
      event: 'ad_completed',
      atMs: 1,
    });
    // Free rooms are solo (no `rooms` entitlement), so any other id is simply not a participant.
    const adId = transport.ads()[0]?.adId ?? '';
    room.handle('guest-1', { kind: 'ad_event', adId, event: 'ad_completed', atMs: 1 });
    expect(outcomes).toEqual([]);
    // Nothing a client could not legitimately report reaches the ledger or the revenue estimate.
    expect(entries.filter((e) => e.kind === 'cost' && e.line.component === 'ads')).toEqual([]);
    expect(
      entries.filter((e) => e.kind === 'interaction' && e.interaction.event.startsWith('ad_')),
    ).toEqual([]);
    room.handle(HOST, { kind: 'ad_event', adId, event: 'ad_error', atMs: 1, code: '1009' });
    expect(outcomes.map((o) => [o.event, o.code])).toEqual([['ad_error', '1009']]);
    await room.end();
  });
});

// ── voice and chat are refused for the length of an ad (ADR-0014) ─────────────

/** Teach up to and including `upto`, reporting each segment heard the way the host does. */
async function teachThrough(
  room: SessionRoom,
  transport: MemoryTransport,
  upto: number,
): Promise<number[]> {
  const lastSeq: number[] = [];
  for (let i = 0; i <= upto; i++) {
    await until(
      () => transport.cues().filter((c) => c.thread === 'lesson' && c.segment === i).length >= 2,
    );
    const last = Math.max(
      ...transport
        .cues()
        .filter((c) => c.thread === 'lesson' && c.segment === i)
        .map((c) => c.seq),
    );
    lastSeq[i] = last;
    room.handle(HOST, { kind: 'progress', seq: last, clockMs: 1000 * (i + 1) });
  }
  return lastSeq;
}

/**
 * The ad the room scheduled at the first boundary, with the host's playback
 * deliberately still short of it: the room schedules the ad while generating
 * segment 2, and the conductor holds it until the host reaches `afterSeq`.
 */
async function adScheduled(room: SessionRoom, transport: MemoryTransport) {
  const lastSeq = await teachThrough(room, transport, 1);
  await until(() => transport.ads().length > 0);
  const ad = transport.ads()[0];
  if (!ad) throw new Error('no ad was scheduled');
  return { ad, lastSeq };
}

/** Exactly what a learner's voice or keyboard produces: an interrupt, then a final transcript. */
function askAloud(room: SessionRoom, utteranceId: string, text: string): void {
  room.handle(HOST, { kind: 'interrupt', atSeq: 1, sayId: null, offsetMs: 0 });
  room.handle(HOST, { kind: 'transcript', utteranceId, text, final: true });
}

describe('SessionRoom refuses questions from behind an ad', () => {
  it('drops the interrupt and the transcript while the ad is up, and takes them the moment it ends', async () => {
    const observed: Array<{ name: string; data: Record<string, unknown> }> = [];
    const { room, transport } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-ad-guard',
      observed,
    });
    await room.start();
    const { ad } = await adScheduled(room, transport);
    // The host has played up to the cue the ad hangs on: the overlay is up.
    room.handle(HOST, { kind: 'progress', seq: ad.afterSeq, clockMs: 9_000 });
    expect(room.getState().mode).toBe('teaching');

    const captionsBefore = transport.messages.filter((m) => m.kind === 'caption').length;
    askAloud(room, 'u-behind-the-ad', 'why do we divide by the square root of d?');
    await sleep(30);

    // Nothing moved: no floor, no caption to the room, no turn.
    expect(room.getState().mode).toBe('teaching');
    expect(room.getState().floor).toBeNull();
    expect(transport.messages.filter((m) => m.kind === 'caption')).toHaveLength(captionsBefore);
    // Dropped, not swallowed.
    expect(
      observed.filter((e) => e.name === 'room.ad_input_refused').map((e) => e.data.kind),
    ).toEqual(['interrupt', 'transcript']);

    // The player says how it ended; the learner has the room back on the next frame.
    room.handle(HOST, { kind: 'ad_event', adId: ad.adId, event: 'ad_skipped', atMs: 5_200 });
    askAloud(room, 'u-after-the-ad', 'why do we divide by the square root of d?');
    await sleep(30);
    expect(room.getState().floor).toBe(HOST);
    expect(transport.messages.filter((m) => m.kind === 'caption').length).toBeGreaterThan(
      captionsBefore,
    );
    await room.end();
  });

  it('still takes a question at a boundary the host has not reached: a scheduled ad is not an ad', async () => {
    const { room, transport } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-ad-pending',
    });
    await room.start();
    const { ad, lastSeq } = await adScheduled(room, transport);
    // The ad is scheduled after a cue the host is still short of…
    expect(ad.afterSeq).toBeGreaterThan(lastSeq[1] ?? 0);
    room.handle(HOST, { kind: 'progress', seq: Math.max(0, ad.afterSeq - 1), clockMs: 8_000 });

    askAloud(room, 'u-before-the-ad', 'why do we divide by the square root of d?');
    await sleep(30);
    expect(room.getState().floor).toBe(HOST);
    await room.end();
  });

  it("releases the learner on the ad's own ceiling when the client never says how it ended", async () => {
    let clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-ad-ceiling',
      now: () => clock,
    });
    await room.start();
    const { ad } = await adScheduled(room, transport);
    room.handle(HOST, { kind: 'progress', seq: ad.afterSeq, clockMs: 9_000 });

    askAloud(room, 'u-during', 'hello?');
    await sleep(30);
    expect(room.getState().floor).toBeNull();

    // Past the ad's own duration plus the grace the report is given to arrive.
    clock += ADS.durationMs + AD_WINDOW_GRACE_MS + 1;
    askAloud(room, 'u-after-ceiling', 'hello?');
    await sleep(30);
    expect(room.getState().floor).toBe(HOST);
    await room.end();
  });

  it("closes the window on the host's own ad_ended report as well", async () => {
    const { room, transport } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-ad-report',
    });
    await room.start();
    const { ad } = await adScheduled(room, transport);
    room.handle(HOST, { kind: 'progress', seq: ad.afterSeq, clockMs: 9_000 });
    askAloud(room, 'u-1', 'nope');
    await sleep(30);
    expect(room.getState().floor).toBeNull();

    room.handle(HOST, {
      kind: 'report',
      event: 'ad_ended',
      props: { adId: ad.adId, ms: 7_000, reason: 'timeout' },
    });
    askAloud(room, 'u-2', 'now then');
    await sleep(30);
    expect(room.getState().floor).toBe(HOST);
    await room.end();
  });
});

describe('an ad hung on a cue the host has already played', () => {
  it('still shuts the room, instead of waiting for a report that cannot come', async () => {
    // `progress` opens the ad window only on a report that moves the clock
    // forward (`seq > hostProgressSeq`). An ad scheduled for a cue the host has
    // already passed therefore used to wait for a report that would never
    // arrive: the overlay on the learner's screen, and the room still taking
    // voice, chat and reactions from behind it.
    //
    // This is the defect four CI failures of the reactions spec were pointing
    // at. That test reported progress to the end of a segment and then
    // reported the ad's own cue, which is backwards, so the guard dropped it —
    // and whether it happened depended on how many cues had arrived by then,
    // which is why it only failed under load.
    const { room, transport } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'ad-already-played',
    });
    await room.start();
    const { ad } = await adScheduled(room, transport);

    // The host reports well past the cue the ad hangs on.
    room.handle(HOST, { kind: 'progress', seq: ad.afterSeq + 50, clockMs: 12_000 });
    const before = transport.messages.length;
    askAloud(room, 'u-behind-the-ad', 'why does that work?');
    expect(
      transport.messages.slice(before).filter((m) => m.kind !== 'ad'),
      'nothing may be taken from behind an ad that is already on screen',
    ).toEqual([]);
    await room.end();
  });
});
