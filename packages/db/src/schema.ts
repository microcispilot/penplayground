import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
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
    /** Card / Open Graph copy from the same call; empty until then. */
    description: text('description').notNull().default(''),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
  },
  (t) => [
    index('sessions_host_idx').on(t.hostId, t.startedAt),
    index('sessions_public_idx').on(t.visibility, t.views),
    index('sessions_canonical_idx').on(t.canonicalId, t.startedAt),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
