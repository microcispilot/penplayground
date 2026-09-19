import { z } from 'zod';
import type { PlanCode } from './billing.js';
import { ParticipantId, SessionId } from './ids.js';

/**
 * Statistics and reports over our own data (ADR-0027).
 *
 * This is not an event pipeline and not a second PostHog. It is two things:
 * the per-session and per-stage facts a finished session leaves behind, rolled
 * out of its recording ledger into rows SQL can group; and a visit record that
 * counts what a person did on the site and for how long they were actually
 * engaged. Everything here is codes, counts and timings — the same rule
 * ADR-0011 puts on the ledger — plus the topic a learner typed, which is
 * already a column of `sessions` and already public on the session's own page.
 *
 * Spoken text, transcripts, board content and questions never appear.
 */

/**
 * Bumped whenever the derivation changes what a row means. `stats:backfill`
 * re-derives every session whose row carries an older version, so a fix to
 * the derivation is never a migration.
 */
export const STATS_SCHEMA_VERSION = 1;

// ── how a session ended ──────────────────────────────────────────────────────
/**
 * Why the learner stopped. `deriveSession` decides it from the ledger alone,
 * and the order below is the order it asks in — first match wins, so the same
 * session always lands in the same bucket:
 *
 * 1. `completed`        the room reached its recap.
 * 2. `length_ceiling`   the plan's maximum session length ran out. They did
 *                       not leave; the room did.
 * 3. `never_started`    no audio ever played: there was nothing to leave.
 * 4. `left_during_ad`   an ad was on screen and never reported ending.
 * 5. `left_after_error` something failed within `ABANDON_ERROR_WINDOW_MS` of
 *                       the last thing that happened.
 * 6. `left_mid_segment` they were part-way through and simply stopped.
 * 7. `idle_timeout`     the sweeper closed an empty room. It is last on
 *                       purpose: it says how the *room* closed, not why the
 *                       *person* left, and when both are true the other
 *                       answer is the useful one.
 * 8. `unknown`          a ledger that fits none of the above.
 */
export const LeaveReason = z.enum([
  'completed',
  'left_during_ad',
  'left_after_error',
  'left_mid_segment',
  'never_started',
  'idle_timeout',
  'length_ceiling',
  'unknown',
]);
export type LeaveReason = z.infer<typeof LeaveReason>;

/** An error this close to the last thing that happened is treated as the reason they left. */
export const ABANDON_ERROR_WINDOW_MS = 30_000;

// ── reuse provenance ─────────────────────────────────────────────────────────
/**
 * What one session took from another's work. Each is a memo this product
 * already keeps; the link records *whose* work it was, so "this session has
 * been reused fourteen times, for these searches" is one indexed query rather
 * than a walk over every ledger on disk.
 */
export const ReuseKind = z.enum([
  /** The topic resolved to a qualified pack instead of a preparation. */
  'pack',
  /** A lesson segment served from the memo (packages/session-engine FileLessonMemo). */
  'lesson',
  /** A sentence played from the lesson voice store (ADR-0017). */
  'voice',
  /** The session card's generated photograph (ADR-0021). */
  'picture',
  /** The card copy — title, promise, description, keywords (ADR-0013). */
  'card',
]);
export type ReuseKind = z.infer<typeof ReuseKind>;

// ── visits ───────────────────────────────────────────────────────────────────
/**
 * **Active time, defined honestly.** A visit's `activeMs` is not how long a tab
 * was open. The page credits time only while all of these hold:
 *
 *  - the document is visible (`visibilityState === 'visible'`), and
 *  - either the person did something — pointer, key, scroll, touch — within
 *    the last `VISIT_IDLE_MS`, or a lesson is audibly playing, which is the
 *    one case where sitting still *is* the engagement.
 *
 * The page reports that credit every `VISIT_HEARTBEAT_MS`, and the server
 * accepts at most `VISIT_HEARTBEAT_MS * VISIT_CREDIT_SLACK` per beacon, so a
 * client that lies or a laptop that slept cannot inflate the number. A tab
 * left open overnight sends nothing and is credited nothing.
 */
export const VISIT_HEARTBEAT_MS = 15_000;
export const VISIT_IDLE_MS = 60_000;
export const VISIT_CREDIT_SLACK = 1.5;
/** No beacon for this long ends the visit; the next one starts a new row. */
export const VISIT_GAP_MS = 30 * 60_000;

