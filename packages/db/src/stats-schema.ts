import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Statistics and reports (ADR-0027).
 *
 * Two kinds of row live here and they are not the same kind of thing.
 *
 * **Derived.** `session_stats`, `session_stage_stats`, `session_error_stats`,
 * `session_reuse_links` and `stats_work_origin` are rolled out of a session's
 * recording ledger when it ends. The ledger on disk stays the source of truth;
 * every one of these tables can be dropped and rebuilt by `stats:backfill`,
 * and `schema_version` says which derivation wrote a row so a fix to the
 * derivation is a re-run rather than a migration.
 *
 * **Recorded.** `site_visits`, `site_visit_screens`, `session_engagement` and
 * `plan_events` are counted as they happen and exist nowhere else. They are
 * the only new collection in this feature, and the only part
 * `participants.analytics_opt_out` can silence — see `docs/STATISTICS.md`.
 *
 * Content never appears in either kind. The one piece of learner-typed text
 * anywhere here is `session_reuse_links.topic`, which is a copy of
 * `sessions.topic` — already stored, already on the session's public page,
 * and the whole point of "what searches was this session reused for".
 */

// ── derived: one row per finished session ────────────────────────────────────
export const sessionStats = pgTable(
  'session_stats',
  {
    sessionId: text('session_id').primaryKey(),
    /** Which derivation wrote this row (`STATS_SCHEMA_VERSION`). */
    schemaVersion: integer('schema_version').notNull(),
    derivedAt: bigint('derived_at', { mode: 'number' }).notNull(),
    /**
     * Ledger entries this row was derived from. The backfill re-derives any
     * session whose ledger has grown since — which is how a thumbnail or card
     * that landed after the room closed still reaches the statistics.
     */
    ledgerEntries: integer('ledger_entries').notNull().default(0),

    // identity, copied so a report never has to join to group
    hostId: text('host_id').notNull(),
    /** The host's plan *at the time*, which is not necessarily their plan now. */
    plan: text('plan').notNull(),
    expertId: text('expert_id').notNull(),
    language: text('language').notNull(),
    band: text('band').notNull(),
    domain: text('domain').notNull(),
    canonicalId: text('canonical_id'),
    /** The voice engine the session was bound to (ADR-0048); null before engines were a choice. */
    voiceEngine: text('voice_engine'),
    voiceTts: text('voice_tts'),
    /** `canonicalId|band|expertId|language`: the scope the lesson memo, card and picture share. */
    scopeKey: text('scope_key'),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    endedAt: bigint('ended_at', { mode: 'number' }),

    // totals
    durationMs: integer('duration_ms').notNull().default(0),
    segmentsPlanned: integer('segments_planned').notNull().default(0),
    segmentsReached: integer('segments_reached').notNull().default(0),
    says: integer('says').notNull().default(0),
    questions: integer('questions').notNull().default(0),
    interrupts: integer('interrupts').notNull().default(0),
    adsShown: integer('ads_shown').notNull().default(0),
    adsSkipped: integer('ads_skipped').notNull().default(0),
    participants: integer('participants').notNull().default(0),
    interactions: integer('interactions').notNull().default(0),
    stages: integer('stages').notNull().default(0),
    errors: integer('errors').notNull().default(0),

    // how it ended (ADR-0027 "the leaving point")
    completed: boolean('completed').notNull().default(false),
    /** `LeaveReason`. */
    leaveReason: text('leave_reason').notNull().default('unknown'),
    /** 0–1: segments reached over segments planned. */
    progress: doublePrecision('progress').notNull().default(0),
    /** ms into the session when the last thing happened. */
    leftAtMs: integer('left_at_ms').notNull().default(0),
    /** The last stage that ran, and the last thing the learner did or was shown. */
    lastStage: text('last_stage'),
    lastInteraction: text('last_interaction'),
    /** An ad was on screen and never reported ending. */
    adPlayingAtEnd: boolean('ad_playing_at_end').notNull().default(false),
    /** The error nearest the end, when one was close enough to be the reason. */
    lastErrorCode: text('last_error_code'),

    // latency
    timeToFirstAudioMs: integer('time_to_first_audio_ms'),
    turnP50Ms: integer('turn_p50_ms'),
    turnP95Ms: integer('turn_p95_ms'),
    llmFirstTokenP50Ms: integer('llm_first_token_p50_ms'),
    llmFirstTokenP95Ms: integer('llm_first_token_p95_ms'),
    ttsFirstChunkP50Ms: integer('tts_first_chunk_p50_ms'),
    ttsFirstChunkP95Ms: integer('tts_first_chunk_p95_ms'),
    sttFinalP50Ms: integer('stt_final_p50_ms'),
    sttFinalP95Ms: integer('stt_final_p95_ms'),
    bargeInP50Ms: integer('barge_in_p50_ms'),
    bargeInP95Ms: integer('barge_in_p95_ms'),

    // cost — `revenueUsd` is the ad credit and is never inside `totalUsd` (ADR-0014)
    totalUsd: doublePrecision('total_usd').notNull().default(0),
    revenueUsd: doublePrecision('revenue_usd').notNull().default(0),
    llmUsd: doublePrecision('llm_usd').notNull().default(0),
    intentUsd: doublePrecision('intent_usd').notNull().default(0),
    imageUsd: doublePrecision('image_usd').notNull().default(0),
    ttsUsd: doublePrecision('tts_usd').notNull().default(0),
    sttUsd: doublePrecision('stt_usd').notNull().default(0),
    searchUsd: doublePrecision('search_usd').notNull().default(0),
    ontenUsd: doublePrecision('onten_usd').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    intentCalls: integer('intent_calls').notNull().default(0),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensCached: bigint('tokens_cached', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    ttsBytes: bigint('tts_bytes', { mode: 'number' }).notNull().default(0),
    sttSeconds: doublePrecision('stt_seconds').notNull().default(0),
    searchRequests: integer('search_requests').notNull().default(0),

    // reuse (the figures the telemetry already carries)
    packHit: boolean('pack_hit').notNull().default(false),
    intakeCacheHit: boolean('intake_cache_hit').notNull().default(false),
    memoSegmentsReused: integer('memo_segments_reused').notNull().default(0),
    memoSegmentsGenerated: integer('memo_segments_generated').notNull().default(0),
    contextSpeculationHits: integer('context_speculation_hits').notNull().default(0),
    ttsSentencesReused: integer('tts_sentences_reused').notNull().default(0),
    ttsSentencesGenerated: integer('tts_sentences_generated').notNull().default(0),
    imageReused: boolean('image_reused').notNull().default(false),
    cardReused: boolean('card_reused').notNull().default(false),
    savedUsd: doublePrecision('saved_usd').notNull().default(0),
    freshEquivalentUsd: doublePrecision('fresh_equivalent_usd').notNull().default(0),

    /** The host had analytics off when this ended; per-person reports leave the row out. */
    hostOptedOut: boolean('host_opted_out').notNull().default(false),
  },
  (t) => [
    index('session_stats_started_idx').on(t.startedAt),
    index('session_stats_host_idx').on(t.hostId, t.startedAt),
    index('session_stats_plan_idx').on(t.plan, t.startedAt),
    index('session_stats_scope_idx').on(t.scopeKey),
    index('session_stats_leave_idx').on(t.leaveReason, t.startedAt),
    index('session_stats_voice_idx').on(t.voiceEngine, t.startedAt),
    index('session_stats_version_idx').on(t.schemaVersion),
  ],
);

/** Per-stage facts for one session: what ran, how often, how long, how much. */
export const sessionStageStats = pgTable(
  'session_stage_stats',
  {
    sessionId: text('session_id').notNull(),
    /** `StageName`. */
    stage: text('stage').notNull(),
    samples: integer('samples').notNull().default(0),
    ok: integer('ok').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    reused: integer('reused').notNull().default(0),
    totalMs: bigint('total_ms', { mode: 'number' }).notNull().default(0),
    p50Ms: integer('p50_ms'),
    p95Ms: integer('p95_ms'),
    maxMs: integer('max_ms'),
    /** Cost lines attributed to this stage's component, and what its reuse saved. */
    usd: doublePrecision('usd').notNull().default(0),
    savedUsd: doublePrecision('saved_usd').notNull().default(0),
    /** When in the session this stage first and last ran, ms from the start. */
    firstAtMs: integer('first_at_ms').notNull().default(0),
    lastAtMs: integer('last_at_ms').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.stage] }),
    index('session_stage_stats_stage_idx').on(t.stage),
  ],
);

