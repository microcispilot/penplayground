import { FeedbackEntry, SurveyResponseRow, SurveySummary } from '@pen/contracts';
import { z } from 'zod';

/**
 * The reporting API's answers, as schemas (ADR-0027).
 *
 * The console's rule is that nothing is rendered that was not parsed
 * (`api.ts`), and these are that parse. They are written against
 * `services/api/src/stats/routes.ts` and the row shapes in
 * `packages/db/src/reports.ts` — one schema per route, in the order the
 * routes declare them — so a column that changes name on the server fails
 * here, loudly, rather than rendering as `undefined` somewhere in a table.
 *
 * Nullability is copied exactly. `timeToFirstAudioMs` is null when no audio
 * ever played and `region`/`city` are null unless an edge supplied them; both
 * are facts the pages say out loud, so neither may be defaulted to zero here.
 */

const num = z.number();
const int = z.number().int();
const nullableNum = z.number().nullable();

export const Window = z.object({ from: num, to: num });
export type Window = z.infer<typeof Window>;

export const BucketName = z.enum(['hour', 'day', 'week', 'month']);

// ── /overview ────────────────────────────────────────────────────────────────

export const OverviewReport = z.object({
  window: Window,
  sessions: int,
  completed: int,
  completionRate: num,
  learners: int,
  totalUsd: num,
  revenueUsd: num,
  savedUsd: num,
  freshEquivalentUsd: num,
  costPerSessionUsd: num,
  reuseRate: num,
  packHitRate: num,
  durationMs: num,
  avgDurationMs: num,
  avgProgress: num,
  errors: int,
  timeToFirstAudioP50Ms: nullableNum,
  timeToFirstAudioP95Ms: nullableNum,
  visits: int,
  visitors: int,
  activeMs: num,
  visitToSession: num,
});
export type OverviewReport = z.infer<typeof OverviewReport>;

export const ReuseTotals = z.object({
  window: Window,
  sessions: int,
  packHits: int,
  pictureReuses: int,
  cardReuses: int,
  memoSegmentsReused: int,
  memoSegmentsGenerated: int,
  ttsSentencesReused: int,
  ttsSentencesGenerated: int,
  contextSpeculationHits: int,
  savedUsd: num,
  totalUsd: num,
  freshEquivalentUsd: num,
  savedShare: num,
  byKind: z.array(z.object({ kind: z.string(), links: int, uses: int, savedUsd: num })),
});
export type ReuseTotals = z.infer<typeof ReuseTotals>;

export const AbandonmentReport = z.object({
  window: Window,
  reasons: z.array(
    z.object({
      reason: z.string(),
      sessions: int,
      avgProgress: num,
      avgDurationMs: num,
      avgSegmentReached: num,
    }),
  ),
  bySegment: z.array(z.object({ segment: int, sessions: int })),
  lastSeen: z.array(
    z.object({ lastInteraction: z.string(), lastStage: z.string(), sessions: int }),
  ),
});
export type AbandonmentReport = z.infer<typeof AbandonmentReport>;

export const OverviewPayload = z.object({
  overview: OverviewReport,
  reuse: ReuseTotals,
  abandonment: AbandonmentReport,
});
export type OverviewPayload = z.infer<typeof OverviewPayload>;

// ── /cost ────────────────────────────────────────────────────────────────────

export const CostPoint = z.object({
  at: num,
  sessions: int,
  totalUsd: num,
  llmUsd: num,
  intentUsd: num,
  imageUsd: num,
  ttsUsd: num,
  sttUsd: num,
  searchUsd: num,
  revenueUsd: num,
  freshEquivalentUsd: num,
  savedUsd: num,
});
export type CostPoint = z.infer<typeof CostPoint>;

export const StageSummaryRow = z.object({
  stage: z.string(),
  sessions: int,
  samples: int,
  failed: int,
  reused: int,
  usd: num,
  savedUsd: num,
  p50Ms: nullableNum,
  p95Ms: nullableNum,
  maxMs: nullableNum,
});
export type StageSummaryRow = z.infer<typeof StageSummaryRow>;

