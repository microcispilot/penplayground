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

export type SessionRow = typeof sessions.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type SessionVisitRow = typeof sessionVisits.$inferSelect;
export type SessionRedirectRow = typeof sessionRedirects.$inferSelect;
export type RuntimeConfigAuditRow = typeof runtimeConfigAudits.$inferSelect;
