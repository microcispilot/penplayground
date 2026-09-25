import { and, desc, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
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

  /**
   * Every account with this email address.
   *
   * A list, not a row, and that is the point: nothing here enforces one
   * account per address. Google's flow keys on `googleSub`, and an address can
   * legitimately appear on more than one row. A caller that needs *the*
   * account has to decide what to do about two, rather than be handed the
   * first one silently.
   */
  async findByEmail(email: string): Promise<ParticipantRow[]> {
    return this.db.select().from(participants).where(eq(participants.email, email));
  }

  /**
   * Accounts that have an email, most recently seen first — enough to find one
   * by eye from an operator script. Anonymous rows are excluded: there are
   * orders of magnitude more of them and none of them is who you are looking
   * for.
   */
  async recentAccounts(limit = 40): Promise<ParticipantRow[]> {
    return this.db
      .select()
      .from(participants)
      .where(isNotNull(participants.email))
      .orderBy(desc(participants.lastSeenAt))
      .limit(limit);
  }

  /** The expert who sits in the search box for this learner (ADR-0040); null clears it. */
  async setDefaultExpert(id: string, expertId: string | null): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ defaultExpertId: expertId })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /** One more topic prepared for this learner (ADR-0040); returns the row with the new count. */
  async countCustomSession(id: string): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ customSessions: sql`${participants.customSessions} + 1` })
      .where(eq(participants.id, id))
      .returning();
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

  /**
   * Turn an existing row into a password account, keeping its id.
   *
   * An anonymous learner who signs up keeps everything they already started —
   * that is the whole reason this is an UPDATE and not an INSERT. Their
   * sessions are keyed to this id, and creating a second row would silently
   * orphan them.
   *
   * `emailVerifiedAt` is set here rather than left for later because
   * registration *is* the proof: the row only reaches this method once a code
   * sent to that mailbox came back.
   */
  async attachPassword(
    id: string,
    account: { email: string; name: string; passwordHash: string; verifiedAt: Date },
  ): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({
        email: account.email,
        name: account.name,
        passwordHash: account.passwordHash,
        emailVerifiedAt: account.verifiedAt,
        provider: 'password',
        anonymous: false,
        lastSeenAt: new Date(),
      })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Replace the password on an account.
   *
   * Also stamps `emailVerifiedAt`: completing a reset proves the mailbox just
   * as registration does, and an account that arrived through Google and then
   * set a password by reset has genuinely proved it twice.
   */
  async setPassword(id: string, passwordHash: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(participants)
      .set({ passwordHash, emailVerifiedAt: at, lastSeenAt: new Date() })
      .where(eq(participants.id, id))
      .returning();
    return rows.length > 0;
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
   * The learner's teaching pace (ADR-0010), kept on the account so their next
   * session starts where the last one left off. Clamped by the caller;
   * returns the updated row.
   */
  async setPace(id: string, pace: number): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ pace, lastSeenAt: new Date() })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The board this learner chose (ADR-0034), kept on the account so the choice
   * survives a new machine. The device's own copy stays authoritative; this is
   * the same courtesy `setPace` is.
   *
   * Stored as given and validated on the way out rather than in: a row written
   * by a newer build, naming a board this one has never heard of, has to
   * degrade to the default instead of failing a sign-in.
   */
  async setCheckIns(id: string, checkIns: boolean): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ checkIns, lastSeenAt: new Date() })
      .where(eq(participants.id, id))
      .returning();
    return rows[0] ?? null;
  }

  async setBoard(id: string, board: unknown): Promise<ParticipantRow | null> {
    const rows = await this.db
      .update(participants)
      .set({ board, lastSeenAt: new Date() })
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
    /**
     * What Stripe's price and subscription say beyond the plan code. `plan`
     * alone cannot tell a monthly subscriber from a yearly one, and that split
     * is most of what the owner's subscription statistics are (ADR-0027).
     * Omitted fields are left as they were, so a webhook that does not carry
     * an interval never erases one that did.
     */
    billing?: {
      interval?: 'month' | 'year' | null;
      status?: string | null;
      /**
       * When the change happened at Stripe — `event.created`, not now.
       *
       * It is also the **ordering guard**. Webhooks are at-least-once and in
       * no particular order: Stripe retries a failed delivery for days, so a
       * `customer.subscription.updated` can land minutes after the
       * `customer.subscription.deleted` that superseded it. This used to be
       * an unconditional UPDATE, which meant that retry restored a cancelled
       * subscriber's entitlements — and nothing would ever correct it,
       * because the row looks like a perfectly ordinary paying customer.
       *
       * So a write only applies when it is strictly newer than the one on
       * the row — with one deliberate exception. Stripe's `created` is in
       * whole seconds, and two events inside one second are simultaneous as
       * far as anything here can tell, so a tie is decided by which mistake
       * is recoverable: **a cancellation wins a tie.** Refusing one would
       * leave a cancelled subscriber entitled for ever, because no further
       * event is coming; refusing an upgrade costs the subscriber minutes
       * until the next event, and Stripe sends plenty.
       *
       * Omitted, the write is unconditional — which is right for the places
       * that are not a webhook (a test, a manual grant).
       */
      since?: Date;
    },
  ): Promise<boolean> {
    const applied = await this.db
      .update(participants)
      .set({
        plan,
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
        ...(billing?.interval !== undefined ? { planInterval: billing.interval } : {}),
        ...(billing?.status !== undefined ? { planStatus: billing.status } : {}),
        ...(billing?.since !== undefined ? { planSince: billing.since } : {}),
      })
      .where(
        billing?.since === undefined
          ? eq(participants.id, id)
          : and(
              eq(participants.id, id),
              or(
                isNull(participants.planSince),
                plan === 'free'
                  ? lte(participants.planSince, billing.since)
                  : lt(participants.planSince, billing.since),
              ),
            ),
      )
      .returning();
    return applied.length > 0;
  }

  /** Everyone who has turned analytics off: the visit ingest checks this set. */
  async optedOutIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.analyticsOptOut, true));
    return rows.map((r) => r.id);
  }
}
