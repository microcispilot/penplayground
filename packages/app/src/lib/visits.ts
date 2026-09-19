import type { VisitAction, VisitBeacon, VisitScreenBeacon } from '@pen/contracts';
import { VISIT_HEARTBEAT_MS, VISIT_IDLE_MS } from '@pen/contracts';

/**
 * Engaged time, measured honestly (ADR-0027).
 *
 * The number the owner asked for is "how much *active* time did they spend",
 * and the easy way to get it — when the page opened, minus when it closed —
 * is a lie: it counts a tab left open overnight as a night of learning. So
 * this counts a millisecond only while all of this holds:
 *
 *  - the document is visible, and
 *  - the person did something within the last `VISIT_IDLE_MS` — a pointer, a
 *    key, a scroll, a touch — **or** a lesson is audibly playing, which is
 *    the one case where sitting perfectly still *is* the engagement. The room
 *    turns that on with `setLessonPlaying(true)`.
 *
 * What it sends is that credit and nothing else: a screen name (a route
 * pattern, never an id), a count of views, a bounded set of action counters,
 * the browser's IANA timezone and language, and the referrer's host. No URL,
 * no topic, no content — and the whole of it goes nowhere if the learner has
 * analytics off, because the server drops it (`participants.analytics_opt_out`).
 *
 * It is fire-and-forget in every sense: never awaited, never retried, never
 * surfaced. A blocked request loses a count and nothing else.
 */

/**
 * How long the first beacon waits. Long enough that the app's own opening
 * calls — the bearer above all — are never behind it, short enough that a
 * visit which lasts a few seconds is still counted by the next heartbeat.
 */
const FIRST_BEACON_DELAY_MS = 3_000;

