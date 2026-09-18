import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { type ParticipantRow, participants, sessions } from './schema.js';

/** What a Google sign-in contributes to a participant row. */
export interface GoogleLink {
  googleSub: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
}

export class ParticipantRepository {
  constructor(private readonly db: Database) {}

  async ensure(p: {
    id: string;
    name: string;
    plan: ParticipantRow['plan'];
    anonymous: boolean;
  }): Promise<ParticipantRow> {
    const rows = await this.db
      .insert(participants)
      .values({ id: p.id, name: p.name, plan: p.plan, anonymous: p.anonymous })
      .onConflictDoUpdate({
        target: participants.id,
        set: { name: p.name, lastSeenAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('participant upsert returned no row');
    return row;
  }

  async get(id: string): Promise<ParticipantRow | null> {
    const rows = await this.db.select().from(participants).where(eq(participants.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByGoogleSub(googleSub: string): Promise<ParticipantRow | null> {
    const rows = await this.db
      .select()
      .from(participants)
      .where(eq(participants.googleSub, googleSub))
      .limit(1);
    return rows[0] ?? null;
  }

  async rename(id: string, name: string): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ name, lastSeenAt: new Date() })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Attach a Google account to an existing row (an anonymous participant
   * signing in keeps its id, so its sessions stay its own) or refresh the
   * profile of a row that already carries this account.
   */
  async linkGoogle(id: string, link: GoogleLink): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({
        googleSub: link.googleSub,
        email: link.email,
        name: link.name,
        avatarUrl: link.avatarUrl,
        provider: 'google',
        anonymous: false,
        lastSeenAt: new Date(),
      })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /** A brand-new account for a Google identity nobody here has used before. */
  async createGoogle(
    id: string,
    plan: ParticipantRow['plan'],
    link: GoogleLink,
  ): Promise<ParticipantRow> {
    const rows = await this.db
      .insert(participants)
      .values({
        id,
        name: link.name,
        plan,
        anonymous: false,
        email: link.email,
        provider: 'google',
        googleSub: link.googleSub,
        avatarUrl: link.avatarUrl,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('participant insert returned no row');
    return row;
  }

  /**
   * Move every session an anonymous participant hosted onto the account it
   * signed into (when that Google account already had a row of its own).
   * Returns how many sessions moved.
   */
  async adoptSessions(fromId: string, toId: string, toName: string): Promise<number> {
    if (fromId === toId) return 0;
    const rows = await this.db
      .update(sessions)
      .set({ hostId: toId, hostName: toName })
      .where(eq(sessions.hostId, fromId))
      .returning();
    return rows.length;
  }

  /** The learner's analytics choice (Privacy choices); returns the updated row. */
  async setAnalyticsOptOut(id: string, optOut: boolean): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ analyticsOptOut: optOut, lastSeenAt: new Date() })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Erase the participant. Their sessions are removed separately (the caller
   * also has on-disk ledgers, audio, exports and thumbnails to clear), so this
   * is the last step, after which the bearer identifies nobody.
   */
  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(participants).where(eq(participants.id, id)).returning();
    return rows.length > 0;
  }

  async setPlan(
    id: string,
    plan: ParticipantRow['plan'],
    stripeCustomerId?: string,
  ): Promise<void> {
    await this.db
      .update(participants)
      .set({ plan, ...(stripeCustomerId ? { stripeCustomerId } : {}) })
      .where(eq(participants.id, id));
  }
}
