import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import { type RuntimeConfigAuditRow, runtimeConfigAudits, runtimeConfigState } from './schema.js';

/** The document as it stands, with the token a save has to carry to change it. */
export interface RuntimeConfigSnapshot {
  revision: number;
  settings: Record<string, unknown>;
  updatedAt: number;
  updatedBy: string | null;
}

export interface RuntimeConfigWrite {
  /** The revision the editor was looking at; anything else is a conflict. */
  expectedRevision: number;
  settings: Record<string, unknown>;
  updatedBy: string;
  updatedByName: string;
  reason: string;
  /** The revision this one restores, when it is a rollback. */
  restoredFromRevision?: number;
}

export interface RuntimeConfigHistoryPage {
  entries: RuntimeConfigAuditRow[];
  /** Pass back as `beforeRevision` for the next page; null when this is the last. */
  nextBeforeRevision: number | null;
}

/** The empty document every deployment starts on: no overrides, nobody's doing. */
const EMPTY: RuntimeConfigSnapshot = { revision: 0, settings: {}, updatedAt: 0, updatedBy: null };

/**
 * The runtime configuration document and its history (ADR-0025).
 *
 * Two rules the rest of the system leans on:
 *
 *  - **A save is compare-and-set.** The expected revision is in the UPDATE's
 *    own predicate, not merely checked by a read beforehand, so two editors
 *    saving at once produce one winner and one honest conflict rather than a
 *    silent last-write-wins.
 *  - **History is append-only.** A rollback is a new revision carrying an old
 *    document. Nothing is ever deleted, so "what was this deployment running
 *    on when that session was taught" always has an answer.
 */
export class RuntimeConfigRepository {
  constructor(private readonly db: Database) {}

  /** The document in force. A table that has never been written reads as revision 0. */
  async read(): Promise<RuntimeConfigSnapshot> {
    const rows = await this.db
      .select()
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.id, 1))
      .limit(1);
    const row = rows[0];
    if (!row) return EMPTY;
    return {
      revision: row.revision,
      settings: row.settings ?? {},
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  /**
   * Save a new document, or refuse. `ok: false` carries the revision that is
   * actually in force so the caller can say what it collided with.
   */
  async write(
    write: RuntimeConfigWrite,
    now = Date.now(),
  ): Promise<{ ok: true; snapshot: RuntimeConfigSnapshot } | { ok: false; current: number }> {
    const revision = write.expectedRevision + 1;
    // The singleton is created on first use rather than by the migration, so
    // an existing deployment gets it without a data migration and two racing
    // first writers cannot both create it. Idempotent, and outside the
    // transaction below so a refused save writes nothing at all.
    await this.db
      .insert(runtimeConfigState)
      .values({ id: 1, revision: 0, settings: {}, updatedAt: 0, updatedBy: null })
      .onConflictDoNothing({ target: runtimeConfigState.id });
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(runtimeConfigState)
        .set({ revision, settings: write.settings, updatedAt: now, updatedBy: write.updatedBy })
        .where(
          and(
            eq(runtimeConfigState.id, 1),
            eq(runtimeConfigState.revision, write.expectedRevision),
          ),
        )
        .returning();
      if (!updated[0]) {
        // Nothing was written, so there is nothing to undo: read what is
        // actually in force and let the caller report the collision.
        const current = await tx
          .select({ revision: runtimeConfigState.revision })
          .from(runtimeConfigState)
          .where(eq(runtimeConfigState.id, 1))
          .limit(1);
        return { ok: false as const, current: current[0]?.revision ?? 0 };
      }
      await tx.insert(runtimeConfigAudits).values({
        revision,
        settings: write.settings,
        updatedAt: now,
        updatedBy: write.updatedBy,
        updatedByName: write.updatedByName,
        reason: write.reason,
        restoredFromRevision: write.restoredFromRevision ?? null,
      });
      return {
        ok: true as const,
        snapshot: {
          revision,
          settings: write.settings,
          updatedAt: now,
          updatedBy: write.updatedBy,
        },
      };
    });
  }

  /** One past revision, for a rollback to read the document it restores. */
  async audit(revision: number): Promise<RuntimeConfigAuditRow | null> {
    const rows = await this.db
      .select()
      .from(runtimeConfigAudits)
      .where(eq(runtimeConfigAudits.revision, revision))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Newest first. One row more than `limit` is read, to know whether to offer another page. */
  async history(
    opts: { beforeRevision?: number | null; limit?: number } = {},
  ): Promise<RuntimeConfigHistoryPage> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const before = opts.beforeRevision ?? null;
    const rows = await this.db
      .select()
      .from(runtimeConfigAudits)
      .where(before === null ? undefined : lt(runtimeConfigAudits.revision, before))
      .orderBy(desc(runtimeConfigAudits.revision))
      .limit(limit + 1);
    const entries = rows.slice(0, limit);
    return {
      entries,
      nextBeforeRevision:
        rows.length > limit ? (entries[entries.length - 1]?.revision ?? null) : null,
    };
  }
}
