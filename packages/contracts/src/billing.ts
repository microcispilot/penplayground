import { z } from 'zod';

export const PlanCode = z.enum(['free', 'standard', 'professional']);
export type PlanCode = z.infer<typeof PlanCode>;

/**
 * Whose budget a provider call belongs to, and therefore which of the four
 * OpenAI keys runs it. The three plans are a learner's work, chosen by the
 * HOST'S plan and never falling back to one another — that is how spend is
 * attributed and how one tier's rate limit is kept out of another's way.
 * `platform` is the odd one out: work that belongs to no learner at all —
 * backfills, probes, prewarming. A session's work, background jobs included,
 * is never billed to it.
 */
export const KeyOwner = z.enum([...PlanCode.options, 'platform']);
export type KeyOwner = z.infer<typeof KeyOwner>;

export const Entitlement = z.enum([
  'no_ads',
  'rooms', // host multi-participant sessions
  'export', // MP4 download of an ended session (paid plans)
  'premium_voices',
  'priority_preparation',
  'unlimited_sessions',
]);
export type Entitlement = z.infer<typeof Entitlement>;

export const PLAN_ENTITLEMENTS: Record<PlanCode, readonly Entitlement[]> = {
  free: [],
  standard: ['no_ads', 'export', 'premium_voices', 'priority_preparation', 'unlimited_sessions'],
  professional: [
    'no_ads',
    'rooms',
    'export',
    'premium_voices',
    'priority_preparation',
    'unlimited_sessions',
  ],
};

/**
 * What a plan may use, enforced server-side (never only in the UI).
 *
 * - `sessionsPerDay` — sessions a participant may start per **UTC day**;
 *   `null` means unlimited. Since ADR-0040 every plan is unlimited: a free
 *   session is a prepared lesson replayed, ad-supported, and costs the house
 *   next to nothing. The field stays so a plan can be capped again from one
 *   table if the economics change.
 * - `customSessions` — how many topics nobody has prepared a learner may
 *   have prepared for them, over the life of the account (ADR-0040): one on
 *   the free plan (`PEN_FREE_CUSTOM_SESSIONS` on the server), unlimited when
 *   paying, none for a visitor without an account. The expensive path.
 * - `maxSessionMinutes` — how long one session may run before the room ends
 *   itself. Free is 20 because that is the session docs/COST.md budgets
 *   (≈ $0.30 of provider spend); Standard 45 and Professional 60 leave room for
 *   a long class while still bounding a forgotten tab.
 * - `maxParticipants` — everyone in the room, host included, so
 *   `maxParticipants - 1` is the guests-per-room cap. Only Professional hosts
 *   rooms (`rooms` entitlement); solo plans seat the host alone.
 */
export interface PlanLimits {
  /** Sessions a participant may start per UTC day; null = unlimited. */
  readonly sessionsPerDay: number | null;
  /** Topics prepared for this learner over the life of the account; null = unlimited. */
  readonly customSessions: number | null;
  /** Wall-clock ceiling for one session. */
  readonly maxSessionMinutes: number;
  /** Seats in a room, host included. */
  readonly maxParticipants: number;
}

export const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  free: { sessionsPerDay: null, customSessions: 1, maxSessionMinutes: 20, maxParticipants: 1 },
  standard: {
    sessionsPerDay: null,
    customSessions: null,
    maxSessionMinutes: 45,
    maxParticipants: 1,
  },
  professional: {
    sessionsPerDay: null,
    customSessions: null,
    maxSessionMinutes: 60,
    maxParticipants: 12,
  },
};

export function planLimits(plan: PlanCode): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** Guests (everyone but the host) a plan may seat. */
export function guestsPerRoom(plan: PlanCode): number {
  return Math.max(0, PLAN_LIMITS[plan].maxParticipants - 1);
}

/**
 * The start of the UTC day `at` falls in. Session quotas reset here, so a
 * learner in any timezone gets the same answer from the server and the UI.
 */
export function utcDayStart(at: number): number {
  return Date.UTC(
    new Date(at).getUTCFullYear(),
    new Date(at).getUTCMonth(),
    new Date(at).getUTCDate(),
  );
}

/** How many sessions are left today; null when the plan is unlimited. */
export function sessionsRemaining(plan: PlanCode, startedToday: number): number | null {
  const cap = PLAN_LIMITS[plan].sessionsPerDay;
  return cap === null ? null : Math.max(0, cap - startedToday);
}

/**
 * What `GET /api/me/usage` tells the client: enough to explain, in one
 * friendly sentence, why Start is waiting — never more than the caller's own
 * numbers. Home says nothing at all while there is allowance left; a running
 * count is a meter, and a meter is a kind of pressure.
 */
export const PlanUsage = z.object({
  plan: PlanCode,
  /** Sessions started since the current UTC day began. */
  sessionsToday: z.number().int().nonnegative(),
  /** Cap for this plan; null = unlimited. */
  sessionsPerDay: z.number().int().positive().nullable(),
  /** Sessions left today; null = unlimited. */
  remaining: z.number().int().nonnegative().nullable(),
  maxSessionMinutes: z.number().int().positive(),
  /** When the count resets (ms epoch, the next UTC midnight). */
  resetsAt: z.number().int().nonnegative(),
  /** Topics prepared for this learner so far, and how many the plan allows; null = unlimited (ADR-0040). */
  customSessionsUsed: z.number().int().nonnegative().optional(),
  customSessions: z.number().int().nonnegative().nullable().optional(),
  /**
   * False while the day's spend cap is holding new free sessions back
   * (ADR-0016). Paid plans keep starting; the client says so kindly.
   */
  canStart: z.boolean(),
  /** Why Start is waiting, in one friendly sentence; null when nothing is in the way. */
  reason: z.enum(['daily_limit', 'capacity']).nullable(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

export const BillingInterval = z.enum(['month', 'year']);
export type BillingInterval = z.infer<typeof BillingInterval>;

/**
 * What a plan costs, in whole US dollars, by billing interval (ADR-0056).
 * The one place the number is written: the pricing page reads it, the API
 * checks the configured Stripe prices against it at boot, and the Stripe
 * script creates prices from it. A year is ten months, so the page can say
 * "two months free" and mean it.
 *
 * The owner, 2026-09-25: *"I want the subscription prices to be 29 and 49."*
 */
export const PLAN_PRICES_USD: Record<PlanCode, Record<BillingInterval, number>> = {
  free: { month: 0, year: 0 },
  standard: { month: 29, year: 290 },
  professional: { month: 49, year: 490 },
};

/** What a month costs on the given interval: the yearly price spread over twelve months, rounded. */
export function monthlyEquivalentUsd(plan: PlanCode, interval: BillingInterval): number {
  const prices = PLAN_PRICES_USD[plan];
  return interval === 'month' ? prices.month : Math.round(prices.year / 12);
}

export const PlanCatalogEntry = z.object({
  code: PlanCode,
  name: z.string(),
  monthlyUsd: z.number().nonnegative(),
  annualUsd: z.number().nonnegative(),
  highlight: z.boolean(),
  features: z.array(z.string()),
});
export type PlanCatalogEntry = z.infer<typeof PlanCatalogEntry>;

export function hasEntitlement(plan: PlanCode, entitlement: Entitlement): boolean {
  return PLAN_ENTITLEMENTS[plan].includes(entitlement);
}