/** The id is minted per visit and never written to the device, so it recognises nobody later. */
function newVisitId(): string {
  const bytes = new Uint8Array(12);
  // Every browser this ships to has `crypto.getRandomValues`; a render target
  // that does not simply gets a less random id, never a thrown page.
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `v_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface Pending {
  activeMs: number;
  screens: Map<string, { views: number; activeMs: number }>;
  actions: Map<VisitAction, number>;
  sessionId: string | null;
}

const empty = (): Pending => ({
  activeMs: 0,
  screens: new Map(),
  actions: new Map(),
  sessionId: null,
});

export interface VisitTrackerOptions {
  /** Where to POST the beacon; `${apiUrl}/api/visits`. */
  url: string;
  /** The bearer, read at send time so a sign-in mid-visit is picked up. */
  token: () => string | null;
  /** Off for a headless export render, and off when the learner has analytics off. */
  enabled: () => boolean;
  now?: () => number;
}

export class VisitTracker {
  private readonly visitId = newVisitId();
  private pending = empty();
  private screen: string | null = null;
  private lastTick: number;
  private lastInput: number;
  private lessonPlaying = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstBeacon: ReturnType<typeof setTimeout> | null = null;
  private firstBeaconSent = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly detach: Array<() => void> = [];

  constructor(private readonly o: VisitTrackerOptions) {
    this.now = o.now ?? Date.now;
    this.lastTick = this.now();
    this.lastInput = this.now();
  }

  /** Begin measuring. Returns the teardown, so a React effect can just hand it back. */
  start(): () => void {
    if (typeof document === 'undefined') return () => undefined;
    const input = () => {
      this.lastInput = this.now();
    };
    for (const type of ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const) {
      document.addEventListener(type, input, { passive: true });
      this.detach.push(() => document.removeEventListener(type, input));
    }
    // Coming back to the tab restarts the clock rather than crediting the time
    // it was away: `tick` measures from `lastTick`, which this moves forward.
    const visibility = () => {
      this.lastTick = this.now();
      if (document.visibilityState === 'visible') this.lastInput = this.now();
    };
    document.addEventListener('visibilitychange', visibility);
    this.detach.push(() => document.removeEventListener('visibilitychange', visibility));

    // `pagehide` is the one that fires on iOS, where `beforeunload` does not.
    const leaving = () => this.flush(true);
    window.addEventListener('pagehide', leaving);
    this.detach.push(() => window.removeEventListener('pagehide', leaving));

    this.timer = setInterval(() => this.tick(), VISIT_HEARTBEAT_MS);
    // The first beacon, once the app has had the network to itself for a
    // moment. Not on the critical path of anything, by construction.
    this.firstBeacon = setTimeout(() => {
      this.firstBeacon = null;
      this.tick();
    }, FIRST_BEACON_DELAY_MS);
    return () => this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.firstBeacon) clearTimeout(this.firstBeacon);
    this.firstBeacon = null;
    for (const off of this.detach.splice(0)) off();
    this.flush(true);
  }

  /**
   * A route change. Recorded, never sent: the first beacon waits for
   * `FIRST_BEACON_DELAY_MS`, because a request fired the instant the app
   * mounts competes with the app's own first calls — and the one that must
   * win is `ensureParticipant`, since Home refuses to start a lesson until
   * the participant exists. A learner who clicked Start in that moment would
   * get "Connecting to Pen Playground…" instead of a lesson, which is a real
   * cost for a statistic. A visit shorter than the delay is still counted:
   * `pagehide` flushes whatever has accumulated.
   */
  screenShown(screen: string): void {
    this.credit();
    this.screen = screen;
    const row = this.pending.screens.get(screen) ?? { views: 0, activeMs: 0 };
    row.views += 1;
    this.pending.screens.set(screen, row);
  }

  /** One of the counted things happened. Unknown names are impossible: the type is closed. */
  action(name: VisitAction, sessionId?: string): void {
    this.pending.actions.set(name, (this.pending.actions.get(name) ?? 0) + 1);
    if (sessionId) this.pending.sessionId = sessionId;
  }

  /** The room: audio is playing, so silence is engagement rather than absence. */
  setLessonPlaying(playing: boolean): void {
    this.credit();
    this.lessonPlaying = playing;
  }

  /** Whether the last interval counted, and the rule that decided it. */
  private engaged(at: number): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    return this.lessonPlaying || at - this.lastInput <= VISIT_IDLE_MS;
  }

  /** Move the clock forward, crediting only what was engaged. */
  private credit(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.lastTick);
    this.lastTick = at;
    if (elapsed === 0 || !this.engaged(at)) return;
    // A machine that slept wakes with a huge elapsed; one interval is the most
    // any single step may be worth, and the server clamps it again.
    const credited = Math.min(elapsed, VISIT_HEARTBEAT_MS);
    this.pending.activeMs += credited;
    if (this.screen) {
      const row = this.pending.screens.get(this.screen) ?? { views: 0, activeMs: 0 };
      row.activeMs += credited;
      this.pending.screens.set(this.screen, row);
    }
  }

  private tick(): void {
    this.credit();
    // Nothing happened and nothing to say: no request. An idle tab is silent.
    if (
      this.pending.activeMs === 0 &&
      this.pending.actions.size === 0 &&
      this.pending.screens.size === 0
    )
      return;
    this.flush(false);
  }

  /** Send what has accumulated and start a fresh window. Never throws. */
  flush(final: boolean): void {
    this.credit();
    if (!this.o.enabled()) {
      this.pending = empty();
      return;
    }
    const hasSomething =
      this.pending.activeMs > 0 || this.pending.actions.size > 0 || this.pending.screens.size > 0;
    if (!hasSomething && this.firstBeaconSent) return;

    const screens: VisitScreenBeacon[] = [...this.pending.screens].map(([screen, row]) => ({
      screen,
      views: row.views,
      activeMs: row.activeMs,
    }));
    const body: VisitBeacon = {
      visitId: this.visitId,
      activeMs: this.pending.activeMs,
      screens,
      actions: Object.fromEntries(this.pending.actions) as VisitBeacon['actions'],
      sessionId: this.pending.sessionId,
      final,
      ...(this.firstBeaconSent ? {} : firstBeaconContext()),
    };
    this.pending = empty();
    this.firstBeaconSent = true;
    send(this.o.url, body, this.o.token(), final);
  }
}

/** Where this visit came from and what clock it is on — sent once, on the first beacon. */
function firstBeaconContext(): Partial<VisitBeacon> {
  const out: Partial<VisitBeacon> = {};
  try {
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // No Intl: the server simply has no country for this visit, and says so.
  }
  if (typeof navigator !== 'undefined') out.language = navigator.language;
  if (typeof document !== 'undefined' && document.referrer) {
    try {
      const host = new URL(document.referrer).hostname;
      // Our own pages are not a referrer; only somewhere else is.
      if (host !== window.location.hostname) out.referrerHost = host;
    } catch {
      // A referrer we cannot parse is no referrer.
    }
  }
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search);
    const utm = (name: string) => q.get(name)?.slice(0, 60) || undefined;
    out.campaignSource = utm('utm_source');
    out.campaignMedium = utm('utm_medium');
    out.campaignName = utm('utm_campaign');
  }
  return out;
}

/**
 * `sendBeacon` for the last one — it is the only thing that survives the page
 * going away — and a keepalive `fetch` otherwise, because `sendBeacon` cannot
 * carry the bearer. Both are fire-and-forget.
 *
 * The final beacon goes as `text/plain` on purpose. `application/json` is not
 * a CORS-safelisted content type, so it would need a preflight, and
 * `sendBeacon` cannot make one: in production the app and the API are the
 * same origin and it would not matter, but in development they are two ports
 * and every goodbye would be dropped. The server parses the body as JSON
 * whatever the header says.
 */
function send(url: string, body: VisitBeacon, token: string | null, final: boolean): void {
  const json = JSON.stringify(body);
  try {
    if (final && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([json], { type: 'text/plain;charset=UTF-8' }));
      return;
    }
    void fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: json,
    }).catch(() => undefined);
  } catch {
    // A blocked request loses a count. It never reaches a screen.
  }
}

// ── the one tracker this app has ─────────────────────────────────────────────
let current: VisitTracker | null = null;

export function startVisitTracking(options: VisitTrackerOptions): () => void {
  current?.stop();
  current = new VisitTracker(options);
  const stop = current.start();
  return () => {
    stop();
    current = null;
  };
}

/** Called from the route tracker; a no-op before tracking starts. */
export function noteScreen(screen: string): void {
  current?.screenShown(screen);
}

/** Called wherever one of the counted things happens. */
export function noteVisitAction(name: VisitAction, sessionId?: string): void {
  current?.action(name, sessionId);
}

/** The room, while the expert is audible. */
export function noteLessonPlaying(playing: boolean): void {
  current?.setLessonPlaying(playing);
}

/** Tests: forget the module's tracker. */
export function resetVisitTrackingForTests(): void {
  current?.stop();
  current = null;
}
