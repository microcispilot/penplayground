import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { type SessionRow, sessionLikes, sessionSaves, sessions, sessionVisits } from './schema.js';

export type VisitRole = 'host' | 'guest';

/** A session in someone's history, with how and when they were last in it. */
export interface HistoryEntry {
  session: SessionRow;
  role: VisitRole;
  /** Last time they took a seat, ms epoch. */
  at: number;
}

/** Everything the sidebar and the cards need in one read: membership + counts. */
export interface ListSummary {
  savedIds: string[];
  likedIds: string[];
  counts: { hosted: number; history: number; saved: number; liked: number };
}

/**
 * A participant's lists (ADR-0015): saved ("Learn later"), liked, and history
 * (every session they sat in). Saves and likes are idempotent pairs; likes also
 * move the session's public counter in the same transaction, so the number on
 * a card is always `count(session_likes)`. Adoption on Google sign-in moves a
 * whole anonymous participant's lists onto the account, pair by pair.
 */
export class ListRepository {
  constructor(private readonly db: Database) {}

  // ── saves ────────────────────────────────────────────────────────────────

  /** True when the pair was created (false = it was already saved). */
  async save(participantId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    const rows = await this.db
      .insert(sessionSaves)
      .values({ participantId, sessionId, createdAt: now })
      .onConflictDoNothing()
      .returning();
    return rows.length > 0;
  }

  async unsave(participantId: string, sessionId: string): Promise<boolean> {
    const rows = await this.db
      .delete(sessionSaves)
      .where(
        and(eq(sessionSaves.participantId, participantId), eq(sessionSaves.sessionId, sessionId)),
      )
      .returning();
    return rows.length > 0;
  }

  // ── likes ────────────────────────────────────────────────────────────────

