import { utcDayStart } from '@pen/contracts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { type SessionRow, sessions } from './schema.js';

export type SessionRecord = SessionRow;

/** The session index behind Home, My sessions and share pages. */
export class SessionRepository {
  constructor(private readonly db: Database) {}

  async upsert(record: SessionRecord): Promise<void> {
    await this.db
      .insert(sessions)
      .values(record)
      .onConflictDoUpdate({ target: sessions.id, set: record });
  }

  async patch(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const rows = await this.db.update(sessions).set(patch).where(eq(sessions.id, id)).returning();
    return rows[0] ?? null;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async recordView(id: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ views: sql`${sessions.views} + 1` })
      .where(eq(sessions.id, id));
  }

  async listPublic(limit = 48): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.visibility, 'public'), isNotNull(sessions.endedAt)))
      .orderBy(desc(sessions.views), desc(sessions.startedAt))
      .limit(limit);
  }

  async listForHost(hostId: string): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.hostId, hostId))
      .orderBy(desc(sessions.startedAt));
  }

  /**
   * Sessions this host started since `since` (ms epoch). The daily quota passes
   * the current UTC midnight, so "3 a day" resets at one moment everyone can
   * predict rather than drifting with each learner's last session.
   */
  async countSince(hostId: string, since: number): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.hostId, hostId), sql`${sessions.startedAt} >= ${since}`));
    return rows[0]?.n ?? 0;
  }

  async countToday(hostId: string, now = Date.now()): Promise<number> {
    return this.countSince(hostId, utcDayStart(now));
  }

  /** Remove one session from the index. On-disk artefacts are the caller's to clear. */
  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(sessions).where(eq(sessions.id, id)).returning();
    return rows.length > 0;
  }

  /** Every session this participant hosts, ids only — what an account deletion has to clear. */
  async idsForHost(hostId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.hostId, hostId));
    return rows.map((r) => r.id);
  }
}
