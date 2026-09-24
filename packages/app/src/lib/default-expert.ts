import type { Expert, PlanCode } from '@pen/contracts';
import { planIncludes } from '@pen/contracts';

/**
 * Who sits in the search box before the learner has said anything (ADR-0040).
 *
 * The box always has an expert in it: a lesson is taught by someone, and the
 * owner wanted that someone visible from the first second rather than found
 * on the Experts page. Which one:
 *
 *   - a paying learner's own default, when they have chosen one and their
 *     plan still includes them;
 *   - otherwise one of the experts their plan includes, at random — for the
 *     free plan that is one of its two — chosen **once per visit**. The pick
 *     is kept here, in the module, so walking to Pricing and back does not
 *     re-roll it, and a reload does: "every time they come to the platform".
 *
 * Removing the chip is allowed and means "whoever you like": the server picks
 * from the same set when no expert is named.
 */
let visitPick: { plan: string; expertId: string } | null = null;

export function defaultExpertFor(
  experts: readonly Expert[],
  who: { plan: PlanCode; defaultExpertId?: string | null },
  random: () => number = Math.random,
): Expert | null {
  const allowed = experts.filter((e) => planIncludes(who.plan, e.requiredPlan));
  if (allowed.length === 0) return null;
  const chosen = who.defaultExpertId
    ? allowed.find((e) => e.id === who.defaultExpertId)
    : undefined;
  if (chosen) return chosen;
  if (visitPick && visitPick.plan === who.plan) {
    const kept = allowed.find((e) => e.id === visitPick?.expertId);
    if (kept) return kept;
  }
  const pick = allowed[Math.floor(random() * allowed.length)] ?? allowed[0] ?? null;
  if (pick) visitPick = { plan: who.plan, expertId: pick.id };
  return pick;
}

/** Tests: forget the visit's pick. */
export function resetDefaultExpertForTests(): void {
  visitPick = null;
}
