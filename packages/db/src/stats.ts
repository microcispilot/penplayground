import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  planEvents,
  type SessionStatsInsert,
  sessionEngagement,
  sessionErrorStats,
  sessionReuseLinks,
  sessionStageStats,
  sessionStats,
  siteVisitScreens,
  siteVisits,
  statsWorkOrigin,
} from './stats-schema.js';

/**
 * Writing the statistics (ADR-0027). Reading them is `ReportRepository`'s job;
 * the two are separate because they have opposite shapes — this one writes a
 * handful of rows per session and never reads for a screen, that one reads
 * millions and never writes.
 *
 * Every write here is idempotent. A session derived twice — at its end, and
 * again by the backfill after its thumbnail landed — leaves exactly the rows
 * the second derivation produced, never two sets.
 */

/** One session's derived rows, as `deriveSession` produces them. */
export interface DerivedSessionWrite {
  session: SessionStatsInsert;
  stages: Array<typeof sessionStageStats.$inferInsert>;
  errors: Array<typeof sessionErrorStats.$inferInsert>;
  /** Scopes this session generated; it claims the origin of any nobody holds. */
  generated: Array<{ kind: string; scopeKey: string }>;
  /** Scopes it reused; one link each, pointed at whoever holds the origin. */
  reused: Array<{ kind: string; scopeKey: string; uses: number; savedUsd: number }>;
  /** The consuming learner's search, copied onto every link this session writes. */
  topic: string;
}

/** A session the backfill should re-derive, and why. */
export interface StaleSession {
  sessionId: string;
  /** Null when the session has never been derived. */
  ledgerEntries: number | null;
  schemaVersion: number | null;
}

