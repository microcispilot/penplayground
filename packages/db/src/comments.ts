import { and, asc, count, desc, eq, isNull, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import { participants, type SessionCommentRow, sessionComments } from './schema.js';

/** A comment as the page shows it: the row, with its author read at listing time. */
export interface CommentView {
  id: string;
  sessionId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: number;
}

/**
 * Comments under a saved session (ADR-0044).
 *
 * Newest first, the way a thread under a video reads; a page is cut by
 * `before` (a created-at, exclusive) rather than by offset so a comment
 * posted while someone scrolls never shifts the page under them. A deletion
 * is soft — the row keeps `deleted_at` — so the count a reader saw a moment
 * ago and the count after are the same arithmetic, and an abuse report can
 * still be answered. Deleted rows are never listed and never counted.
 */
export class CommentRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    id: string;
    sessionId: string;
    authorId: string;
    body: string;
    now?: number;
  }): Promise<CommentView | null> {
    await this.db.insert(sessionComments).values({
      id: input.id,
      sessionId: input.sessionId,
      authorId: input.authorId,
      body: input.body,
      createdAt: input.now ?? Date.now(),
      deletedAt: null,
    });
    return this.get(input.id);
  }

  /** One live comment with its author, or null when it does not exist or was deleted. */
  async get(id: string): Promise<CommentView | null> {
    const rows = await this.db
      .select(this.view())
      .from(sessionComments)
      .innerJoin(participants, eq(participants.id, sessionComments.authorId))
      .where(and(eq(sessionComments.id, id), isNull(sessionComments.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The row itself, deleted or not: what a deletion checks ownership against. */
  async row(id: string): Promise<SessionCommentRow | null> {
    const rows = await this.db
      .select()
      .from(sessionComments)
      .where(eq(sessionComments.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    sessionId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<{ comments: CommentView[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const where = and(
      eq(sessionComments.sessionId, sessionId),
      isNull(sessionComments.deletedAt),
      ...(opts.before !== undefined ? [lt(sessionComments.createdAt, opts.before)] : []),
    );
    const [comments, [totalRow]] = await Promise.all([
      this.db
        .select(this.view())
        .from(sessionComments)
        .innerJoin(participants, eq(participants.id, sessionComments.authorId))
        .where(where)
        .orderBy(desc(sessionComments.createdAt), asc(sessionComments.id))
        .limit(limit),
      this.db
        .select({ n: count() })
        .from(sessionComments)
        .where(and(eq(sessionComments.sessionId, sessionId), isNull(sessionComments.deletedAt))),
    ]);
    return { comments, total: Number(totalRow?.n ?? 0) };
  }

  async count(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(sessionComments)
      .where(and(eq(sessionComments.sessionId, sessionId), isNull(sessionComments.deletedAt)));
    return Number(row?.n ?? 0);
  }

  /** Soft-delete. True when a live comment was deleted by this call. */
  async remove(id: string, now = Date.now()): Promise<boolean> {
    const rows = await this.db
      .update(sessionComments)
      .set({ deletedAt: now })
      .where(and(eq(sessionComments.id, id), isNull(sessionComments.deletedAt)))
      .returning();
    return rows.length > 0;
  }

  /** When the session itself is erased, its thread goes with it — rows and all. */
  async forgetSession(sessionId: string): Promise<number> {
    const rows = await this.db
      .delete(sessionComments)
      .where(eq(sessionComments.sessionId, sessionId))
      .returning();
    return rows.length;
  }

  private view() {
    return {
      id: sessionComments.id,
      sessionId: sessionComments.sessionId,
      authorId: sessionComments.authorId,
      authorName: participants.name,
      authorAvatarUrl: participants.avatarUrl,
      body: sessionComments.body,
      createdAt: sessionComments.createdAt,
    };
  }
}
