import { z } from 'zod';

export const PlanCode = z.enum(['free', 'standard', 'professional']);
export type PlanCode = z.infer<typeof PlanCode>;

export const Entitlement = z.enum([
  'no_ads',
  'rooms', // host multi-participant sessions
  'export', // MP4 download of an ended session (paid plans)
  'premium_voices',
  'priority_preparation',
  'unlimited_sessions',
  'shared_replays',
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
    'shared_replays',
  ],
};

/**
 * What a plan may use, enforced server-side (never only in the UI).
 *
 * - `sessionsPerDay` — the free plan's "3 sessions a day" promise
 *   (docs/PRODUCT.md), counted per participant per **UTC day** so the reset is
 *   one predictable moment for everyone rather than a rolling window a learner
 *   cannot reason about. `null` means unlimited.
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
  /** Wall-clock ceiling for one session. */
  readonly maxSessionMinutes: number;
  /** Seats in a room, host included. */
  readonly maxParticipants: number;
}

export const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  free: { sessionsPerDay: 3, maxSessionMinutes: 20, maxParticipants: 1 },
  standard: { sessionsPerDay: null, maxSessionMinutes: 45, maxParticipants: 1 },
  professional: { sessionsPerDay: null, maxSessionMinutes: 60, maxParticipants: 12 },
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
 * What `GET /api/me/usage` tells the client: enough for Home to show "2 of 3
 * sessions left today" and to explain, in one friendly sentence, why Start is
 * waiting — never more than the caller's own numbers.
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
