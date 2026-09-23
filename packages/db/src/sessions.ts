import { utcDayStart } from '@pen/contracts';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  like,
  notExists,
  sql,
} from 'drizzle-orm';
import type { Database } from './client.js';
import {
  participants,
  type SessionRedirectRow,
  type SessionRow,
  sessionRedirects,
  sessionSaves,
  sessions,
  sessionVisits,
} from './schema.js';

export type SessionRecord = SessionRow;

/**
 * The scope a lesson is memoised under — `canonicalId|band|expertId|language`,
 * spelled exactly as `scopeKeyFor` spells it in the statistics deriver.
 *
 * Two public sessions sharing this string were taught from the *same* lesson
 * memo, the same card copy and the same picture: they are one lesson told
 * twice, and the catalogue shows it once (ADR-0031). Null when the session
 * never resolved to a canonical topic — then there is no evidence it is the
 * same lesson as anything, and it is never grouped.
 */
const scopeKey = sql`${sessions.canonicalId} || '|' || ${sessions.band} || '|' || ${sessions.expertId} || '|' || ${sessions.language}`;

/** The scope when there is one, else the session's own id: an ungrouped row is its own group. */
const groupKey = sql`coalesce(${scopeKey}, ${sessions.id})`;

/** One session in a lesson's group, with everything the survivor rule reads. */
export interface DuplicateMember {
  id: string;
  title: string;
  hostId: string;
  /** True when the host is a signed-in account rather than an anonymous device. */
  hostIsAccount: boolean;
  /** How many recap points the telling produced; 0 means it never reached the end. */
  recapPoints: number;
  durationMs: number;
  /** The plan's length. Reported, never ranked on — see `rankTellings`. */
  segments: number;
  views: number;
  likes: number;
  saves: number;
  startedAt: number;
}

/** A lesson taught more than once in public, best first. */
export interface DuplicateGroup {
  scopeKey: string;
  /** The one to keep: most complete, then most engaged, then oldest. */
  keep: DuplicateMember;
  /** Every other telling of the same lesson, in the order the rule ranked them. */
  drop: DuplicateMember[];
}

/**
 * The survivor rule, in one place and in words. Best first:
 *
 * 1. **How much of the lesson it actually got through** — recap points, then
 *    how long it ran. A recap is written as the lesson closes, so a telling
 *    with none never reached the end, and one with more got further.
 * 2. **How engaged anyone was** — views + likes + saves, counted the same way
 *    whoever did them.
 * 3. **The oldest**, because its link is the one most likely already shared.
 * 4. **By id**, so two identical tellings rank the same way twice.
 *
 * `sessions.segments` is deliberately *not* in this list, obvious as it looks.
 * It is the length of the lesson *plan* (`state.plan.segments.length`), not
 * the number taught: every telling of one memoised lesson carries the same
 * number, so it separates nothing and would only hide the criteria that do.
 * `session_stats.segments_reached` is the real count, and it lives in the
 * derived statistics, which a session need not have.
 *
 * `listPublic` spells this same rule in SQL, where it has to run inside the
 * query; the test `duplicates-and-catalogue-agree` pins the two together.
 */
