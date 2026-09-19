import type { VisitBeacon } from '@pen/contracts';
import {
  VISIT_CREDIT_SLACK,
  VISIT_GAP_MS,
  VISIT_HEARTBEAT_MS,
  type VisitAction,
} from '@pen/contracts';
import type { StatsRepository, VisitBeaconWrite } from '@pen/db';
import { NO_VISIT_ACTIONS } from '@pen/db';
import { type GeoResolution, resolveGeo, safeTimezone, utcOffsetMinutes } from './geo.js';
import { parseClient } from './user-agent.js';

/**
 * Counting visits, including the ones nobody signed in for (ADR-0027).
 *
 * Anyone can use this product without an account, so "how many people came,
 * when, and what did they do" cannot be answered from `participants` and
 * `sessions` alone. This is the one new thing this feature collects, and the
 * three rules it keeps are:
 *
 * 1. **The opt-out is real.** A participant with `analytics_opt_out` writes
 *    nothing here — not a visit, not a screen, not a country. The row is
 *    dropped before anything is parsed, and `counted: false` comes back.
 * 2. **Time is engaged time.** The page only reports credit it earned
 *    (`VisitBeacon`), and the server clamps each beacon to
 *    `VISIT_HEARTBEAT_MS * VISIT_CREDIT_SLACK` on top, so neither a bug nor a
 *    forged beacon can inflate the number beyond the interval it covers.
 * 3. **The two identifiers are kept on a clock.** The client address and the
 *    raw `User-Agent` are recorded (ADR-0028) and cleared from rows older
 *    than `PEN_VISIT_IDENTIFIER_DAYS` by the sweep below, which leaves every
 *    derived column standing. Nothing else here identifies anyone: a route
 *    pattern, a referrer's host, a device class, the window's own
 *    measurements, and a country from the browser's clock. No URL, no
 *    content, and nothing that needed the visitor's permission to read.
 */

/** The most one beacon may add, however long it says it was away. */
export const MAX_CREDIT_PER_BEACON_MS = Math.round(VISIT_HEARTBEAT_MS * VISIT_CREDIT_SLACK);

/**
 * How often the retention sweep actually runs. It is called from the same
 * one-minute sweeper as everything else, and a retention period measured in
 * days does not need checking sixty times an hour — an hour late is not late.
 */
export const IDENTIFIER_SWEEP_MS = 3_600_000;

/** The longest raw `User-Agent` kept. Real ones run to about 200 characters. */
const MAX_USER_AGENT = 400;

/** What the request carried around the beacon. */
export interface VisitContext {
  participantId: string | null;
  signedIn: boolean;
  plan: string;
  /** The raw string: parsed for the device class, and kept beside it. */
  userAgent: string | undefined;
  /**
   * The client address, already resolved and validated by the route through
   * `visitAddress` — the same `X-Real-IP`-then-`X-Forwarded-For` resolution
   * the per-IP session cap uses. Null when the request arrived without one.
   */
  ipAddress: string | null;
  header(name: string): string | undefined;
  now: number;
}

export interface VisitIngestDeps {
  stats: Pick<
    StatsRepository,
    'applyVisitBeacon' | 'closeStaleVisits' | 'recordEngagement' | 'clearVisitIdentifiers'
  >;
  /** True when this participant has turned analytics off. */
  optedOut(participantId: string): boolean;
  /** `PEN_TRUST_GEO_HEADERS`. */
  trustGeoHeaders: boolean;
  /** Off entirely (`PEN_VISIT_STATS=0`): the endpoint answers, and writes nothing. */
  enabled: boolean;
  /**
   * `PEN_VISIT_IDENTIFIER_DAYS` in milliseconds: how long the address and the
   * raw `User-Agent` may stay on a row. **0 means neither is ever written**,
   * and the sweep then clears every one already stored — so turning the
   * collection off is not only prospective.
   */
  identifierRetentionMs: number;
  onError: (area: string, error: unknown, detail?: Record<string, unknown>) => void;
}

/** Each counter's column, so a new action is one line in two places and no more. */
const ACTION_COLUMN: Record<VisitAction, keyof VisitBeaconWrite['actions']> = {
  session_started: 'sessionsStarted',
  session_joined: 'sessionsJoined',
  replay_started: 'replaysStarted',
  share_copied: 'sharesCopied',
  download_requested: 'downloadsRequested',
  export_requested: 'exportsRequested',
  signed_in: 'signInsCompleted',
  checkout_started: 'checkoutsStarted',
  saved: 'saves',
  liked: 'likes',
  privacy_opened: 'privacyOpened',
};