export const CostPayload = z.object({
  window: Window,
  bucket: BucketName,
  series: z.array(CostPoint),
  totals: CostPoint.omit({ at: true }),
  byPlan: z.array(
    z.object({ plan: z.string(), sessions: int, totalUsd: num, costPerSessionUsd: num }),
  ),
  byExpert: z.array(z.object({ expertId: z.string(), sessions: int, totalUsd: num })),
  /** Per voice engine (ADR-0048); absent from an API older than the engines, so it defaults to none. */
  byVoiceEngine: z
    .array(
      z.object({
        engine: z.string(),
        sessions: int,
        totalUsd: num,
        ttsUsd: num,
        costPerSessionUsd: num,
        ttsFirstChunkP50Ms: nullableNum,
      }),
    )
    .default([]),
  stages: z.array(StageSummaryRow),
});
export type CostPayload = z.infer<typeof CostPayload>;

// ── /stages ──────────────────────────────────────────────────────────────────

export const StagesPayload = z.object({
  window: Window,
  stages: z.array(StageSummaryRow),
  errors: z.array(
    z.object({ code: z.string(), stage: z.string().nullable(), n: int, sessions: int }),
  ),
});
export type StagesPayload = z.infer<typeof StagesPayload>;

// ── /retention ───────────────────────────────────────────────────────────────

export const RetentionPayload = z.object({
  window: Window,
  bucket: BucketName,
  metric: z.enum(['session', 'visit']),
  cohorts: z.array(z.object({ cohort: num, size: int, periods: z.array(int) })),
});
export type RetentionPayload = z.infer<typeof RetentionPayload>;

// ── /sessions ────────────────────────────────────────────────────────────────

export const SessionListRow = z.object({
  sessionId: z.string(),
  topic: z.string(),
  title: z.string(),
  hostId: z.string(),
  plan: z.string(),
  expertId: z.string(),
  language: z.string(),
  band: z.string(),
  domain: z.string(),
  canonicalId: z.string().nullable(),
  voiceEngine: z.string().nullable().default(null),
  voiceTts: z.string().nullable().default(null),
  startedAt: num,
  endedAt: nullableNum,
  durationMs: num,
  segmentsPlanned: int,
  segmentsReached: int,
  progress: num,
  completed: z.boolean(),
  leaveReason: z.string(),
  lastStage: z.string().nullable(),
  lastInteraction: z.string().nullable(),
  adPlayingAtEnd: z.boolean(),
  lastErrorCode: z.string().nullable(),
  questions: int,
  interrupts: int,
  participants: int,
  errors: int,
  totalUsd: num,
  revenueUsd: num,
  savedUsd: num,
  freshEquivalentUsd: num,
  packHit: z.boolean(),
  timeToFirstAudioMs: nullableNum,
  turnP50Ms: nullableNum,
  views: int,
  replays: int,
  shares: int,
  reusedBy: int,
});
export type SessionListRow = z.infer<typeof SessionListRow>;

export const SessionsPayload = z.object({
  window: Window,
  total: int,
  sessions: z.array(SessionListRow),
});
export type SessionsPayload = z.infer<typeof SessionsPayload>;

