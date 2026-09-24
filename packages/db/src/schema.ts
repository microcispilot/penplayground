import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Statistics and reports (ADR-0027): derived session facts, visits, and the subscription's history. */
export * from './stats-schema.js';

/**
 * Persistent records. Sessions are the product's durable object; the
 * recording ledger's events stay in object/file storage and are referenced
 * by session id. Participants become accounts when sign-in lands: the same
 * row gains an email and a provider.
 */
export const participants = pgTable(
  'participants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    plan: text('plan', { enum: ['free', 'standard', 'professional'] })
      .notNull()
      .default('free'),
    anonymous: boolean('anonymous').notNull().default(true),
    /**
     * Topics prepared for this learner over the life of the account
     * (ADR-0040): the free plan's one custom session is counted here, and the
     * count survives an upgrade and a downgrade alike.
     */
    customSessions: integer('custom_sessions').notNull().default(0),
    /** The expert a paying learner chose to start every search with (ADR-0040); null = the visit's random pick. */
    defaultExpertId: text('default_expert_id'),
    email: text('email'),
    provider: text('provider'),
    /** Google's stable account id (`sub` in the ID token); the one key a Google sign-in is looked up by. */
    googleSub: text('google_sub'),
    avatarUrl: text('avatar_url'),
    stripeCustomerId: text('stripe_customer_id'),
    /**
     * What Stripe's price says the plan is billed at — `month` or `year` —
     * with the status and the moment it last changed. `plan` alone cannot
     * tell monthly from yearly, and the owner's subscription statistics are
     * mostly that split (ADR-0027). Null on a free row and on any paid row
     * predating the column, until its next webhook.
     */
    planInterval: text('plan_interval', { enum: ['month', 'year'] }),
    planStatus: text('plan_status'),
    planSince: timestamp('plan_since', { withTimezone: true }),
    /**
     * The learner turned analytics off under "Privacy choices". There is no
     * consent banner to answer (ADR-0018): analytics are cookieless and
     * content-free by construction, and this is the switch for anyone who
     * would rather not be counted at all — honoured on the server as well as
     * in the browser.
     */
    analyticsOptOut: boolean('analytics_opt_out').notNull().default(false),
    /**
     * How fast this learner likes to be taught (ADR-0010). Chosen in the
     * session's own settings and kept, the way a video's playback speed is
     * kept: their next session starts here instead of at 1x. Anonymous rows
     * carry the default and the device's own preference stands.
     */
    pace: doublePrecision('pace').notNull().default(1),
    /**
     * The board this learner chose (ADR-0034): `{ surface, marker, chalk }`.
     *
     * One column rather than three because the three values are one decision,
     * and a half-written preference — a surface from today beside a chalk from
     * a build that spelled it differently — is the failure a single parse
     * cannot produce.
     *
     * Nullable on purpose, and it means "never chose" rather than "chose the
     * default". The device's own copy is the authoritative one (see
     * `lib/board-preference.ts`); this exists so the choice survives a new
     * machine, exactly as `pace` does. It is read back through
     * `BoardPreference.safeParse`, so a row written by a newer build with a
     * board this one has never heard of degrades to the default instead of
     * throwing.
     */
    board: jsonb('board'),
    /**
     * Argon2id hash, or null.
     *
     * Null is the normal state for most rows and means "this account has no
     * password", not "the password is empty": every anonymous learner and
     * every Google-only account lives here. `verifyPassword` is given the null
     * and still does the work, so an address without a password takes exactly
     * as long to refuse as a wrong password does.
     */
    passwordHash: text('password_hash'),
    /**
     * When the address was proved to belong to whoever holds this account.
     *
     * Set at the moment of registration, because registration *is* the proof —
     * the account only exists once a code sent to that mailbox came back. It
     * is a timestamp rather than a boolean so "when" is answerable later, and
     * null for accounts that never proved an address (anonymous rows, and
     * Google rows where Google did the proving instead).
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('participants_google_sub_idx').on(t.googleSub)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    topic: text('topic').notNull(),
    title: text('title').notNull(),
    promise: text('promise').notNull().default(''),
    expertId: text('expert_id').notNull(),
    hostId: text('host_id').notNull(),
    hostName: text('host_name').notNull(),
    band: text('band', { enum: ['beginner', 'intermediate', 'advanced'] }).notNull(),
    domain: text('domain').notNull(),
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    endedAt: bigint('ended_at', { mode: 'number' }),
    durationMs: integer('duration_ms').notNull().default(0),
    segments: integer('segments').notNull().default(0),
    questions: integer('questions').notNull().default(0),
    recap: jsonb('recap').$type<string[]>().notNull().default([]),
    views: integer('views').notNull().default(0),
    /**
     * Relative URL of the session's card picture (`/api/sessions/<id>/thumb.webp`
     * since ADR-0022; `thumb.png` and `thumb.svg` on older records, both still
     * served); null until the background job lands (ADR-0013).
     */
    thumbnail: text('thumbnail'),
    /** `${lang}.${slug}` from the Onten registry: groups same-intent sessions for reuse statistics. */
    canonicalId: text('canonical_id'),
    /** BCP-47 language the session was taught in; drives `<html lang>`, caption direction and dates. */
    language: text('language').notNull().default('en-US'),
    /** Card / Open Graph copy from the same call; empty until then. */
    description: text('description').notNull().default(''),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    /** Denormalised `count(session_likes)`; moved with each like/unlike in the same transaction (ADR-0015). */
    likes: integer('likes').notNull().default(0),
  },
  (t) => [
    index('sessions_host_idx').on(t.hostId, t.startedAt),
    index('sessions_public_idx').on(t.visibility, t.views),
    index('sessions_canonical_idx').on(t.canonicalId, t.startedAt),
  ],
);

