import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { type AuthChallengeRow, authChallenges } from './schema.js';

/**
 * Storage for the one-time codes that stand between a stranger and an account.
 *
 * Only storage. The code, its HMAC and the decision to accept one live in the
 * API, where the secret is — this layer never sees a code and could not
 * recognise one if it did. That split is why a `SELECT *` here is not a list
 * of ways into the product.
 *
 * The one piece of judgement that *is* here is `claim`, and it is here because
 * it has to be a single statement. See below.
 */
export class AuthChallengeRepository {
  constructor(private readonly db: Database) {}

  async insert(row: {
    id: string;
    purpose: string;
    email: string;
    codeDigest: string;
    expiresAt: Date;
    resendNotBefore: Date;
    sendCount?: number;
  }): Promise<void> {
    await this.db.insert(authChallenges).values(row);
  }

  async get(purpose: string, id: string): Promise<AuthChallengeRow | null> {
    const rows = await this.db
      .select()
      .from(authChallenges)
      .where(and(eq(authChallenges.id, id), eq(authChallenges.purpose, purpose)));
    return rows[0] ?? null;
  }

  /**
   * Mark a challenge used, and say whether *this* call was the one that did it.
   *
   * The guard is the WHERE clause, so the claim is atomic. Two requests racing
   * with the same correct code both reach the UPDATE; exactly one matches
   * `consumed_at IS NULL` and gets a row back, and the other gets nothing. A
   * read-then-write would let both through, and eight digits are cheap enough
   * to guess in parallel that the window is not theoretical.
   *
   * Every other condition is in here too — expiry, the lock, the attempt cap —
   * so a row that went stale between the read and this call cannot be claimed.
   */
  async claim(id: string, at: Date, maxAttempts: number): Promise<string | null> {
    const claimed = await this.db
      .update(authChallenges)
      .set({ consumedAt: at })
      .where(
        and(
          eq(authChallenges.id, id),
          sql`${authChallenges.consumedAt} is null`,
          sql`${authChallenges.lockedAt} is null`,
          gt(authChallenges.expiresAt, at),
          sql`${authChallenges.failedAttempts} < ${maxAttempts}`,
        ),
      )
      .returning();
    return claimed[0]?.email ?? null;
  }

  /**
   * Count a wrong code against the row, locking it on the last one.
   *
   * Counted even when the row was already unusable: probing a locked row must
   * not be free, or an attacker gets an unlimited oracle for "was this the
   * right shape of guess".
   */
  async countFailure(id: string, at: Date, maxAttempts: number): Promise<void> {
    await this.db
      .update(authChallenges)
      .set({
        failedAttempts: sql`${authChallenges.failedAttempts} + 1`,
        lockedAt: sql`case when ${authChallenges.failedAttempts} + 1 >= ${maxAttempts} then ${at} else ${authChallenges.lockedAt} end`,
      })
      .where(eq(authChallenges.id, id));
  }

  async lock(id: string, at: Date): Promise<void> {
    await this.db.update(authChallenges).set({ lockedAt: at }).where(eq(authChallenges.id, id));
  }

  /** How many challenges this address has asked for since a moment — the per-mailbox cap. */
  async countSince(purpose: string, email: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: authChallenges.id })
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.purpose, purpose),
          eq(authChallenges.email, email),
          gt(authChallenges.createdAt, since),
        ),
      );
    return rows.length;
  }

  /** Drop challenges that expired long enough ago to be of no interest. */
  async sweep(before: Date): Promise<number> {
    const gone = await this.db
      .delete(authChallenges)
      .where(lt(authChallenges.expiresAt, before))
      .returning();
    return gone.length;
  }
}