export function rankTellings<T extends DuplicateMember>(members: readonly T[]): T[] {
  const engagement = (m: DuplicateMember) => m.views + m.likes + m.saves;
  return [...members].sort(
    (a, b) =>
      b.recapPoints - a.recapPoints ||
      b.durationMs - a.durationMs ||
      engagement(b) - engagement(a) ||
      a.startedAt - b.startedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

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

  /**
   * The public catalogue: **one card per lesson**, not one per session
   * (ADR-0031).
   *
   * A lesson taught to ten learners is ten session rows — each with its own
   * recording, its own history entry and its own share link — but it is one
   * thing to learn, and ten identical cards is a worse catalogue, not a
   * fuller one. Rows are collapsed on the lesson scope they were memoised
   * under and the best telling represents the group, by `rankTellings`: how
   * far it got, then how engaged anyone was, then the oldest. A session with
   * no canonical topic is its own group — nothing proves it is the same
   * lesson as anything else.
   *
   * `listForHost` is deliberately *not* collapsed: "My sessions" is a list of
   * what this person did, and two of their own tellings are two of their own
   * tellings.
   */
  /**
   * How many guests took a seat in each session: what makes a session a
   * *room*. Read where a record is served, never stored on the row, so it
   * cannot drift from the visits it is counted from.
   */
  async guestCounts(ids: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;
    const rows = await this.db
      .select({ sessionId: sessionVisits.sessionId, n: sql<number>`count(*)::int` })
      .from(sessionVisits)
      .where(and(inArray(sessionVisits.sessionId, [...ids]), eq(sessionVisits.role, 'guest')))
      .groupBy(sessionVisits.sessionId);
    for (const r of rows) counts.set(r.sessionId, r.n);
    return counts;
  }

  async listPublic(limit = 48): Promise<SessionRecord[]> {
    const recapPoints = sql`jsonb_array_length(${sessions.recap})`;
    const saveCounts = this.db
      .select({
        sessionId: sessionSaves.sessionId,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(sessionSaves)
      .groupBy(sessionSaves.sessionId)
      .as('save_counts');
    const engagement = sql`${sessions.views} + ${sessions.likes} + coalesce(${saveCounts.n}, 0)`;
    // `rankTellings`, in SQL. Keep the two in step; the agreement test is what
    // catches it when they are not.
    const best = this.db
      .selectDistinctOn([groupKey], getTableColumns(sessions))
      .from(sessions)
      .leftJoin(saveCounts, eq(saveCounts.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.visibility, 'public'),
          isNotNull(sessions.endedAt),
          // A room — a session somebody joined as a guest — is its host's
          // recording, not a lesson for the catalogue (ADR-0035): replay is
          // for solo sessions, and the room's lesson is reused by the memo
          // the moment anyone asks for the topic.
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(sessionVisits)
              .where(
                and(eq(sessionVisits.sessionId, sessions.id), eq(sessionVisits.role, 'guest')),
              ),
          ),
        ),
      )
      .orderBy(
        groupKey,
        desc(recapPoints),
        desc(sessions.durationMs),
        desc(engagement),
        asc(sessions.startedAt),
        asc(sessions.id),
      )
      .as('best');
    return this.db.select().from(best).orderBy(desc(best.views), desc(best.startedAt)).limit(limit);
  }

  /**
   * Every lesson taught more than once in public, and which telling of each
   * would be kept — what `sessions:dedupe` reports and then acts on. Read
   * only: this decides nothing on its own.
   *
   * Only ended, public sessions with a canonical topic are considered. A live
   * room is still being taught, a private session is not in anyone's
   * catalogue, and a session with no canonical topic has no scope to share.
   *
   * The ranking is `rankTellings`, the same rule `listPublic` spells in SQL —
   * one picks the card, the other picks the survivor, and they must never
   * disagree about which telling that is. `duplicates-and-catalogue-agree` in
   * `test/duplicates.test.ts` is what holds them together.
   *
   * `assumeCanonical` lets a caller ask "and if these rows had the canonical
   * ids I am about to write?" without writing them, so the repair pass of a
   * dry run can report the collapse it would then cause.
   */
  async duplicateGroups(
    opts: { assumeCanonical?: ReadonlyMap<string, string> } = {},
  ): Promise<DuplicateGroup[]> {
    const rows = await this.db
      .select({
        canonicalId: sessions.canonicalId,
        band: sessions.band,
        expertId: sessions.expertId,
        language: sessions.language,
        id: sessions.id,
        title: sessions.title,
        hostId: sessions.hostId,
        hostIsAccount: sql<boolean>`exists (select 1 from ${participants} where ${participants.id} = ${sessions.hostId} and ${participants.anonymous} = false)`,
        recapPoints: sql<number>`jsonb_array_length(${sessions.recap})`,
        durationMs: sessions.durationMs,
        segments: sessions.segments,
        views: sessions.views,
        likes: sessions.likes,
        saves: sql<number>`(select count(*)::int from ${sessionSaves} where ${sessionSaves.sessionId} = ${sessions.id})`,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.visibility, 'public'),
          isNotNull(sessions.endedAt),
          // A room — a session somebody joined as a guest — is its host's
          // recording, not a lesson for the catalogue (ADR-0035): replay is
          // for solo sessions, and the room's lesson is reused by the memo
          // the moment anyone asks for the topic.
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(sessionVisits)
              .where(
                and(eq(sessionVisits.sessionId, sessions.id), eq(sessionVisits.role, 'guest')),
              ),
          ),
        ),
      );

    const byScope = new Map<string, DuplicateMember[]>();
    for (const row of rows) {
      const { canonicalId, band, expertId, language, ...rest } = row;
      const canonical = canonicalId ?? opts.assumeCanonical?.get(row.id) ?? null;
      if (!canonical) continue;
      const key = `${canonical}|${band}|${expertId}|${language}`;
      const member: DuplicateMember = {
        ...rest,
        hostIsAccount: Boolean(rest.hostIsAccount),
        recapPoints: Number(rest.recapPoints ?? 0),
      };
      const list = byScope.get(key);
      if (list) list.push(member);
      else byScope.set(key, [member]);
    }
    const groups: DuplicateGroup[] = [];
    for (const [scopeKey, members] of byScope) {
      if (members.length < 2) continue;
      const [keep, ...drop] = rankTellings(members);
      if (!keep) continue;
      groups.push({ scopeKey, keep, drop });
    }
    // Newest-looking first is no order at all for an operator reading a list;
    // the scope key is stable and sorts the report by topic.
    return groups.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0));
  }

  // ── redirects (ADR-0031) ──────────────────────────────────────────────────

  /**
   * The session an id now names: itself when it still exists, the one it was
   * collapsed into when it does not, and null when it never existed. One hop
   * by construction — `redirect` repoints rather than chains.
   */
  async resolve(id: string): Promise<SessionRecord | null> {
    const direct = await this.get(id);
    if (direct) return direct;
    const rows = await this.db
      .select({ toId: sessionRedirects.toId })
      .from(sessionRedirects)
      .where(eq(sessionRedirects.fromId, id))
      .limit(1);
    const to = rows[0]?.toId;
    return to ? await this.get(to) : null;
  }

  /**
   * Record that `fromId` is now `toId`, and repoint anything that pointed at
   * `fromId` so every redirect stays exactly one hop from an id to a session
   * that exists. Re-recording an id moves it; an id cannot point at itself.
   */
  async redirect(fromId: string, toId: string, reason: string, now = Date.now()): Promise<void> {
    if (fromId === toId) throw new Error(`a session cannot redirect to itself: ${fromId}`);
    await this.db.transaction(async (tx) => {
      await tx.update(sessionRedirects).set({ toId }).where(eq(sessionRedirects.toId, fromId));
      await tx
        .insert(sessionRedirects)
        .values({ fromId, toId, reason, createdAt: now })
        .onConflictDoUpdate({
          target: sessionRedirects.fromId,
          set: { toId, reason, createdAt: now },
        });
      // A surviving id must never also be a redirect source, or it would
      // shadow a session that exists.
      await tx.delete(sessionRedirects).where(eq(sessionRedirects.fromId, toId));
    });
  }

  /** Every redirect, oldest first — what the operator console and the tests read. */
  async redirects(): Promise<SessionRedirectRow[]> {
    return this.db.select().from(sessionRedirects).orderBy(asc(sessionRedirects.createdAt));
  }

  /**
   * Sessions with no sketch yet, newest first: what `thumbnails:backfill`
   * walks (ADR-0013). Live sessions are included — their job may simply have
   * failed — and the backfill skips anything the room is still teaching.
   */
  async listWithoutThumbnail(limit = 100): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(isNull(sessions.thumbnail))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
  }

  /**
   * Sessions still showing a pre-ADR-0021 hand-drawn sketch (`thumb.svg`),
   * newest first: what `thumbnails:backfill --redraw` walks to replace them
   * with a generated picture. Matching on the stored path is what makes them
   * findable — the record keeps no other trace of which renderer drew it.
   */
  async listWithSketchThumbnail(limit = 100): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(like(sessions.thumbnail, '%.svg'))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
  }

  /**
   * Sessions whose card is still the PNG ADR-0021 wrote (`thumb.png`), newest
   * first: what `thumbnails:backfill --reencode` walks. Their generation is
   * already paid for and still on disk as `source.png`, so moving them to a
   * WebP card is a re-derivation and not a call — which is why they are a
   * separate list from `--redraw`'s sketches, which have nothing to derive
   * from. Matching on the stored path is what makes them findable.
   */
  async listWithPngThumbnail(limit = 100): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(like(sessions.thumbnail, '%.png'))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
  }

  /**
   * Sessions whose row never got a canonical topic, oldest first — written
   * before the column existed, or by a path that did not fill it in. They
   * belong to no lesson scope, so nothing can be reused for them and nothing
   * can be collapsed with them; `sessions:dedupe` repairs them from each
   * session's own ledger before it scans (ADR-0031).
   */
  async listWithoutCanonicalId(limit = 5_000): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(isNull(sessions.canonicalId))
      .orderBy(asc(sessions.startedAt))
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