/** Error codes a session recorded, counted. Not error tracking — that is Sentry's (the `ref` lives in the ledger). */
export const sessionErrorStats = pgTable(
  'session_error_stats',
  {
    sessionId: text('session_id').notNull(),
    code: text('code').notNull(),
    stage: text('stage'),
    n: integer('n').notNull().default(0),
    firstAtMs: integer('first_at_ms').notNull().default(0),
    lastAtMs: integer('last_at_ms').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.code] }),
    index('session_error_stats_code_idx').on(t.code),
  ],
);

/**
 * Who first *generated* a piece of memoised work, claimed by the earliest
 * session the derivation sees that generated it for a scope. The reuse links
 * point back here, so "which session's work was this" is recorded rather than
 * guessed at read time.
 */
export const statsWorkOrigin = pgTable(
  'stats_work_origin',
  {
    /** `ReuseKind`. */
    kind: text('kind').notNull(),
    /** The key that kind of memo is stored under — see `scopeKeyFor` in the deriver. */
    scopeKey: text('scope_key').notNull(),
    sessionId: text('session_id').notNull(),
    /** The topic that session was started from: the first search this work was bought for. */
    topic: text('topic').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.scopeKey] }),
    index('stats_work_origin_session_idx').on(t.sessionId),
  ],
);