  /** Idempotent; returns the session's like count afterwards. */
  async like(
    participantId: string,
    sessionId: string,
    now = Date.now(),
  ): Promise<{ created: boolean; likes: number }> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(sessionLikes)
        .values({ participantId, sessionId, createdAt: now })
        .onConflictDoNothing()
        .returning();
      const created = inserted.length > 0;
      if (created)
        await tx
          .update(sessions)
          .set({ likes: sql`${sessions.likes} + 1` })
          .where(eq(sessions.id, sessionId));
      const counted = await tx
        .select({ likes: sessions.likes })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return { created, likes: counted[0]?.likes ?? 0 };
    });
  }

  async unlike(
    participantId: string,
    sessionId: string,
  ): Promise<{ removed: boolean; likes: number }> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(sessionLikes)
        .where(
          and(eq(sessionLikes.participantId, participantId), eq(sessionLikes.sessionId, sessionId)),
        )
        .returning();
      const removed = deleted.length > 0;
      if (removed)
        await tx
          .update(sessions)
          .set({ likes: sql`greatest(${sessions.likes} - 1, 0)` })
          .where(eq(sessions.id, sessionId));
      const counted = await tx
        .select({ likes: sessions.likes })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return { removed, likes: counted[0]?.likes ?? 0 };
    });
  }

  // ── history ──────────────────────────────────────────────────────────────

  /** Record a seat taken in a live room; a rejoin only refreshes `lastJoinedAt`. */
  async visit(
    participantId: string,
    sessionId: string,
    role: VisitRole,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .insert(sessionVisits)
      .values({ participantId, sessionId, role, firstJoinedAt: now, lastJoinedAt: now })
      .onConflictDoUpdate({
        target: [sessionVisits.participantId, sessionVisits.sessionId],
        // The host of a session stays its host in history even if a later rejoin is recorded as a guest.
        set: role === 'host' ? { lastJoinedAt: now, role } : { lastJoinedAt: now },
      });
  }

  async historyFor(participantId: string, limit = 200): Promise<HistoryEntry[]> {
    const rows = await this.db
      .select({ session: sessions, role: sessionVisits.role, at: sessionVisits.lastJoinedAt })
      .from(sessionVisits)
      .innerJoin(sessions, eq(sessions.id, sessionVisits.sessionId))
      .where(eq(sessionVisits.participantId, participantId))
      .orderBy(desc(sessionVisits.lastJoinedAt))
      .limit(limit);
    return rows.map((r) => ({ session: r.session, role: r.role, at: r.at }));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Newest save first. */
  async savedFor(participantId: string, limit = 200): Promise<SessionRow[]> {
    const rows = await this.db
      .select({ session: sessions })
      .from(sessionSaves)
      .innerJoin(sessions, eq(sessions.id, sessionSaves.sessionId))
      .where(eq(sessionSaves.participantId, participantId))
      .orderBy(desc(sessionSaves.createdAt))
      .limit(limit);
    return rows.map((r) => r.session);
  }

  async likedFor(participantId: string, limit = 200): Promise<SessionRow[]> {
    const rows = await this.db
      .select({ session: sessions })
      .from(sessionLikes)
      .innerJoin(sessions, eq(sessions.id, sessionLikes.sessionId))
      .where(eq(sessionLikes.participantId, participantId))
      .orderBy(desc(sessionLikes.createdAt))
      .limit(limit);
    return rows.map((r) => r.session);
  }

  async summary(participantId: string): Promise<ListSummary> {
    const [saved, liked, history, hosted] = await Promise.all([
      this.db
        .select({ id: sessionSaves.sessionId })
        .from(sessionSaves)
        .where(eq(sessionSaves.participantId, participantId))
        .orderBy(desc(sessionSaves.createdAt)),
      this.db
        .select({ id: sessionLikes.sessionId })
        .from(sessionLikes)
        .where(eq(sessionLikes.participantId, participantId))
        .orderBy(desc(sessionLikes.createdAt)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sessionVisits)
        .where(eq(sessionVisits.participantId, participantId)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.hostId, participantId)),
    ]);
    return {
      savedIds: saved.map((r) => r.id),
      likedIds: liked.map((r) => r.id),
      counts: {
        hosted: hosted[0]?.n ?? 0,
        history: history[0]?.n ?? 0,
        saved: saved.length,
        liked: liked.length,
      },
    };
  }

  // ── adoption ─────────────────────────────────────────────────────────────

  /**
   * Move an anonymous participant's saves, likes and history onto the account
   * it signed into. Pairs the account already has are dropped (a like counted
   * twice would double the public counter, so those duplicates are uncounted).
   * Returns how many rows moved, per list.
   */
  async adopt(
    fromId: string,
    toId: string,
  ): Promise<{ saved: number; liked: number; history: number }> {
    if (fromId === toId) return { saved: 0, liked: 0, history: 0 };
    return this.db.transaction(async (tx) => {
      // Saves: plain move, duplicates dropped.
      const saves = await tx
        .select()
        .from(sessionSaves)
        .where(eq(sessionSaves.participantId, fromId));
      let saved = 0;
      for (const row of saves) {
        const moved = await tx
          .insert(sessionSaves)
          .values({ ...row, participantId: toId })
          .onConflictDoNothing()
          .returning();
        saved += moved.length;
      }
      await tx.delete(sessionSaves).where(eq(sessionSaves.participantId, fromId));

      // Likes: a duplicate means the account already counted once; the anonymous
      // like is removed and the session's counter comes down with it.
      const likes = await tx
        .select()
        .from(sessionLikes)
        .where(eq(sessionLikes.participantId, fromId));
      let liked = 0;
      const uncounted: string[] = [];
      for (const row of likes) {
        const moved = await tx
          .insert(sessionLikes)
          .values({ ...row, participantId: toId })
          .onConflictDoNothing()
          .returning();
        if (moved.length > 0) liked += 1;
        else uncounted.push(row.sessionId);
      }
      await tx.delete(sessionLikes).where(eq(sessionLikes.participantId, fromId));
      if (uncounted.length > 0)
        await tx
          .update(sessions)
          .set({ likes: sql`greatest(${sessions.likes} - 1, 0)` })
          .where(inArray(sessions.id, uncounted));

      // History: keep the earliest first-join and the latest last-join of the two.
      const visits = await tx
        .select()
        .from(sessionVisits)
        .where(eq(sessionVisits.participantId, fromId));
      let history = 0;
      for (const row of visits) {
        const moved = await tx
          .insert(sessionVisits)
          .values({ ...row, participantId: toId })
          .onConflictDoUpdate({
            target: [sessionVisits.participantId, sessionVisits.sessionId],
            set: {
              firstJoinedAt: sql`least(${sessionVisits.firstJoinedAt}, ${row.firstJoinedAt})`,
              lastJoinedAt: sql`greatest(${sessionVisits.lastJoinedAt}, ${row.lastJoinedAt})`,
              ...(row.role === 'host' ? { role: 'host' as const } : {}),
            },
          })
          .returning();
        history += moved.length;
      }
      await tx.delete(sessionVisits).where(eq(sessionVisits.participantId, fromId));
      return { saved, liked, history };
    });
  }
}