/*
 * A participant's lists (ADR-0015). Each is a (participant, session) pair, so a
 * second save or like is a no-op rather than a duplicate, and each is keyed
 * by participant id — the anonymous row's rows move with it on Google sign-in
 * exactly like its sessions do.
 */
export const sessionSaves = pgTable(
  'session_saves',
  {
    participantId: text('participant_id').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.participantId, t.sessionId] }),
    index('session_saves_participant_idx').on(t.participantId, t.createdAt),
    // By session, not by participant: what the catalogue's engagement count
    // groups on, and what moving a collapsed session's shelves reads.
    index('session_saves_session_idx').on(t.sessionId),
  ],
);

export const sessionLikes = pgTable(
  'session_likes',
  {
    participantId: text('participant_id').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.participantId, t.sessionId] }),
    index('session_likes_participant_idx').on(t.participantId, t.createdAt),
    index('session_likes_session_idx').on(t.sessionId),
  ],
);

/**
 * History: every session a participant sat in (as host or guest), recorded
 * when they take a seat in the live room. One row per pair; a rejoin only
 * moves `last_joined_at`, so "most recent first" is one indexed read.
 */
/**
 * Comments under a saved session (ADR-0044). Plain text, one author, one
 * session; a deletion keeps the row with `deleted_at` set so a thread's count
 * and order stay honest and an abuse report can still be answered. Author
 * name and picture are read from `participants` at listing time, never
 * copied, so a rename follows.
 */
export const sessionComments = pgTable(
  'session_comments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    index('session_comments_session_idx').on(t.sessionId, t.createdAt),
    index('session_comments_author_idx').on(t.authorId),
  ],
);
export type SessionCommentRow = typeof sessionComments.$inferSelect;

