import type { FeedbackEntry, FeedbackKind, FeedbackStatus } from '@pen/contracts';
import { and, count, desc, eq, gte } from 'drizzle-orm';
import type { Database } from './client.js';
import { feedback, participants } from './schema.js';

/**
 * Feedback, suggestions, feature requests and contact (ADR-0060), at the table.
 *
 * Newest first, paged by offset (an inbox is read from the top and its rows
 * do not move under the reader the way a public thread does). The author's
 * name and plan are read from `participants` at listing time, never copied.
 */
export class FeedbackRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    kind: FeedbackKind;
    message: string;
    email: string | null;
    name: string | null;
    participantId: string | null;
    screen: string | null;
    platform: string | null;
    release: string | null;
    environment: string | null;
    now?: number;
  }): Promise<FeedbackEntry | null> {
    const now = input.now ?? Date.now();
    await this.db.insert(feedback).values({
      id: input.id,
      kind: input.kind,
      status: 'new',
      message: input.message,
      email: input.email,
      name: input.name,
      participantId: input.participantId,
      screen: input.screen,
      platform: input.platform,
      release: input.release,
      environment: input.environment,
      adminNote: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(input.id);
  }

  async get(id: string): Promise<FeedbackEntry | null> {
    const rows = await this.db
      .select(this.view())
      .from(feedback)
      .leftJoin(participants, eq(participants.id, feedback.participantId))
      .where(eq(feedback.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    q: { status?: FeedbackStatus; kind?: FeedbackKind; limit?: number; offset?: number } = {},
  ): Promise<{ rows: FeedbackEntry[]; total: number; counts: Record<FeedbackStatus, number> }> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const where = and(
      ...(q.status ? [eq(feedback.status, q.status)] : []),
      ...(q.kind ? [eq(feedback.kind, q.kind)] : []),
    );
    const [rows, [totalRow], byStatus] = await Promise.all([
      this.db
        .select(this.view())
        .from(feedback)
        .leftJoin(participants, eq(participants.id, feedback.participantId))
        .where(where)
        .orderBy(desc(feedback.createdAt), desc(feedback.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ n: count() }).from(feedback).where(where),
      this.db
        .select({ status: feedback.status, n: count() })
        .from(feedback)
        .groupBy(feedback.status),
    ]);
    const counts: Record<FeedbackStatus, number> = { new: 0, seen: 0, resolved: 0 };
    for (const r of byStatus) counts[r.status] = Number(r.n);
    return { rows, total: Number(totalRow?.n ?? 0), counts };
  }

  /** A status change or a note from the console; `updated_at` moves with it. */
  async update(
    id: string,
    patch: { status?: FeedbackStatus; adminNote?: string | null },
    now = Date.now(),
  ): Promise<FeedbackEntry | null> {
    await this.db
      .update(feedback)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.adminNote !== undefined ? { adminNote: patch.adminNote } : {}),
        updatedAt: now,
      })
      .where(eq(feedback.id, id));
    return this.get(id);
  }

  /** How many this participant sent since `since`: the daily allowance is counted here, not in memory. */
  async countSince(participantId: string, since: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(feedback)
      .where(and(eq(feedback.participantId, participantId), gte(feedback.createdAt, since)));
    return Number(row?.n ?? 0);
  }

  async forParticipant(participantId: string): Promise<FeedbackEntry[]> {
    return this.db
      .select(this.view())
      .from(feedback)
      .leftJoin(participants, eq(participants.id, feedback.participantId))
      .where(eq(feedback.participantId, participantId))
      .orderBy(desc(feedback.createdAt))
      .limit(100);
  }

  /** The person is gone (DELETE /api/me): the words stay, nothing personal does. */
  async anonymise(participantId: string, now = Date.now()): Promise<void> {
    await this.db
      .update(feedback)
      .set({ participantId: null, email: null, name: null, updatedAt: now })
      .where(eq(feedback.participantId, participantId));
  }

  private view() {
    return {
      id: feedback.id,
      kind: feedback.kind,
      status: feedback.status,
      message: feedback.message,
      email: feedback.email,
      name: feedback.name,
      participantId: feedback.participantId,
      participantName: participants.name,
      participantPlan: participants.plan,
      participantAnonymous: participants.anonymous,
      screen: feedback.screen,
      platform: feedback.platform,
      release: feedback.release,
      environment: feedback.environment,
      adminNote: feedback.adminNote,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
    };
  }
}
