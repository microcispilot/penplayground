import type { PlanCode } from './billing.js';

/**
 * Plan-tier access to the legend experts — the single source of truth.
 *
 * The modern professional experts are included with every plan, free onward.
 * The ten historical recreations are a subscription benefit and tier up:
 *
 *   - Standard unlocks six of them;
 *   - Professional includes all ten.
 *
 * The map is keyed by expert id, which is the stable public identity of a
 * persona across catalog revisions. Everything reads from here: the catalog
 * stamps `requiredPlan` onto every expert it serves, the API refuses a session
 * whose expert the host's plan does not include, and the clients draw the lock
 * chip and its route to Pricing from the served value — never from a rule of
 * their own. Adding or re-tiering an expert is a one-line change in this file.
 */

/** Plans in order of what they include; a higher rank includes everything below it. */
export const PLAN_RANK: Record<PlanCode, number> = {
  free: 0,
  standard: 1,
  professional: 2,
};

/** What a plan is called in a sentence ("Included with Standard"). */
export const PLAN_NAME: Record<PlanCode, string> = {
  free: 'Free',
  standard: 'Standard',
  professional: 'Professional',
};

/**
 * Expert id → the plan that includes them. Any id not listed is included with
 * every plan. The four at the top are the marquee names, so they sit on the
 * higher tier; the six on Standard are the ones a learner is most likely to
 * ask for first.
 */
export const LEGEND_MIN_PLAN: Record<string, PlanCode> = {
  socrates: 'standard',
  confucius: 'standard',
  aristotle: 'standard',
  hypatia: 'standard',
  'ada-lovelace': 'standard',
  'sun-tzu': 'standard',
  'william-shakespeare': 'professional',
  'leonardo-da-vinci': 'professional',
  'isaac-newton': 'professional',
  'charles-darwin': 'professional',
};

/** How many legends each plan includes; Pricing says these numbers out loud. */
export const LEGENDS_BY_PLAN: Record<PlanCode, number> = {
  free: 0,
  standard: Object.values(LEGEND_MIN_PLAN).filter((p) => PLAN_RANK[p] <= PLAN_RANK.standard).length,
  professional: Object.keys(LEGEND_MIN_PLAN).length,
};

/**
 * The plan an expert needs, or null when every plan includes them. This is
 * what the API stamps on an expert and what a client renders; a client never
 * consults `LEGEND_MIN_PLAN` itself.
 */
export function requiredPlanFor(expertId: string): PlanCode | null {
  return LEGEND_MIN_PLAN[expertId] ?? null;
}

/** Whether a plan may teach with an expert. The server's answer is the only one that counts. */
export function planAllowsExpert(plan: PlanCode, expertId: string): boolean {
  const needed = requiredPlanFor(expertId);
  return needed === null || PLAN_RANK[plan] >= PLAN_RANK[needed];
}

/** Whether a plan includes an expert the server already stamped. */
export function planIncludes(plan: PlanCode, requiredPlan: PlanCode | null): boolean {
  return requiredPlan === null || PLAN_RANK[plan] >= PLAN_RANK[requiredPlan];
}