export const sessionVisits = pgTable(
  'session_visits',
  {
    participantId: text('participant_id').notNull(),
    sessionId: text('session_id').notNull(),
    role: text('role', { enum: ['host', 'guest'] }).notNull(),
    firstJoinedAt: bigint('first_joined_at', { mode: 'number' }).notNull(),
    lastJoinedAt: bigint('last_joined_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.participantId, t.sessionId] }),
    index('session_visits_participant_idx').on(t.participantId, t.lastJoinedAt),
    /** By session: what moving or erasing one session's history rows reads. */
    index('session_visits_session_idx').on(t.sessionId),
  ],
);

/**
 * Where a session id that no longer exists now points (ADR-0031).
 *
 * Two sessions taught from the same lesson memo are the same lesson told
 * twice; the catalogue shows one of them, and `sessions:dedupe` erases the
 * rest. A share link somebody already has must not become a 404 because of
 * housekeeping, so every erased id leaves this one row behind and the read
 * routes follow it to the session that was kept.
 *
 * One hop, always: when a survivor is itself later collapsed, the rows that
 * pointed at it are repointed rather than chained, so resolution is a single
 * indexed lookup and can never loop. The check enforces the base case.
 */
export const sessionRedirects = pgTable(
  'session_redirects',
  {
    /** The id that is gone. */
    fromId: text('from_id').primaryKey(),
    /** The session it resolves to, which exists. */
    toId: text('to_id').notNull(),
    /** Why it moved, for the operator reading the table a year from now. */
    reason: text('reason').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('session_redirects_to_idx').on(t.toId),
    check('session_redirects_not_self', sql`${t.fromId} <> ${t.toId}`),
  ],
);

/**
 * The runtime configuration this deployment is running on (ADR-0025) — which
 * intent provider, which models, how big the voice store is — as one JSON
 * document under one row. A setting absent from the document is not "off": it
 * means nobody has overridden the compiled-in default, which is why an empty
 * table is the same product as no table at all.
 *
 * One row, enforced by the database rather than by convention, because two
 * rows would be two answers to "what is this deployment running on".
 * `revision` is the concurrency token: a save carrying a stale one is refused
 * rather than silently winning over whoever saved in between.
 */
export const runtimeConfigState = pgTable(
  'runtime_config_state',
  {
    id: integer('id').primaryKey(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /** The participant who saved it; null only for the empty revision 0 the table is born with. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('runtime_config_state_singleton', sql`${t.id} = 1`),
    check('runtime_config_state_revision', sql`${t.revision} >= 0`),
  ],
);

/**
 * Every revision that was ever in force, append-only. A rollback writes a new
 * revision carrying an old document rather than deleting the ones after it:
 * "we went back" is itself a thing that happened, and a history that can be
 * rewritten cannot answer "what was this running when that session was taught".
 */
export const runtimeConfigAudits = pgTable(
  'runtime_config_audits',
  {
    revision: bigint('revision', { mode: 'number' }).primaryKey(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /** Denormalised so history reads without a join, and survives the account being deleted. */
    updatedByName: text('updated_by_name').notNull(),
    reason: text('reason').notNull(),
    /** Set when this revision restored an earlier one, and says which. */
    restoredFromRevision: bigint('restored_from_revision', { mode: 'number' }),
  },
  (t) => [
    index('runtime_config_audits_updated_idx').on(t.updatedAt),
    check('runtime_config_audits_revision', sql`${t.revision} > 0`),
    check(
      'runtime_config_audits_restored',
      sql`${t.restoredFromRevision} is null or ${t.restoredFromRevision} < ${t.revision}`,
    ),
  ],
);

/**
 * Feature flags (ADR-0036): the same shape as the runtime configuration —
 * one singleton document with a revision, and an append-only history — for
 * the same reasons. `rules` is a `FeatureRulesDocument` (contracts): only
 * the features the owner has overridden, each as a whole rule.
 */
export const featureFlagsState = pgTable(
  'feature_flags_state',
  {
    id: integer('id').primaryKey(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    rules: jsonb('rules').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('feature_flags_state_singleton', sql`${t.id} = 1`),
    check('feature_flags_state_revision', sql`${t.revision} >= 0`),
  ],
);

export const featureFlagsAudits = pgTable(
  'feature_flags_audits',
  {
    revision: bigint('revision', { mode: 'number' }).primaryKey(),
    rules: jsonb('rules').$type<Record<string, unknown>>().notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedByName: text('updated_by_name').notNull(),
    reason: text('reason').notNull(),
    restoredFromRevision: bigint('restored_from_revision', { mode: 'number' }),
  },
  (t) => [
    index('feature_flags_audits_updated_idx').on(t.updatedAt),
    check('feature_flags_audits_revision', sql`${t.revision} > 0`),
    check(
      'feature_flags_audits_restored',
      sql`${t.restoredFromRevision} is null or ${t.restoredFromRevision} < ${t.revision}`,
    ),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type SessionVisitRow = typeof sessionVisits.$inferSelect;
export type SessionRedirectRow = typeof sessionRedirects.$inferSelect;
export type RuntimeConfigAuditRow = typeof runtimeConfigAudits.$inferSelect;
export type FeatureFlagsAuditRow = typeof featureFlagsAudits.$inferSelect;

/**
 * A one-time code sent to an address, and the only thing standing between a
 * stranger and an account.
 *
 * Ported from Simurgh's `auth_email_challenges`, with one deliberate addition:
 * `purpose`. Simurgh has registration challenges only — it has no
 * password-reset flow at all — and a reset needs exactly the same machinery
 * with different consequences, so the discriminator lives on the row rather
 * than in a second table nobody would keep in step.
 *
 * ── what is stored, and what is not ────────────────────────────────────────
 *
 * Never the code. `codeDigest` is an HMAC over the code *bound to the
 * challenge id and the address*, so a stolen table is not a set of usable
 * codes, and a digest lifted from one row cannot be replayed into another.
 *
 * The counters are the whole defence against guessing eight digits:
 * `failedAttempts` locks the row at five, `sendCount` caps how many codes one
 * request can generate, and `resendNotBefore` is the cooldown. A resend does
 * not update this row — it locks it and inserts a new one, so a code that was
 * already sent can never be revived.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    /** 'register' | 'reset'. Text, not an enum: adding a purpose should not be a migration. */
    purpose: text('purpose').notNull(),
    /** Lowercased and trimmed by the contract before it ever reaches here. */
    email: text('email').notNull(),
    codeDigest: text('code_digest').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    sendCount: integer('send_count').notNull().default(1),
    resendNotBefore: timestamp('resend_not_before', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_challenges_email_idx').on(t.email, t.purpose)],
);

export type AuthChallengeRow = typeof authChallenges.$inferSelect;