export class VisitIngest {
  /** When the retention sweep last ran; 0 so the first minute after boot runs it. */
  private lastIdentifierSweep = 0;

  constructor(private readonly d: VisitIngestDeps) {}

  /** Whether this deployment records the address and the raw string at all. */
  private get keepsIdentifiers(): boolean {
    return this.d.identifierRetentionMs > 0;
  }

  /**
   * Apply one beacon. Returns whether anything was written — false for an
   * opted-out participant and for a deployment with visit statistics off.
   * Never throws: a failed write is a lost count, never a failed request.
   */
  async record(beacon: VisitBeacon, ctx: VisitContext): Promise<boolean> {
    if (!this.d.enabled) return false;
    if (ctx.participantId && this.d.optedOut(ctx.participantId)) return false;

    const timezone = safeTimezone(beacon.timezone);
    const geo: GeoResolution = resolveGeo({
      header: ctx.header,
      timezone,
      trustEdgeHeaders: this.d.trustGeoHeaders,
    });
    const client = parseClient(ctx.userAgent, {
      platform: ctx.header('sec-ch-ua-platform'),
      mobile: ctx.header('sec-ch-ua-mobile'),
    });

    const actions = { ...NO_VISIT_ACTIONS };
    for (const [name, count] of Object.entries(beacon.actions)) {
      const column = ACTION_COLUMN[name as VisitAction];
      if (column && typeof count === 'number' && count > 0) actions[column] += Math.trunc(count);
    }

    // Screen time is clamped as a whole, then each screen is clamped to its
    // share, so the parts can never add up to more than the beacon's credit.
    const activeMs = Math.min(beacon.activeMs, MAX_CREDIT_PER_BEACON_MS);
    const claimed = beacon.screens.reduce((n, s) => n + s.activeMs, 0);
    const scale = claimed > activeMs && claimed > 0 ? activeMs / claimed : 1;
    const screens = beacon.screens
      .filter((s) => s.screen.length > 0)
      .map((s) => ({
        screen: s.screen.slice(0, 40),
        views: Math.min(s.views, 1_000),
        activeMs: Math.round(s.activeMs * scale),
      }));
    const views = screens.reduce((sum, s) => sum + s.views, 0);
    // The screen with the most of this beacon's time is the one it was spent on.
    const screen =
      [...screens].sort((a, b) => b.activeMs - a.activeMs || b.views - a.views)[0]?.screen ?? null;

    const write: VisitBeaconWrite = {
      id: beacon.visitId,
      at: ctx.now,
      participantId: ctx.participantId,
      signedIn: ctx.signedIn,
      plan: ctx.plan,
      activeMs,
      views,
      screen,
      screens,
      referrerHost: host(beacon.referrerHost),
      campaignSource: token(beacon.campaignSource),
      campaignMedium: token(beacon.campaignMedium),
      campaignName: token(beacon.campaignName),
      deviceType: client.deviceType,
      os: client.os,
      browser: client.browser,
      browserMajor: client.browserMajor,
      // The two identifiers, and the one switch that decides whether either
      // is written at all. Everything below this line survives the sweep.
      userAgent: this.keepsIdentifiers ? userAgent(ctx.userAgent) : null,
      ipAddress: this.keepsIdentifiers ? ctx.ipAddress : null,
      screenWidth: pixels(beacon.screenWidth),
      screenHeight: pixels(beacon.screenHeight),
      viewportWidth: pixels(beacon.viewportWidth),
      viewportHeight: pixels(beacon.viewportHeight),
      devicePixelRatio: ratio(beacon.devicePixelRatio),
      country: geo.country,
      region: geo.region,
      city: geo.city,
      geoSource: geo.source,
      timezone,
      utcOffsetMinutes: utcOffsetMinutes(timezone, ctx.now),
      // `navigator.language` where the page sent one, and the first tag of
      // `Accept-Language` where it did not — the same fact, from whichever
      // of the two the visitor's browser offered.
      language: tag(beacon.language) ?? acceptedLanguage(ctx.header('accept-language')),
      sessionId: beacon.sessionId ?? null,
      final: beacon.final,
      gapMs: VISIT_GAP_MS,
      actions,
    };
    try {
      await this.d.stats.applyVisitBeacon(write);
      // A replay watched and a link copied belong to the session as well as
      // to the visit — they are how a session earns its life after the room
      // closes, and neither leaves a trace anywhere else.
      if (write.sessionId) {
        if (actions.replaysStarted > 0)
          await this.d.stats.recordEngagement(write.sessionId, 'replays', ctx.now);
        if (actions.sharesCopied > 0)
          await this.d.stats.recordEngagement(write.sessionId, 'shares', ctx.now);
      }
      return true;
    } catch (error) {
      this.d.onError('stats.visit', error, { visitId: beacon.visitId });
      return false;
    }
  }