export class StatsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Replace everything derived from one session's ledger, in one transaction.
   *
   * Origin claiming is `onConflictDoNothing`: the first session the derivation
   * sees that actually *generated* a scope owns it, and a later one that also
   * generated it (a memo that expired, a pack recompiled) does not steal it.
   * Because the backfill walks oldest first, that is the session that really
   * paid — see `docs/STATISTICS.md` for where the claim can be wrong.
   */
  async putDerivedSession(w: DerivedSessionWrite): Promise<void> {
    const sessionId = w.session.sessionId;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(sessionStats)
        .values(w.session)
        .onConflictDoUpdate({ target: sessionStats.sessionId, set: w.session });

      await tx.delete(sessionStageStats).where(eq(sessionStageStats.sessionId, sessionId));
      if (w.stages.length > 0) await tx.insert(sessionStageStats).values(w.stages);

      await tx.delete(sessionErrorStats).where(eq(sessionErrorStats.sessionId, sessionId));
      if (w.errors.length > 0) await tx.insert(sessionErrorStats).values(w.errors);

      if (w.generated.length > 0) {
        await tx
          .insert(statsWorkOrigin)
          .values(
            w.generated.map((g) => ({
              kind: g.kind,
              scopeKey: g.scopeKey,
              sessionId,
              topic: w.topic,
              createdAt: w.session.startedAt,
            })),
          )
          .onConflictDoNothing();
      }

      await tx.delete(sessionReuseLinks).where(eq(sessionReuseLinks.sessionId, sessionId));
      if (w.reused.length > 0) {
        const keys = w.reused.map((r) => r.scopeKey);
        const origins = await tx
          .select()
          .from(statsWorkOrigin)
          .where(inArray(statsWorkOrigin.scopeKey, keys));
        const originOf = new Map(origins.map((o) => [`${o.kind}::${o.scopeKey}`, o.sessionId]));
        await tx.insert(sessionReuseLinks).values(
          w.reused.map((r) => {
            const source = originOf.get(`${r.kind}::${r.scopeKey}`) ?? null;
            return {
              id: `${sessionId}:${r.kind}`,
              sessionId,
              // A session cannot be reused by itself: the origin is only ever
              // someone else's, and an unrecorded origin stays honestly null.
              sourceSessionId: source === sessionId ? null : source,
              kind: r.kind,
              scopeKey: r.scopeKey,
              topic: w.topic,
              canonicalId: w.session.canonicalId ?? null,
              uses: r.uses,
              savedUsd: r.savedUsd,
              at: w.session.startedAt,
            };
          }),
        );
      }
    });
  }

  /** Was this session derived, and from how much? The backfill's "has the ledger grown" check. */
  async derivedState(sessionIds: string[]): Promise<Map<string, StaleSession>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        sessionId: sessionStats.sessionId,
        ledgerEntries: sessionStats.ledgerEntries,
        schemaVersion: sessionStats.schemaVersion,
      })
      .from(sessionStats)
      .where(inArray(sessionStats.sessionId, sessionIds));
    return new Map(rows.map((r) => [r.sessionId, r]));
  }

  /** Rows written by an older derivation, oldest session first. */
  async outdated(schemaVersion: number, limit = 500): Promise<string[]> {
    const rows = await this.db
      .select({ sessionId: sessionStats.sessionId })
      .from(sessionStats)
      .where(lt(sessionStats.schemaVersion, schemaVersion))
      .orderBy(sessionStats.startedAt)
      .limit(limit);
    return rows.map((r) => r.sessionId);
  }

  /** Everything derived from one session, for a delete. */
  async removeSession(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(sessionStats).where(eq(sessionStats.sessionId, sessionId));
      await tx.delete(sessionStageStats).where(eq(sessionStageStats.sessionId, sessionId));
      await tx.delete(sessionErrorStats).where(eq(sessionErrorStats.sessionId, sessionId));
      await tx.delete(sessionEngagement).where(eq(sessionEngagement.sessionId, sessionId));
      await tx.delete(statsWorkOrigin).where(eq(statsWorkOrigin.sessionId, sessionId));
      // The links this session made, and the links that pointed at it: the
      // reuse stays counted, but it no longer names a session that is gone.
      await tx.delete(sessionReuseLinks).where(eq(sessionReuseLinks.sessionId, sessionId));
      await tx
        .update(sessionReuseLinks)
        .set({ sourceSessionId: null })
        .where(eq(sessionReuseLinks.sourceSessionId, sessionId));
    });
  }

  /**
   * Every visit this participant left behind. Called when they turn analytics
   * off — "not counted at all" has to mean the counting already done as well,
   * or the switch is only half true (ADR-0018) — and again when the account
   * is deleted.
   */
  async removeVisits(participantId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const visits = await tx
        .select({ id: siteVisits.id })
        .from(siteVisits)
        .where(eq(siteVisits.participantId, participantId));
      if (visits.length === 0) return 0;
      await tx.delete(siteVisitScreens).where(
        inArray(
          siteVisitScreens.visitId,
          visits.map((v) => v.id),
        ),
      );
      await tx.delete(siteVisits).where(eq(siteVisits.participantId, participantId));
      return visits.length;
    });
  }

  /** Their visits and everything about them that is not a session. */
  async removeParticipant(participantId: string): Promise<void> {
    await this.removeVisits(participantId);
    await this.db.delete(planEvents).where(eq(planEvents.participantId, participantId));
  }

  /**
   * What `GET /api/me/export` hands the caller about their own visits — every
   * column, the address and the raw `User-Agent` included (ADR-0028). It is
   * their data and an access request should not be answered with less than
   * the truth; rows past the retention period simply carry nulls there.
   */
  async visitsOf(participantId: string, limit = 1_000): Promise<Array<Record<string, unknown>>> {
    return this.db
      .select()
      .from(siteVisits)
      .where(eq(siteVisits.participantId, participantId))
      .orderBy(desc(siteVisits.startedAt))
      .limit(limit);
  }

  // ── visits ─────────────────────────────────────────────────────────────────
  /**
   * Apply one beacon. Returns the visit row's id, which is the client's own id
   * unless the gap rule started a new one.
   *
   * The whole apply is a single upsert plus one per screen, on purpose: a
   * beacon arrives every fifteen seconds of engagement from every open page,
   * and it must never cost more than that.
   */
  async applyVisitBeacon(v: VisitBeaconWrite): Promise<string> {
    const gapped =
      v.gapMs !== null &&
      (await this.db
        .select({ lastSeenAt: siteVisits.lastSeenAt })
        .from(siteVisits)
        .where(eq(siteVisits.id, v.id))
        .limit(1)
        .then((rows) => {
          const last = rows[0]?.lastSeenAt;
          return last !== undefined && v.at - last > (v.gapMs ?? 0);
        }));
    // A beacon after a long silence is a new visit, not a resumed one; the id
    // gains a suffix so the page need not know it happened.
    const id = gapped ? `${v.id}~${v.at.toString(36)}` : v.id;

    await this.db
      .insert(siteVisits)
      .values({
        id,
        participantId: v.participantId,
        signedIn: v.signedIn,
        plan: v.plan,
        startedAt: v.at,
        lastSeenAt: v.at,
        endedAt: v.final ? v.at : null,
        activeMs: v.activeMs,
        views: v.views,
        beacons: 1,
        entryScreen: v.screen,
        lastScreen: v.screen,
        referrerHost: v.referrerHost,
        campaignSource: v.campaignSource,
        campaignMedium: v.campaignMedium,
        campaignName: v.campaignName,
        deviceType: v.deviceType,
        os: v.os,
        browser: v.browser,
        browserMajor: v.browserMajor,
        // The identifiers and the machine's measurements are written once,
        // by the beacon that created the row, and never touched again: the
        // conflict branch below leaves them alone, so a visit's address is
        // the address it began at and the retention sweep's clearing of one
        // can never be undone by a late beacon (ADR-0028).
        userAgent: v.userAgent,
        screenWidth: v.screenWidth,
        screenHeight: v.screenHeight,
        viewportWidth: v.viewportWidth,
        viewportHeight: v.viewportHeight,
        devicePixelRatio: v.devicePixelRatio,
        ipAddress: v.ipAddress,
        country: v.country,
        region: v.region,
        city: v.city,
        geoSource: v.geoSource,
        timezone: v.timezone,
        utcOffsetMinutes: v.utcOffsetMinutes,
        language: v.language,
        lastSessionId: v.sessionId,
        ...v.actions,
      })
      .onConflictDoUpdate({
        target: siteVisits.id,
        set: {
          lastSeenAt: v.at,
          endedAt: v.final ? v.at : null,
          activeMs: sql`${siteVisits.activeMs} + ${v.activeMs}`,
          views: sql`${siteVisits.views} + ${v.views}`,
          beacons: sql`${siteVisits.beacons} + 1`,
          lastScreen: v.screen ?? sql`${siteVisits.lastScreen}`,
          // Signing in mid-visit is the one identity change a visit can have.
          signedIn: v.signedIn,
          plan: v.plan,
          participantId: v.participantId ?? sql`${siteVisits.participantId}`,
          lastSessionId: v.sessionId ?? sql`${siteVisits.lastSessionId}`,
          sessionsStarted: sql`${siteVisits.sessionsStarted} + ${v.actions.sessionsStarted}`,
          sessionsJoined: sql`${siteVisits.sessionsJoined} + ${v.actions.sessionsJoined}`,
          replaysStarted: sql`${siteVisits.replaysStarted} + ${v.actions.replaysStarted}`,
          sharesCopied: sql`${siteVisits.sharesCopied} + ${v.actions.sharesCopied}`,
          downloadsRequested: sql`${siteVisits.downloadsRequested} + ${v.actions.downloadsRequested}`,
          exportsRequested: sql`${siteVisits.exportsRequested} + ${v.actions.exportsRequested}`,
          signInsCompleted: sql`${siteVisits.signInsCompleted} + ${v.actions.signInsCompleted}`,
          checkoutsStarted: sql`${siteVisits.checkoutsStarted} + ${v.actions.checkoutsStarted}`,
          saves: sql`${siteVisits.saves} + ${v.actions.saves}`,
          likes: sql`${siteVisits.likes} + ${v.actions.likes}`,
          privacyOpened: sql`${siteVisits.privacyOpened} + ${v.actions.privacyOpened}`,
        },
      });

    for (const s of v.screens) {
      await this.db
        .insert(siteVisitScreens)
        .values({
          visitId: id,
          screen: s.screen,
          views: s.views,
          activeMs: s.activeMs,
          startedAt: v.at,
        })
        .onConflictDoUpdate({
          target: [siteVisitScreens.visitId, siteVisitScreens.screen],
          set: {
            views: sql`${siteVisitScreens.views} + ${s.views}`,
            activeMs: sql`${siteVisitScreens.activeMs} + ${s.activeMs}`,
          },
        });
    }
    return id;
  }

  /**
   * Close visits that stopped sending. Called by the same sweeper that closes
   * idle rooms, so a report never has to treat "no `ended_at`" as a special case.
   */
  async closeStaleVisits(now: number, gapMs: number): Promise<number> {
    const rows = await this.db
      .update(siteVisits)
      .set({ endedAt: sql`${siteVisits.lastSeenAt}` })
      .where(and(sql`${siteVisits.endedAt} is null`, lt(siteVisits.lastSeenAt, now - gapMs)))
      .returning();
    return rows.length;
  }

  /**
   * Forget the two identifiers on visits older than `olderThan`, and nothing
   * else (ADR-0028).
   *
   * This is the whole of the retention promise: the address and the raw
   * `User-Agent` are set to null, and every derived column — device class,
   * OS, browser, country, screen, the counts, the engaged time — is left
   * exactly as it was. A report over last year is unchanged by this having
   * run; only the ability to point at a machine is gone.
   *
   * `site_visits_identifier_idx` is partial on exactly this predicate, so a
   * sweep that finds nothing is an index probe rather than a table scan, and
   * a row leaves the index the moment it is cleared. Returns how many rows
   * were cleared.
   */
  async clearVisitIdentifiers(olderThan: number): Promise<number> {
    const rows = await this.db
      .update(siteVisits)
      .set({ ipAddress: null, userAgent: null })
      .where(
        and(
          lt(siteVisits.startedAt, olderThan),
          sql`(${siteVisits.ipAddress} is not null or ${siteVisits.userAgent} is not null)`,
        ),
      )
      // `returning()` with no projection, as `closeStaleVisits` does: the
      // union of drivers this repository runs on does not type the narrowed
      // form, and the rows are already bounded by the predicate above.
      .returning();
    return rows.length;
  }

  // ── engagement after the session ends ──────────────────────────────────────
  async recordEngagement(sessionId: string, kind: EngagementKind, now: number): Promise<void> {
    const column = sessionEngagement[kind];
    await this.db
      .insert(sessionEngagement)
      .values({ sessionId, [kind]: 1, lastAt: now })
      .onConflictDoUpdate({
        target: sessionEngagement.sessionId,
        set: { [kind]: sql`${column} + 1`, lastAt: now },
      });
  }

  // ── the subscription's history ─────────────────────────────────────────────
  /**
   * One plan change. The unique index on (participant, at, plan) makes a
   * redelivered Stripe webhook a no-op rather than a second churn event.
   */
  async recordPlanEvent(e: {
    participantId: string;
    at: number;
    fromPlan: string | null;
    toPlan: string;
    interval: 'month' | 'year' | null;
    status: string | null;
    source?: string;
    amountCents?: number | null;
    currency?: string | null;
  }): Promise<void> {
    await this.db
      .insert(planEvents)
      .values({
        id: `${e.participantId}:${e.at}:${e.toPlan}`,
        participantId: e.participantId,
        at: e.at,
        fromPlan: e.fromPlan,
        toPlan: e.toPlan,
        interval: e.interval,
        status: e.status,
        source: e.source ?? 'stripe',
        amountCents: e.amountCents ?? null,
        currency: e.currency ?? null,
      })
      .onConflictDoNothing();
  }
}

