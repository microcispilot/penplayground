import { Expert } from '@pen/contracts';
import { z } from 'zod';

const Catalog = z.array(Expert);

/** Deep module over the persona catalog: load once, pick by domain, look up by id. */
export class ExpertCatalog {
  private readonly byId = new Map<string, Expert>();
  private constructor(private readonly experts: Expert[]) {
    for (const e of experts) this.byId.set(e.id, e);
  }

  static fromJson(json: unknown): ExpertCatalog {
    return new ExpertCatalog(Catalog.parse(json));
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
   * while different topics in one domain rotate across the roster.
   */
  pickFor(domain: Expert['domain'], seed: string, opts: { allowPremium: boolean }): Expert {
    const pool = this.experts.filter(
      (e) => e.domain === domain && (opts.allowPremium || !e.premium),
    );
    const fallback = this.experts.filter((e) => opts.allowPremium || !e.premium);
    const list = pool.length ? pool : fallback;
    const first = list[0];
    if (!first) throw new Error('EXPERT_CATALOG_EMPTY');
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return list[h % list.length] ?? first;
  }
}
