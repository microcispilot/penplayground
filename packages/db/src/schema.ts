import {
  bigint,
  boolean,
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
    /** Relative URL of the rendered sketch (`/api/sessions/<id>/thumb.svg`); null until the background job lands (ADR-0013). */
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
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type SessionVisitRow = typeof sessionVisits.$inferSelect;