/**
 * One row each time a session served part of itself from another session's
 * work. `topic` is the *consuming* learner's search, which is what makes
 * "this session has been reused fourteen times, for these searches" a query.
 */
export const sessionReuseLinks = pgTable(
  'session_reuse_links',
  {
    /** `${sessionId}:${kind}` — a session reuses each kind of work once, so a re-derivation replaces. */
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** Null when nothing in the statistics generated this scope (seeded packs, deleted sessions). */
    sourceSessionId: text('source_session_id'),
    /** `ReuseKind`. */
    kind: text('kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    /** What the consuming learner typed. `sessions.topic`, copied. */
    topic: text('topic').notNull().default(''),
    canonicalId: text('canonical_id'),
    /** How many items of that kind (segments, sentences, one pack). */
    uses: integer('uses').notNull().default(1),
    savedUsd: doublePrecision('saved_usd').notNull().default(0),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('session_reuse_links_source_idx').on(t.sourceSessionId, t.at),
    index('session_reuse_links_session_idx').on(t.sessionId),
    index('session_reuse_links_scope_idx').on(t.kind, t.scopeKey),
  ],
);

// ── recorded: what happens to a session after it ends ────────────────────────
/**
 * Counters the ledger cannot know, because they happen after it closes: the
 * card being opened, the replay being watched, the link being copied, the
 * video being taken away. `sessions.views` and `sessions.likes` stay where
 * they are — they are public numbers on a card, not statistics.
 */
export const sessionEngagement = pgTable(
  'session_engagement',
  {
    sessionId: text('session_id').primaryKey(),
    replays: integer('replays').notNull().default(0),
    shares: integer('shares').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    exports: integer('exports').notNull().default(0),
    lastAt: bigint('last_at', { mode: 'number' }).notNull().default(0),
  },
  (t) => [index('session_engagement_last_idx').on(t.lastAt)],
);

// ── recorded: visits, signed in or not ───────────────────────────────────────
/**
 * One row per visit. A visit is a run of engagement with a gap of less than
 * `VISIT_GAP_MS` in it — not a tab, not a session, and not a person: the id is
 * minted per visit by the page and stored nowhere on the device, so the same
 * person tomorrow is a new row (the cookieless rule of ADR-0018 still holds).
 *
 * `active_ms` is engaged time as `VisitBeacon` defines it, never wall time.
 *
 * `country` comes from a trusted edge header where one exists and otherwise
 * from the browser's own IANA timezone, and `geo_source` says which. Region
 * and city arrive only from an edge that computes them; nothing here derives
 * a place from the address — see `docs/STATISTICS.md`.
 *
 * **`ip_address` and `user_agent` are the two identifiers in this table**
 * (ADR-0028), and the only two columns anything ever removes. A sweep clears
 * both from rows older than `PEN_VISIT_IDENTIFIER_DAYS` and leaves every
 * derived column and every count standing, so the statistics outlive the
 * identifiers behind them.
 */
export const siteVisits = pgTable(
  'site_visits',
  {
    id: text('id').primaryKey(),
    /** Null only for a beacon that arrived with no bearer at all. */
    participantId: text('participant_id'),
    /** The participant's state at the time; "signed in" is not the same question as "has an account now". */
    signedIn: boolean('signed_in').notNull().default(false),
    plan: text('plan').notNull().default('free'),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    /** Set when the page said goodbye, or by the roll-up once the gap passed. */
    endedAt: bigint('ended_at', { mode: 'number' }),
    activeMs: integer('active_ms').notNull().default(0),
    views: integer('views').notNull().default(0),
    beacons: integer('beacons').notNull().default(0),
    entryScreen: text('entry_screen'),
    lastScreen: text('last_screen'),

    // where from
    referrerHost: text('referrer_host'),
    campaignSource: text('campaign_source'),
    campaignMedium: text('campaign_medium'),
    campaignName: text('campaign_name'),

    // who with — parsed from the User-Agent and the UA client hints
    deviceType: text('device_type').notNull().default('unknown'),
    os: text('os'),
    browser: text('browser'),
    browserMajor: smallint('browser_major'),
    /**
     * The raw `User-Agent`, kept beside the parsed columns for the questions
     * the parser did not anticipate. The reports group by the parsed ones;
     * this is what you read when a device class looks wrong. Cleared by the
     * retention sweep (ADR-0028).
     */
    userAgent: text('user_agent'),

    // the machine, as the browser reports it without being asked for permission
    /** The display, in CSS pixels; `screen.width` / `screen.height`. */
    screenWidth: integer('screen_width'),
    screenHeight: integer('screen_height'),
    /** The window the page actually had; `innerWidth` / `innerHeight`. */
    viewportWidth: integer('viewport_width'),
    viewportHeight: integer('viewport_height'),
    /** `devicePixelRatio`: 1 on a plain display, 2 or 3 on a retina one. */
    devicePixelRatio: doublePrecision('device_pixel_ratio'),

    /**
     * The client address the edge reported, resolved exactly as the per-IP
     * session limit resolves it (`clientKey`, `X-Real-IP` then the first
     * `X-Forwarded-For` hop). IPv4 in dotted quad, IPv6 lowercased; anything
     * that is not an address is null rather than a string nobody can use.
     * Cleared by the retention sweep (ADR-0028).
     */
    ipAddress: text('ip_address'),

    // where — see `GeoSource`
    country: text('country'),
    region: text('region'),
    city: text('city'),
    geoSource: text('geo_source').notNull().default('none'),
    timezone: text('timezone'),
    /** Minutes east of UTC at the time, so "hour of day" can be read in the visitor's own clock. */
    utcOffsetMinutes: smallint('utc_offset_minutes'),
    language: text('language'),

    // what they did
    sessionsStarted: integer('sessions_started').notNull().default(0),
    sessionsJoined: integer('sessions_joined').notNull().default(0),
    replaysStarted: integer('replays_started').notNull().default(0),
    sharesCopied: integer('shares_copied').notNull().default(0),
    downloadsRequested: integer('downloads_requested').notNull().default(0),
    exportsRequested: integer('exports_requested').notNull().default(0),
    signInsCompleted: integer('sign_ins_completed').notNull().default(0),
    checkoutsStarted: integer('checkouts_started').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    privacyOpened: integer('privacy_opened').notNull().default(0),
    /** The last session this visit touched, for "they stopped here". */
    lastSessionId: text('last_session_id'),
  },
  (t) => [
    index('site_visits_started_idx').on(t.startedAt),
    index('site_visits_participant_idx').on(t.participantId, t.startedAt),
    index('site_visits_country_idx').on(t.country, t.startedAt),
    index('site_visits_device_idx').on(t.deviceType, t.startedAt),
    /**
     * The retention sweep's index, and the reason it costs nothing to run
     * every hour forever: it is *partial*, so it holds only the rows that
     * still carry an identifier. Once a row has been swept it leaves the
     * index, and the sweep's "anything older than the cutoff still holding
     * one?" is a lookup against an index that stays roughly the size of the
     * retention window rather than of the whole table (ADR-0028).
     */
    index('site_visits_identifier_idx')
      .on(t.startedAt)
      .where(sql`${t.ipAddress} is not null or ${t.userAgent} is not null`),
  ],
);

/** Where a visit's engaged time went. Screen names are route patterns (`session`, `room`), never ids. */
export const siteVisitScreens = pgTable(
  'site_visit_screens',
  {
    visitId: text('visit_id').notNull(),
    screen: text('screen').notNull(),
    views: integer('views').notNull().default(0),
    activeMs: integer('active_ms').notNull().default(0),
    /** Denormalised from the visit so a screen report needs no join. */
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.visitId, t.screen] }),
    index('site_visit_screens_screen_idx').on(t.screen, t.startedAt),
  ],
);

