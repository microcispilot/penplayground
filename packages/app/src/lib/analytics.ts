import type { InteractionName, InteractionProps, VisitAction } from '@pen/contracts';
import type { PostHog } from 'posthog-js';
import type { Monitor, Platform } from '../platform/types.js';
import { noteLessonPlaying, noteVisitAction } from './visits.js';

/**
 * Client analytics (ADR-0011). Page views and typed interaction events; no
 * autocapture, no session recording, no PII, no content: every event carries
 * codes, counts and timings only, plus the session context (which session,
 * host or guest, which screen, which phase). Inside a room the same event is
 * also sent to the API as a `report`, so the session's ledger has it.
 */
export interface AnalyticsContext {
  sessionId: string | null;
  role: 'host' | 'guest' | null;
  screen: string;
  phase: string | null;
}

const context: AnalyticsContext = { sessionId: null, role: null, screen: '', phase: null };
let reporter: ((event: InteractionName, props: InteractionProps) => void) | null = null;
let monitor: Monitor | null = null;
/** When the learner clicked Start on Home (ms epoch); the room measures time-to-first-audio from it. */
let startClickedAt: number | null = null;

/**
 * Start analytics, cookieless (ADR-0018) and off the critical path (ADR-0011).
 *
 * `persistence: 'memory'` is the whole privacy argument in one option: nothing
 * identifying is written to the device, so there is no cookie or cross-visit
 * identifier to ask permission for, and therefore no banner in front of a
 * lesson. The cost is that a returning learner is a new anonymous id each
 * visit — acceptable, because every question this product asks of its
 * analytics is about sessions, latencies and cost, not about people.
 *
 * A learner who has turned analytics off under Privacy choices is not
 * initialised at all: the SDK is never even fetched, rather than fetched and
 * then told to stay quiet.
 *
 * posthog-js is ~200 kB that nothing on the first screen needs, so it is
 * fetched after the app has booted instead of inside the entry bundle. Until
 * it lands (or when it never does — a blocked host, an offline launch) the
 * calls below stay synchronous and simply queue: analytics must never be on
 * the critical path of a lesson, and must never throw into a screen.
 */
let client: PostHog | null = null;
const pending: Array<(ph: PostHog) => void> = [];
/** Bounded: a session that never loads the SDK must not grow a queue forever. */
const PENDING_LIMIT = 200;
/**
 * The learner said no while the SDK was still being fetched. Lazy loading opens
 * a window the eager version did not have — a few hundred milliseconds in which
 * "turn analytics off" has nothing to turn off yet — and without this the
 * import would land afterwards and start capturing anyway.
 */
let optedOut = false;

function withClient(fn: (ph: PostHog) => void): void {
  if (client) {
    fn(client);
    return;
  }
  if (pending.length < PENDING_LIMIT) pending.push(fn);
}

export function initAnalytics(platform: Platform, choice: { analytics: boolean }): void {
  monitor = platform.monitor ?? null;
  const analytics = platform.analytics;
  if (!analytics || !choice.analytics) return;
  optedOut = false;
  void import('posthog-js')
    .then(({ default: posthog }) => {
      // Answered "no" while this was in flight: never initialise, so no network
      // call is made at all rather than one made and then regretted.
      if (optedOut) {
        pending.length = 0;
        return;
      }
      posthog.init(analytics.token, {
        api_host: analytics.host,
        autocapture: false,
        capture_pageview: true,
        capture_pageleave: true,
        disable_session_recording: true,
        // No cookies, no localStorage identifier, nothing left behind.
        persistence: 'memory',
        cross_subdomain_cookie: false,
        person_profiles: 'identified_only',
      });
      posthog.register({ app: `pen-academy-${platform.name}` });
      client = posthog;
      for (const fn of pending.splice(0)) fn(posthog);
    })
    .catch((error: unknown) => {
      // Never a user-visible failure: the product works without product analytics.
      pending.length = 0;
      monitor?.breadcrumb('analytics_unavailable', {
        code: error instanceof Error ? error.name : 'unknown',
      });
    });
}

/**
 * Apply a change made in Privacy choices. Turning it off stops capture at
 * once and forgets the in-memory identity; turning it on takes effect from the
 * next page load, when `initAnalytics` runs with the new choice.
 */
export function applyPrivacyChoice(choice: { analytics: boolean }): void {
  optedOut = !choice.analytics;
  const ph = client;
  // Nothing loaded yet: the flag above is the whole answer. Turning it off
  // stops the in-flight import from initialising and drops what was queued for
  // it; turning it on is the next page load's job (see `initAnalytics`).
  if (!ph) {
    if (optedOut) pending.length = 0;
    return;
  }
  if (choice.analytics) ph.opt_in_capturing();
  else {
    ph.opt_out_capturing();
    ph.reset();
  }
}

