import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { type ParticipantRow, participants } from './schema.js';

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
