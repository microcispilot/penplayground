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
 * 3. **Nothing identifying is kept.** No IP address, no raw User-Agent, no
 *    URL — a route pattern, a referrer's host, a device class, and a country
 *    that came from the browser's own clock.
 */

/** The most one beacon may add, however long it says it was away. */
export const MAX_CREDIT_PER_BEACON_MS = Math.round(VISIT_HEARTBEAT_MS * VISIT_CREDIT_SLACK);

/** What the request carried around the beacon. */
export interface VisitContext {
  participantId: string | null;
  signedIn: boolean;
  plan: string;
  /** Read for the device class and dropped; never stored. */
  userAgent: string | undefined;
  header(name: string): string | undefined;
  now: number;
}

export interface VisitIngestDeps {
  stats: Pick<StatsRepository, 'applyVisitBeacon' | 'closeStaleVisits' | 'recordEngagement'>;
  /** True when this participant has turned analytics off. */
  optedOut(participantId: string): boolean;
  /** `PEN_TRUST_GEO_HEADERS`. */
  trustGeoHeaders: boolean;
  /** Off entirely (`PEN_VISIT_STATS=0`): the endpoint answers, and writes nothing. */
  enabled: boolean;
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
  constructor(private readonly d: VisitIngestDeps) {}

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
      country: geo.country,
      region: geo.region,
      city: geo.city,
      geoSource: geo.source,
      timezone,
      utcOffsetMinutes: utcOffsetMinutes(timezone, ctx.now),
      language: tag(beacon.language),
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

  /** Close visits that stopped sending; called from the same minute sweep as idle rooms. */
  async sweep(now: number): Promise<number> {
    if (!this.d.enabled) return 0;
    try {
      return await this.d.stats.closeStaleVisits(now, VISIT_GAP_MS);
    } catch (error) {
      this.d.onError('stats.visit_sweep', error);
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
