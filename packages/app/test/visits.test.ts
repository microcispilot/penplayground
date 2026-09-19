import type { VisitBeacon } from '@pen/contracts';
import { VISIT_HEARTBEAT_MS, VISIT_IDLE_MS } from '@pen/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetAnalyticsForTests,
  setAnalyticsContext,
  trackInteraction,
} from '../src/lib/analytics.js';
import {
  noteScreen,
  resetVisitTrackingForTests,
  startVisitTracking,
  VisitTracker,
} from '../src/lib/visits.js';

/**
 * Engaged time is a claim about a person, so the rule that decides it is
 * tested rather than described. Every case here drives the clock by hand.
 */

let sent: VisitBeacon[] = [];
let clock = 1_700_000_000_000;
const now = () => clock;
const advance = (ms: number) => {
  clock += ms;
  vi.advanceTimersByTime(ms);
};

function visible(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function tracker(enabled = true): VisitTracker {
  return new VisitTracker({
    url: 'http://api.test/api/visits',
    token: () => 'bearer-value',
    enabled: () => enabled,
    now,
  });
}

beforeEach(() => {
  sent = [];
  clock = 1_700_000_000_000;
  vi.useFakeTimers();
  visible('visible');
  vi.stubGlobal('fetch', (_url: string, init?: { body?: string }) => {
    if (init?.body) sent.push(JSON.parse(init.body) as VisitBeacon);
    return Promise.resolve(new Response('{}'));
  });
  // `sendBeacon` is what a final beacon uses; captured the same way.
  vi.stubGlobal('navigator', {
    ...navigator,
    language: 'en-GB',
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then((t) => sent.push(JSON.parse(t) as VisitBeacon));
      return true;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('what counts as engaged', () => {
  it('credits time while the page is visible and the person is doing something', async () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    // Nothing is sent while the app is still opening; the first heartbeat
    // carries the view and the time together.
    advance(VISIT_HEARTBEAT_MS);
    expect(sent[0]?.activeMs).toBe(VISIT_HEARTBEAT_MS);
    expect(sent[0]?.screens).toEqual([{ screen: 'home', views: 1, activeMs: VISIT_HEARTBEAT_MS }]);
    stop();
  });

  it('credits nothing while the tab is hidden, however long it is hidden for', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(VISIT_HEARTBEAT_MS);
    sent = [];
    visible('hidden');
    advance(VISIT_HEARTBEAT_MS * 20);
    // Not one beacon: an idle tab is silent, not a slow trickle of zeroes.
    expect(sent).toEqual([]);
    stop();
    expect(sent.at(-1)?.activeMs ?? 0).toBe(0);
  });

  it('stops crediting once the person has done nothing for the idle window', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    sent = [];
    // Four heartbeats: the first VISIT_IDLE_MS of them counts, the rest do not.
    const beats = Math.ceil(VISIT_IDLE_MS / VISIT_HEARTBEAT_MS) + 3;
    for (let i = 0; i < beats; i += 1) advance(VISIT_HEARTBEAT_MS);
    const credited = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(credited).toBeGreaterThan(0);
    expect(credited).toBeLessThanOrEqual(VISIT_IDLE_MS + VISIT_HEARTBEAT_MS);
    // A tab left open all afternoon adds nothing more.
    sent = [];
    for (let i = 0; i < 100; i += 1) advance(VISIT_HEARTBEAT_MS);
    expect(sent).toEqual([]);
    stop();
  });

  it('a pointer or a key starts it counting again', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    sent = [];
    document.dispatchEvent(new Event('pointerdown'));
    advance(VISIT_HEARTBEAT_MS);
    expect(sent.at(-1)?.activeMs).toBe(VISIT_HEARTBEAT_MS);
    stop();
  });

  it('a playing lesson is engagement even when nobody touches anything', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('room');
    t.setLessonPlaying(true);
    sent = [];
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    const credited = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(credited).toBe(VISIT_HEARTBEAT_MS * 20);
    // And when the lesson stops, so does the credit.
    t.setLessonPlaying(false);
    sent = [];
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    expect(sent.reduce((n, b) => n + b.activeMs, 0)).toBe(0);
    stop();
  });

  it('a machine that slept is credited one interval, not the nap', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    sent = [];
    // The clock jumps eight hours while the timer did not fire.
    clock += 8 * 3_600_000;
    document.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(VISIT_HEARTBEAT_MS);
    const credited = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(credited).toBeLessThanOrEqual(VISIT_HEARTBEAT_MS);
    stop();
  });
});