export const SessionDetail = z.object({
  session: SessionListRow,
  downloads: int,
  exports: int,
  stages: z.array(
    z.object({
      stage: z.string(),
      samples: int,
      ok: int,
      failed: int,
      reused: int,
      totalMs: num,
      p50Ms: nullableNum,
      p95Ms: nullableNum,
      maxMs: nullableNum,
      usd: num,
      savedUsd: num,
      firstAtMs: num,
      lastAtMs: num,
    }),
  ),
  errors: z.array(
    z.object({
      code: z.string(),
      stage: z.string().nullable(),
      n: int,
      firstAtMs: num,
      lastAtMs: num,
    }),
  ),
  tookFrom: z.array(
    z.object({
      kind: z.string(),
      sourceSessionId: z.string().nullable(),
      uses: int,
      savedUsd: num,
    }),
  ),
  gaveTo: z.object({
    reusedBy: int,
    uses: int,
    savedForOthersUsd: num,
    byKind: z.array(z.object({ kind: z.string(), uses: int, savedUsd: num })),
    searches: z.array(z.object({ topic: z.string(), uses: int, lastAt: num })),
  }),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

// ── /users ───────────────────────────────────────────────────────────────────

export const UserRow = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string(),
  planInterval: z.string().nullable(),
  anonymous: z.boolean(),
  analyticsOptOut: z.boolean(),
  createdAt: num,
  lastSeenAt: num,
  sessions: int,
  completed: int,
  totalUsd: num,
  sessionMs: num,
  visits: int,
  activeMs: num,
  country: z.string().nullable(),
  deviceType: z.string().nullable(),
});
export type UserRow = z.infer<typeof UserRow>;

export const UsersPayload = z.object({ window: Window, total: int, users: z.array(UserRow) });
export type UsersPayload = z.infer<typeof UsersPayload>;

/**
 * `/users/:id` answers with the participant row itself, so `createdAt` and
 * `lastSeenAt` arrive as ISO strings from `timestamp` columns rather than as
 * the epoch milliseconds every other report uses. Accepted in both shapes and
 * normalised here, once, so no screen has to know.
 */
const epoch = z.union([z.number(), z.string()]).transform((v) => {
  if (typeof v === 'number') return v;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? 0 : parsed;
});

export const UserDetail = z.object({
  participant: z.object({
    id: z.string(),
    name: z.string(),
    plan: z.string(),
    planInterval: z.string().nullable(),
    planStatus: z.string().nullable(),
    anonymous: z.boolean(),
    email: z.string().nullable(),
    analyticsOptOut: z.boolean(),
    createdAt: epoch,
    lastSeenAt: epoch,
  }),
  window: Window,
  sessions: z.array(SessionListRow),
  /** The person's own history (ADR-0060). */
  planEvents: z.array(
    z.object({
      at: epoch,
      fromPlan: z.string().nullable(),
      toPlan: z.string(),
      interval: z.string().nullable(),
      status: z.string().nullable(),
      source: z.string().nullable(),
      amountCents: int.nullable(),
      currency: z.string().nullable(),
    }),
  ),
  feedback: z.array(FeedbackEntry),
  surveys: z.array(SurveyResponseRow),
  totals: z.object({
    sessions: int,
    completed: int,
    totalUsd: num,
    sessionMs: num,
    visits: int,
    activeMs: num,
  }),
});
export type UserDetail = z.infer<typeof UserDetail>;

// ── /reuse ───────────────────────────────────────────────────────────────────

export const ReusePayload = ReuseTotals.extend({
  mostReused: z.array(
    z.object({
      sessionId: z.string(),
      topic: z.string(),
      reusedBy: int,
      uses: int,
      savedForOthersUsd: num,
    }),
  ),
});
export type ReusePayload = z.infer<typeof ReusePayload>;

export const SessionReusePayload = z.object({
  sessionId: z.string(),
  topic: z.string(),
  canonicalId: z.string().nullable(),
  reusedBy: int,
  uses: int,
  savedForOthersUsd: num,
  byKind: z.array(z.object({ kind: z.string(), uses: int, savedUsd: num })),
  searches: z.array(z.object({ topic: z.string(), uses: int, lastAt: num })),
});
export type SessionReusePayload = z.infer<typeof SessionReusePayload>;

// ── /visits ──────────────────────────────────────────────────────────────────

export const VisitPoint = z.object({
  at: num,
  visits: int,
  visitors: int,
  signedIn: int,
  anonymous: int,
  activeMs: num,
  bounces: int,
  sessionsStarted: int,
});
export type VisitPoint = z.infer<typeof VisitPoint>;