/** What a visit counts after the session ends. */
export type EngagementKind = 'replays' | 'shares' | 'downloads' | 'exports';

/** What `applyVisitBeacon` needs: the beacon, resolved against the request that carried it. */
export interface VisitBeaconWrite {
  id: string;
  at: number;
  participantId: string | null;
  signedIn: boolean;
  plan: string;
  activeMs: number;
  views: number;
  screen: string | null;
  screens: Array<{ screen: string; views: number; activeMs: number }>;
  referrerHost: string | null;
  campaignSource: string | null;
  campaignMedium: string | null;
  campaignName: string | null;
  deviceType: string;
  os: string | null;
  browser: string | null;
  browserMajor: number | null;
  /** The raw string the parsed columns came from; null when the request carried none. */
  userAgent: string | null;
  screenWidth: number | null;
  screenHeight: number | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  devicePixelRatio: number | null;
  /** Validated and normalised by the caller; never a header value taken on trust. */
  ipAddress: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  geoSource: string;
  timezone: string | null;
  utcOffsetMinutes: number | null;
  language: string | null;
  sessionId: string | null;
  final: boolean;
  /** Null to never split; otherwise the silence after which this is a new visit. */
  gapMs: number | null;
  actions: {
    sessionsStarted: number;
    sessionsJoined: number;
    replaysStarted: number;
    sharesCopied: number;
    downloadsRequested: number;
    exportsRequested: number;
    signInsCompleted: number;
    checkoutsStarted: number;
    saves: number;
    likes: number;
    privacyOpened: number;
  };
}

export const NO_VISIT_ACTIONS: VisitBeaconWrite['actions'] = {
  sessionsStarted: 0,
  sessionsJoined: 0,
  replaysStarted: 0,
  sharesCopied: 0,
  downloadsRequested: 0,
  exportsRequested: 0,
  signInsCompleted: 0,
  checkoutsStarted: 0,
  saves: 0,
  likes: 0,
  privacyOpened: 0,
};