/**
 * What a visitor did, as counters rather than an event stream. A closed list:
 * anything not on it is not counted, and none of it carries content.
 */
export const VisitAction = z.enum([
  'session_started',
  'session_joined',
  'replay_started',
  'share_copied',
  'download_requested',
  'export_requested',
  'signed_in',
  'checkout_started',
  'saved',
  'liked',
  'privacy_opened',
]);
export type VisitAction = z.infer<typeof VisitAction>;

export const DeviceType = z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']);
export type DeviceType = z.infer<typeof DeviceType>;

/**
 * Where a visit's country came from, recorded beside it so nobody reads a
 * guess as a measurement.
 *
 * `edge`     a geo header a trusted proxy set (`PEN_TRUST_GEO_HEADERS=1`).
 *            The only source that can give region and city.
 * `timezone` the browser's own IANA zone mapped to a country. Coarse, and
 *            wrong for anyone travelling or behind a VPN, but it costs no new
 *            dependency and no IP address is stored to get it.
 * `none`     nothing was available.
 */
export const GeoSource = z.enum(['edge', 'timezone', 'none']);
export type GeoSource = z.infer<typeof GeoSource>;

/** A screen's share of a beacon's engaged time. Screen names are route patterns, never ids. */
export const VisitScreenBeacon = z.object({
  screen: z.string().min(1).max(40),
  views: z.number().int().nonnegative().max(10_000),
  activeMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 3_600_000),
});
export type VisitScreenBeacon = z.infer<typeof VisitScreenBeacon>;

/**
 * `POST /api/visits`. Sent on the first engaged moment of a visit and every
 * `VISIT_HEARTBEAT_MS` of engagement after it, and once more on pagehide. It
 * is fire-and-forget: nothing on a screen ever waits for the answer, and a
 * rejected beacon is dropped in silence.
 */
export const VisitBeacon = z.object({
  /** Minted by the page for this visit only; not stored on the device, so it recognises nobody later. */
  visitId: z.string().min(8).max(64),
  /** IANA zone (`Europe/Berlin`): the country signal, and the clock that "hour of day" is read in. */
  timezone: z.string().max(64).nullish(),
  /** `navigator.language`, the tag only. */
  language: z.string().max(16).nullish(),
  /** Host of `document.referrer`, first beacon only. Never the path, never the query. */
  referrerHost: z.string().max(120).nullish(),
  /** `utm_source` / `utm_medium` / `utm_campaign`, first beacon only. */
  campaignSource: z.string().max(60).nullish(),
  campaignMedium: z.string().max(60).nullish(),
  campaignName: z.string().max(60).nullish(),
  /** Engaged milliseconds since the previous beacon, as the page measured them. */
  activeMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 3_600_000),
  /** Where that time went, and how many screen views happened. */
  screens: z.array(VisitScreenBeacon).max(24).default([]),
  /** Counters since the previous beacon. */
  actions: z.partialRecord(VisitAction, z.number().int().nonnegative().max(1_000)).default({}),
  /** The session being watched or taught right now, when there is one. */
  sessionId: SessionId.nullish(),
  /** The page is going away; roll the visit up now rather than waiting for the gap. */
  final: z.boolean().default(false),
});
export type VisitBeacon = z.infer<typeof VisitBeacon>;

/** What the beacon endpoint answers. Nothing on a screen reads it; it exists so a test can. */
export const VisitAck = z.object({
  /** False when the participant has analytics off, or beacons are disabled here: nothing was written. */
  counted: z.boolean(),
});
export type VisitAck = z.infer<typeof VisitAck>;

// ── the reporting API ────────────────────────────────────────────────────────
/**
 * Every report takes the same window. `from`/`to` are ms epoch and inclusive of
 * `from`, exclusive of `to`; `bucket` is the grain of a time series.
 */
export const ReportBucket = z.enum(['hour', 'day', 'week', 'month']);
export type ReportBucket = z.infer<typeof ReportBucket>;

export interface ReportWindow {
  from: number;
  to: number;
}