  /**
   * Close visits that stopped sending, and forget the identifiers on the ones
   * that have aged out. Called from the same minute sweep as idle rooms.
   *
   * Returns the number of visits closed — the retention pass is reported
   * separately by `purgeIdentifiers`, because "how many visits ended" and
   * "how many rows were forgotten" are different questions and adding them
   * would make both meaningless.
   *
   * Runs even with `PEN_VISIT_STATS=0`: turning collection off must not also
   * turn off the forgetting of what was collected while it was on.
   */
  async sweep(now: number): Promise<number> {
    if (now - this.lastIdentifierSweep >= IDENTIFIER_SWEEP_MS) {
      this.lastIdentifierSweep = now;
      await this.purgeIdentifiers(now);
    }
    if (!this.d.enabled) return 0;
    try {
      return await this.d.stats.closeStaleVisits(now, VISIT_GAP_MS);
    } catch (error) {
      this.d.onError('stats.visit_sweep', error);
      return 0;
    }
  }

  /**
   * Clear the address and the raw `User-Agent` from every visit older than
   * the retention period, leaving every derived column and every count
   * exactly as it was (ADR-0028). Returns how many rows were cleared.
   *
   * Called by `sweep` on its own clock; exposed so a test — and an operator
   * who has just shortened the period — can run it now rather than waiting.
   * A retention of 0 passes `now` as the cutoff, which clears everything.
   */
  async purgeIdentifiers(now: number): Promise<number> {
    try {
      return await this.d.stats.clearVisitIdentifiers(now - this.d.identifierRetentionMs);
    } catch (error) {
      this.d.onError('stats.visit_retention', error);
      return 0;
    }
  }
}

/** A referrer's host and nothing else: never the path, never the query. */
function host(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  return /^[a-z0-9.-]{1,120}$/.test(clean) ? clean : null;
}

/** A campaign tag: short, printable, and never a sentence. */
function token(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .trim()
    .slice(0, 60)
    .replace(/[^\w .+/-]/g, '');
  return clean.length > 0 ? clean : null;
}

/** A BCP-47 tag, shape-checked. */
function tag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(v) && v.length <= 16 ? v : null;
}

/**
 * The visitor's first choice out of `Accept-Language`
 * (`en-GB,en;q=0.9,fr;q=0.8` → `en-GB`). Only the first tag: the full list is
 * a far sharper fingerprint than the one language a report groups by, and the
 * question is "what language is this person reading in", which the first
 * entry answers. `*` is a wildcard, not a language.
 */
function acceptedLanguage(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const first = header.split(',')[0]?.split(';')[0]?.trim();
  return first === '*' ? null : tag(first);
}

/**
 * The raw `User-Agent`, bounded and stripped of control characters. It is
 * deliberately *not* otherwise cleaned: the whole point of keeping it is the
 * questions the parser did not anticipate, and a tidied string cannot answer
 * those. It is a header, so it is still input — the stripping is what stops
 * a forged one putting a newline into anything that later prints it.
 */
function userAgent(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\p{Cc}]/gu, ' ')
    .trim()
    .slice(0, MAX_USER_AGENT);
  return clean.length > 0 ? clean : null;
}

/** A pixel count the browser reported: a positive integer, or nothing. */
function pixels(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const v = Math.round(value);
  return v > 0 && v <= 65_535 ? v : null;
}

/** A device pixel ratio, kept to two decimals — 1, 1.5, 2, 3 and the odd 2.75. */
function ratio(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const v = Math.round(value * 100) / 100;
  return v > 0 && v <= 16 ? v : null;
}