export const VisitsPayload = z.object({
  window: Window,
  bucket: BucketName,
  series: z.array(VisitPoint),
  totals: z.object({
    visits: int,
    visitors: int,
    activeMs: num,
    medianActiveMs: num,
    bounceRate: num,
    sessionsStarted: int,
    conversion: num,
  }),
  byScreen: z.array(z.object({ screen: z.string(), views: int, visits: int, activeMs: num })),
  byReferrer: z.array(
    z.object({
      referrerHost: z.string().nullable(),
      campaignSource: z.string().nullable(),
      visits: int,
      sessionsStarted: int,
    }),
  ),
  activeTime: z.object({ heartbeatMs: num, idleMs: num, definition: z.string() }),
});
export type VisitsPayload = z.infer<typeof VisitsPayload>;

// ── /geography, /devices, /clock, /plans ─────────────────────────────────────

export const GeographyPayload = z.object({
  window: Window,
  rows: z.array(
    z.object({
      country: z.string().nullable(),
      region: z.string().nullable(),
      city: z.string().nullable(),
      source: z.string(),
      visits: int,
      visitors: int,
      activeMs: num,
      sessions: int,
    }),
  ),
  /** The server's own sentence about what these numbers are worth. Printed verbatim. */
  note: z.string(),
});
export type GeographyPayload = z.infer<typeof GeographyPayload>;

export const DevicesPayload = z.object({
  window: Window,
  rows: z.array(
    z.object({
      deviceType: z.string(),
      os: z.string().nullable(),
      browser: z.string().nullable(),
      visits: int,
      visitors: int,
      activeMs: num,
      sessions: int,
    }),
  ),
});
export type DevicesPayload = z.infer<typeof DevicesPayload>;

export const ClockPayload = z.object({
  window: Window,
  sessionsUtc: z.array(z.object({ dayOfWeek: int, hour: int, n: int })),
  visitsLocal: z.array(z.object({ dayOfWeek: int, hour: int, n: int, activeMs: num })),
});
export type ClockPayload = z.infer<typeof ClockPayload>;

export const PlansPayload = z.object({
  window: Window,
  bucket: BucketName,
  mix: z.array(
    z.object({
      plan: z.string(),
      interval: z.enum(['month', 'year']).nullable(),
      status: z.string().nullable(),
      participants: int,
      active: int,
    }),
  ),
  changes: z.array(
    z.object({
      at: num,
      upgrades: int,
      cancellations: int,
      monthly: int,
      yearly: int,
      amountCents: int,
    }),
  ),
});
export type PlansPayload = z.infer<typeof PlansPayload>;

// ── /people and /surveys (ADR-0060) ──────────────────────────────────────────

export const PeopleSummary = z.object({
  accounts: int,
  newAccounts: int,
  anonymous: int,
  freeAccounts: int,
  paying: int,
  byPlan: z.object({ standard: int, professional: int }),
  byInterval: z.object({ month: int, year: int }),
  cancelling: int,
  visitors: int,
  returning: int,
  active: z.object({ day: int, week: int, month: int }),
  learners: int,
  sessions: int,
  avgActiveMsPerVisitor: num,
  avgSessionMs: num,
  totalUsd: num,
  costPerLearnerUsd: num,
  costPerPayingUsd: num,
  revenueUsd: num,
  subscribed: int,
  churned: int,
});
export type PeopleSummary = z.infer<typeof PeopleSummary>;

export const PeoplePayload = z.object({
  window: Window,
  summary: PeopleSummary,
  top: z.object({
    byCost: z.array(UserRow),
    bySessions: z.array(UserRow),
    byTime: z.array(UserRow),
  }),
});
export type PeoplePayload = z.infer<typeof PeoplePayload>;

export const SurveysPayload = z.object({ window: Window, surveys: z.array(SurveySummary) });
export type SurveysPayload = z.infer<typeof SurveysPayload>;