export interface CostPoint {
  /** Start of the bucket, ms epoch (UTC). */
  at: number;
  sessions: number;
  totalUsd: number;
  llmUsd: number;
  intentUsd: number;
  imageUsd: number;
  ttsUsd: number;
  sttUsd: number;
  searchUsd: number;
  /** Estimated ad revenue; beside the cost, never inside it (ADR-0014). */
  revenueUsd: number;
  /** What the same sessions would have cost with no reuse at all. */
  freshEquivalentUsd: number;
  savedUsd: number;
}

export interface CostReport {
  window: ReportWindow;
  bucket: ReportBucket;
  series: CostPoint[];
  totals: Omit<CostPoint, 'at'>;
  byPlan: Array<{ plan: string; sessions: number; totalUsd: number; costPerSessionUsd: number }>;
  byExpert: Array<{ expertId: string; sessions: number; totalUsd: number }>;
}

export interface RetentionCohort {
  /** Start of the cohort's bucket, ms epoch (UTC). */
  cohort: number;
  size: number;
  /** `periods[n]` = how many of `size` came back in the nth bucket after their first. */
  periods: number[];
}

export interface RetentionReport {
  window: ReportWindow;
  bucket: ReportBucket;
  /** `session` counts a return as hosting or joining a session; `visit` counts opening the site. */
  metric: 'session' | 'visit';
  cohorts: RetentionCohort[];
}

export interface SessionStatsRow {
  sessionId: string;
  topic: string;
  title: string;
  hostId: string;
  plan: string;
  expertId: string;
  language: string;
  canonicalId: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  segments: number;
  segmentsReached: number;
  progress: number;
  completed: boolean;
  leaveReason: LeaveReason;
  questions: number;
  interrupts: number;
  participants: number;
  totalUsd: number;
  revenueUsd: number;
  savedUsd: number;
  freshEquivalentUsd: number;
  packHit: boolean;
  errors: number;
  timeToFirstAudioMs: number | null;
  /** How many later sessions took work from this one. */
  reusedBy: number;
  views: number;
  replays: number;
  shares: number;
}

export interface PlanMixReport {
  window: ReportWindow;
  /** Right now, from `participants`. */
  current: Array<{
    plan: PlanCode;
    interval: 'month' | 'year' | null;
    participants: number;
    /** Of those, how many were active in the window. */
    active: number;
  }>;
  /** Plan changes inside the window, from the Stripe webhook's record. */
  changes: Array<{
    at: number;
    upgrades: number;
    downgrades: number;
    cancellations: number;
  }>;
  mrrUsd: number;
}

export interface GeographyRow {
  country: string | null;
  region: string | null;
  city: string | null;
  source: GeoSource;
  visits: number;
  visitors: number;
  activeMs: number;
  sessions: number;
}

export interface DeviceRow {
  deviceType: DeviceType;
  os: string | null;
  browser: string | null;
  visits: number;
  visitors: number;
  activeMs: number;
  sessions: number;
}

/** `VisitBeacon` shapes what is collected; this is the shape of every report that reads it. */
export interface VisitsReport {
  window: ReportWindow;
  bucket: ReportBucket;
  series: Array<{
    at: number;
    visits: number;
    visitors: number;
    signedIn: number;
    anonymous: number;
    activeMs: number;
    /** Visits that opened one screen, did nothing and left. */
    bounces: number;
    sessionsStarted: number;
  }>;
  totals: {
    visits: number;
    visitors: number;
    activeMs: number;
    medianActiveMs: number;
    bounceRate: number;
    sessionsStarted: number;
    /** Visits that started a session, over visits. */
    conversion: number;
  };
  byScreen: Array<{ screen: string; views: number; visits: number; activeMs: number }>;
  byReferrer: Array<{ referrerHost: string | null; visits: number; sessionsStarted: number }>;
}

/** One session's reuse, answered as the owner asked it: how many times, and for which searches. */
export interface SessionReuseDetail {
  sessionId: string;
  topic: string;
  canonicalId: string | null;
  /** Distinct later sessions that took anything from this one. */
  reusedBy: number;
  savedForOthersUsd: number;
  byKind: Array<{ kind: ReuseKind; uses: number; savedUsd: number }>;
  /** The topics those later learners typed, commonest first. Topics, never spoken text. */
  searches: Array<{ topic: string; uses: number; lastAt: number }>;
}

export const ParticipantStatsId = ParticipantId;