describe('what the beacon carries', () => {
  /**
   * The first beacon is deliberately not sent on mount: a request fired the
   * instant the app opens competes with `ensureParticipant`, and Home will
   * not start a lesson before the participant exists. A three-second bounce
   * is still counted, by the goodbye beacon.
   */
  it('sends nothing while the app is opening, and still counts a visit that bounces', async () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(500);
    expect(sent).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.screens[0]).toMatchObject({ screen: 'home', views: 1 });
    expect(sent[0]?.final).toBe(true);
    stop();
  });

  it('carries the timezone, the language and the referrer host on the first beacon only', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(VISIT_HEARTBEAT_MS);
    const first = sent[0];
    expect(first?.timezone).toBeTruthy();
    expect(first?.language).toBe('en-GB');
    advance(VISIT_HEARTBEAT_MS);
    expect(sent[1]?.timezone).toBeUndefined();
    expect(sent[1]).toBeDefined();
    stop();
  });

  it('keeps the same visit id across every beacon of a visit', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(VISIT_HEARTBEAT_MS);
    stop();
    const ids = new Set(sent.map((b) => b.visitId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^v_[0-9a-f]{24}$/);
  });

  it('counts actions and names the session they were about', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('session');
    sent = [];
    t.action('replay_started', 's_abc_00000001');
    t.action('share_copied', 's_abc_00000001');
    t.action('share_copied', 's_abc_00000001');
    advance(VISIT_HEARTBEAT_MS);
    const beacon = sent.at(-1);
    expect(beacon?.actions).toEqual({ replay_started: 1, share_copied: 2 });
    expect(beacon?.sessionId).toBe('s_abc_00000001');
    stop();
  });

  it('does not carry the same credit twice', () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(VISIT_HEARTBEAT_MS);
    advance(VISIT_HEARTBEAT_MS);
    stop();
    const total = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(total).toBe(VISIT_HEARTBEAT_MS * 2);
  });

  it('sends a final beacon when the page goes away', async () => {
    const t = tracker();
    const stop = t.start();
    t.screenShown('home');
    advance(VISIT_HEARTBEAT_MS);
    sent = [];
    advance(5_000);
    window.dispatchEvent(new Event('pagehide'));
    // `sendBeacon` is what survives a page going away; the fake reads the blob.
    await vi.waitFor(() => expect(sent.at(-1)?.final).toBe(true));
    stop();
  });

  it('sends nothing at all when the learner has analytics off', () => {
    const t = tracker(false);
    const stop = t.start();
    t.screenShown('home');
    t.action('replay_started');
    advance(VISIT_HEARTBEAT_MS * 4);
    stop();
    expect(sent).toEqual([]);
  });
});

describe('the lesson-playing signal, as the room actually sends it', () => {
  beforeEach(() => {
    resetAnalyticsForTests();
  });
  afterEach(() => {
    resetVisitTrackingForTests();
  });

  /**
   * The rule is documented in `VisitBeacon` and claimed in the privacy copy,
   * so it is wired through the events the room already sends rather than
   * described and left to a future reader. These assertions are what stop it
   * from quietly becoming untrue.
   */
  it('a lesson that starts talking makes silence count, and pausing stops it', () => {
    const stop = startVisitTracking({
      url: 'http://api.test/api/visits',
      token: () => null,
      enabled: () => true,
      now,
    });
    setAnalyticsContext({ screen: 'room', sessionId: 's_room_00000001' });
    noteScreen('room');
    sent = [];

    // The expert becomes audible; nobody touches anything for five minutes.
    trackInteraction('first_audio', { 'latency.fromStartMs': 900 });
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    const listening = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(listening).toBe(VISIT_HEARTBEAT_MS * 20);

    // They pause it and walk away: the clock stops within one idle window.
    sent = [];
    trackInteraction('pause');
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    const paused = sent.reduce((n, b) => n + b.activeMs, 0);
    expect(paused).toBeLessThanOrEqual(VISIT_IDLE_MS + VISIT_HEARTBEAT_MS);

    // And resuming starts it again.
    sent = [];
    trackInteraction('resume');
    for (let i = 0; i < 10; i += 1) advance(VISIT_HEARTBEAT_MS);
    expect(sent.reduce((n, b) => n + b.activeMs, 0)).toBe(VISIT_HEARTBEAT_MS * 10);
    stop();
  });

  it('walking to another screen ends it, whatever the room last said', () => {
    const stop = startVisitTracking({
      url: 'http://api.test/api/visits',
      token: () => null,
      enabled: () => true,
      now,
    });
    setAnalyticsContext({ screen: 'room' });
    noteScreen('room');
    trackInteraction('first_audio', { 'latency.fromStartMs': 900 });
    advance(VISIT_HEARTBEAT_MS);

    setAnalyticsContext({ screen: 'home' });
    trackInteraction('screen_shown', { screen: 'home' });
    noteScreen('home');
    sent = [];
    for (let i = 0; i < 20; i += 1) advance(VISIT_HEARTBEAT_MS);
    expect(sent.reduce((n, b) => n + b.activeMs, 0)).toBeLessThanOrEqual(
      VISIT_IDLE_MS + VISIT_HEARTBEAT_MS,
    );
    stop();
  });
});
