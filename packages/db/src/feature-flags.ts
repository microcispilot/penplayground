import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import { type FeatureFlagsAuditRow, featureFlagsAudits, featureFlagsState } from './schema.js';

/** The document as it stands, with the token a save has to carry to change it. */
export interface FeatureFlagsSnapshot {
  revision: number;
  rules: Record<string, unknown>;
  updatedAt: number;
  updatedBy: string | null;
}

export interface FeatureFlagsWrite {
  /** The revision the editor was looking at; anything else is a conflict. */
  expectedRevision: number;
  rules: Record<string, unknown>;
  updatedBy: string;
  updatedByName: string;
  reason: string;
  /** The revision this one restores, when it is a rollback. */
  restoredFromRevision?: number;
}

export interface FeatureFlagsHistoryPage {
  entries: FeatureFlagsAuditRow[];
  nextBeforeRevision: number | null;
}

const EMPTY: FeatureFlagsSnapshot = { revision: 0, rules: {}, updatedAt: 0, updatedBy: null };

/**
 * The feature-flag document and its history (ADR-0036). The same two rules
 * as `RuntimeConfigRepository`, for the same reasons: a save is a
 * compare-and-set with the expected revision in the UPDATE's own predicate,
 * and the history only ever grows — a rollback is a new revision carrying an
 * old document.
 *
 * Deliberately a sibling and not a generalisation of the runtime-config
 * repository: two table pairs, each named for what it holds, read better in
 * a migration and in an incident than one generic "documents" table with a
 * `kind` column would, and there are two of them, not twenty.
 */
export class FeatureFlagsRepository {
  constructor(private readonly db: Database) {}

  async read(): Promise<FeatureFlagsSnapshot> {
    const rows = await this.db
      .select()
      .from(featureFlagsState)
      .where(eq(featureFlagsState.id, 1))
      .limit(1);
    const row = rows[0];
    if (!row) return EMPTY;
    return {
      revision: row.revision,
      rules: row.rules ?? {},
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async write(
    write: FeatureFlagsWrite,
    now = Date.now(),
  ): Promise<{ ok: true; snapshot: FeatureFlagsSnapshot } | { ok: false; current: number }> {
    const revision = write.expectedRevision + 1;
    await this.db
      .insert(featureFlagsState)
      .values({ id: 1, revision: 0, rules: {}, updatedAt: 0, updatedBy: null })
      .onConflictDoNothing({ target: featureFlagsState.id });
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(featureFlagsState)
        .set({ revision, rules: write.rules, updatedAt: now, updatedBy: write.updatedBy })
        .where(
          and(eq(featureFlagsState.id, 1), eq(featureFlagsState.revision, write.expectedRevision)),
        )
        .returning();
      if (!updated[0]) {
        const current = await tx
          .select({ revision: featureFlagsState.revision })
          .from(featureFlagsState)
          .where(eq(featureFlagsState.id, 1))
          .limit(1);
        return { ok: false as const, current: current[0]?.revision ?? 0 };
      }
      await tx.insert(featureFlagsAudits).values({
        revision,
        rules: write.rules,
        updatedAt: now,
        updatedBy: write.updatedBy,
        updatedByName: write.updatedByName,
        reason: write.reason,
        restoredFromRevision: write.restoredFromRevision ?? null,
      });
      return {
        ok: true as const,
        snapshot: { revision, rules: write.rules, updatedAt: now, updatedBy: write.updatedBy },
      };
    });
  }

  async audit(revision: number): Promise<FeatureFlagsAuditRow | null> {
    const rows = await this.db
      .select()
      .from(featureFlagsAudits)
      .where(eq(featureFlagsAudits.revision, revision))
      .limit(1);
    return rows[0] ?? null;
  }

  async history(
    opts: { beforeRevision?: number | null; limit?: number } = {},
  ): Promise<FeatureFlagsHistoryPage> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const before = opts.beforeRevision ?? null;
    const rows = await this.db
      .select()
      .from(featureFlagsAudits)
      .where(before === null ? undefined : lt(featureFlagsAudits.revision, before))
      .orderBy(desc(featureFlagsAudits.revision))
      .limit(limit + 1);
    const entries = rows.slice(0, limit);
    return {
      entries,
      nextBeforeRevision:
        rows.length > limit ? (entries[entries.length - 1]?.revision ?? null) : null,
    };
  }
}
