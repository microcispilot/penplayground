import type { PlanCode } from '@pen/contracts';
import { Expert, planAllowsExpert, requiredPlanFor } from '@pen/contracts';
import { z } from 'zod';

const Catalog = z.array(Expert);

/** Deep module over the persona catalog: load once, pick by domain, look up by id. */
export class ExpertCatalog {
  private readonly byId = new Map<string, Expert>();
  private constructor(private readonly experts: Expert[]) {
    for (const e of experts) this.byId.set(e.id, e);
  }

  /**
   * Parse the catalog and stamp each persona with the plan that includes them
   * (`expert-access.ts`). The files on disk never carry it, so re-tiering an
   * expert is a one-line change there and nothing else in the product — or in
   * the data — has an opinion about who is paid for.
   */
  static fromJson(json: unknown): ExpertCatalog {
    return new ExpertCatalog(
      Catalog.parse(json).map((e) => ({ ...e, requiredPlan: requiredPlanFor(e.id) })),
    );
  }

  all(): readonly Expert[] {
    return this.experts;
  }

  get(id: string): Expert | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Pick a teacher for a domain. Deterministic for a given topic so the same
   * topic always has the same face (learners remember "Ada taught me this"),
   * while different topics in one domain rotate across the roster. Only
   * personas the plan includes are in the pool.
   */
  pickFor(domain: Expert['domain'], seed: string, opts: { plan: PlanCode }): Expert {
    const allowed = (e: Expert) => planAllowsExpert(opts.plan, e.id);
    const pool = this.experts.filter((e) => e.domain === domain && allowed(e));
    const fallback = this.experts.filter(allowed);
    const list = pool.length ? pool : fallback;
    const first = list[0];
    if (!first) throw new Error('EXPERT_CATALOG_EMPTY');
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return list[h % list.length] ?? first;
  }
}