// ── recorded: the subscription's own history ─────────────────────────────────
/**
 * Every plan change Stripe told us about, in order. `participants.plan` is the
 * present tense; this is how the present came about, and it is the only way to
 * answer conversion, churn and "how many yearly" over a period rather than
 * right now.
 */
export const planEvents = pgTable(
  'plan_events',
  {
    id: text('id').primaryKey(),
    participantId: text('participant_id').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    fromPlan: text('from_plan'),
    toPlan: text('to_plan').notNull(),
    /** `month` | `year`, when Stripe's price said so. */
    interval: text('interval'),
    /** Stripe's subscription status at the time (`active`, `past_due`, `canceled`, …). */
    status: text('status'),
    /** Which webhook, or `manual` for an operator change. */
    source: text('source').notNull().default('stripe'),
    /** The price's own amount in the smallest currency unit, so MRR is arithmetic rather than a table lookup. */
    amountCents: integer('amount_cents'),
    currency: text('currency'),
  },
  (t) => [
    index('plan_events_at_idx').on(t.at),
    index('plan_events_participant_idx').on(t.participantId, t.at),
    uniqueIndex('plan_events_dedupe_idx').on(t.participantId, t.at, t.toPlan),
  ],
);

export type SessionStatsRow = typeof sessionStats.$inferSelect;
export type SessionStatsInsert = typeof sessionStats.$inferInsert;
export type SessionStageStatsRow = typeof sessionStageStats.$inferSelect;
export type SessionErrorStatsRow = typeof sessionErrorStats.$inferSelect;
export type SessionReuseLinkRow = typeof sessionReuseLinks.$inferSelect;
export type SiteVisitRow = typeof siteVisits.$inferSelect;
export type SiteVisitScreenRow = typeof siteVisitScreens.$inferSelect;
export type PlanEventRow = typeof planEvents.$inferSelect;
export type SessionEngagementRow = typeof sessionEngagement.$inferSelect;
