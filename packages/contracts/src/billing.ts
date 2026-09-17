import { z } from 'zod';

export const PlanCode = z.enum(['free', 'plus', 'classroom']);
export type PlanCode = z.infer<typeof PlanCode>;

export const Entitlement = z.enum([
  'no_ads',
  'rooms', // host multi-participant sessions
  'export', // MP4 export + YouTube share
  'premium_voices',
  'priority_preparation',
  'unlimited_sessions',
  'shared_replays',
]);
export type Entitlement = z.infer<typeof Entitlement>;

export const PLAN_ENTITLEMENTS: Record<PlanCode, readonly Entitlement[]> = {
  free: [],
  plus: ['no_ads', 'export', 'premium_voices', 'priority_preparation', 'unlimited_sessions'],
  classroom: [
    'no_ads',
    'rooms',
    'export',
    'premium_voices',
    'priority_preparation',
    'unlimited_sessions',
    'shared_replays',
  ],
};

export const PLAN_LIMITS = {
  free: { sessionsPerDay: 3, maxParticipants: 1 },
  plus: { sessionsPerDay: Number.POSITIVE_INFINITY, maxParticipants: 1 },
  classroom: { sessionsPerDay: Number.POSITIVE_INFINITY, maxParticipants: 12 },
} as const;

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