export function track(
  event: string,
  properties: Record<string, string | number | boolean> = {},
): void {
  withClient((ph) => ph.capture(event, properties));
}

export function identify(id: string): void {
  withClient((ph) => ph.identify(id));
}

/** Sign-out: the next participant must not inherit this person's PostHog identity. */
export function resetAnalytics(): void {
  withClient((ph) => ph.reset());
}

/** The room (or a screen) tells analytics where the learner is; Sentry gets the same as tags. */
export function setAnalyticsContext(patch: Partial<AnalyticsContext>): void {
  Object.assign(context, patch);
  if (patch.sessionId !== undefined) monitor?.setTag('sessionId', patch.sessionId);
  if (patch.role !== undefined) monitor?.setTag('role', patch.role);
  if (patch.screen !== undefined) monitor?.setTag('screen', patch.screen);
}

export function getAnalyticsContext(): Readonly<AnalyticsContext> {
  return context;
}

/** RoomSession installs the socket reporter while connected; null outside a room. */
export function setRoomReporter(
  fn: ((event: InteractionName, props: InteractionProps) => void) | null,
): void {
  reporter = fn;
}

/** The learner clicked Start: remembered so the room can measure click → first audible audio. */
export function markStartClicked(): void {
  startClickedAt = Date.now();
  // The one action that is a decision rather than a screen: it is what turns
  // a visit into a lesson, and the visit conversion rate is built on it.
  noteVisitAction('session_started');
}

/**
 * The interactions that are also visit counters (ADR-0027). Kept here rather
 * than at each call site so a new screen cannot forget one, and deliberately
 * a small closed map: a visit counts what a person decided to do, not
 * everything that happened to them.
 */
const VISIT_COUNTERS: Partial<Record<InteractionName, VisitAction>> = {
  replay_started: 'replay_started',
  download_requested: 'download_requested',
};

/**
 * Whether a lesson is audible right now, which is the one state in which
 * sitting perfectly still counts as engagement (ADR-0027). Derived from the
 * events the room and the replay already send, rather than from a new signal
 * nobody would remember to send: the expert starts talking, or a paused
 * lesson resumes, and it is on; the learner pauses, leaves, ends, or walks to
 * another screen, and it is off.
 */
const LESSON_AUDIBLE: Partial<Record<InteractionName, boolean>> = {
  first_audio: true,
  answer_started: true,
  resume: true,
  pause: false,
  leave: false,
  end: false,
  recap_shown: false,
};

/** The two screens a lesson can be audible on; any other screen turns it off. */
const LESSON_SCREENS = new Set(['room', 'replay']);

/** Consumes the Start click (once) when it is recent enough to belong to this room visit. */
export function takeStartClickedAt(maxAgeMs = 90_000): number | null {
  const at = startClickedAt;
  startClickedAt = null;
  return at !== null && Date.now() - at <= maxAgeMs ? at : null;
}

/**
 * One typed interaction: to PostHog with the session context, to the room's
 * ledger via `report` when in a room, and as a Sentry breadcrumb so an error
 * report shows what the learner did before it.
 */
export function trackInteraction(
  event: InteractionName,
  props: InteractionProps = {},
  opts: {
    /** false when the room already receives this step through its own validated message (`ad_event`). */
    report?: boolean;
  } = {},
): void {
  const counter = VISIT_COUNTERS[event];
  if (counter) noteVisitAction(counter, context.sessionId ?? undefined);
  const audible = LESSON_AUDIBLE[event];
  if (audible !== undefined) noteLessonPlaying(audible);
  // Leaving the room or the replay ends it however the learner left.
  if (event === 'screen_shown' && !LESSON_SCREENS.has(String(props.screen ?? context.screen)))
    noteLessonPlaying(false);
  const enriched: Record<string, string | number | boolean> = { ...props, screen: context.screen };
  if (context.sessionId) enriched.sessionId = context.sessionId;
  if (context.role) enriched.role = context.role;
  if (context.phase) enriched.phase = context.phase;
  track(event, enriched);
  if (opts.report !== false) reporter?.(event, props);
  monitor?.breadcrumb(event, props);
}

/** A client-side failure: captured (content-free) and, in a room, written to the ledger with its Sentry ref. */
export function reportClientError(code: string, error: unknown, stage?: string): string | null {
  const ref = monitor?.captureError(code, error, { ...context, stage: stage ?? null }) ?? null;
  trackInteraction('error_shown', ref ? { code, ref } : { code });
  return ref;
}

/** Tests: reset module state. */
export function resetAnalyticsForTests(): void {
  Object.assign(context, { sessionId: null, role: null, screen: '', phase: null });
  reporter = null;
  monitor = null;
  startClickedAt = null;
  client = null;
  optedOut = false;
  pending.length = 0;
}
