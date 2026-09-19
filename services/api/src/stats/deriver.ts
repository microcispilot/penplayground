import { STATS_SCHEMA_VERSION } from '@pen/contracts';
import type { ParticipantRepository, SessionRepository, StatsRepository } from '@pen/db';
import type { FileLedger } from '../ledger.js';
import { computeTelemetry } from '../telemetry.js';
import { deriveSession, type EndReason } from './derive.js';

/**
 * Turning finished sessions into rows, off the hot path (ADR-0027).
 *
 * The rule this class exists to keep: **writing statistics must never slow a
 * lesson and must never fail one.** So a room that ends does not derive
 * anything; it puts a session id in a map, which cannot be slow and cannot
 * throw. A drain loop started by `main` picks the queue up every
 * `STATS_DRAIN_MS` and derives one session at a time, and every failure is
 * reported to the observer and dropped.
 *
 * Queueing rather than deriving inline is deliberate and load-bearing. The
 * obvious version — `void derive(id)` from `RoomRegistry.end` — runs the
 * derivation's reads and writes *interleaved with the room's own last writes*,
 * which is both needless contention on the connection and, on PGlite, a way
 * to wedge the whole process (found the hard way: `pnpm --filter @pen/api
 * test test/rooms-intake.test.ts` went from 2 s to never finishing). Nothing
 * a lesson does should be sharing a connection with a report.
 *
 * A session is derived twice on purpose. Once as soon as the queue is
 * drained, so the dashboard is current within seconds; and once again after
 * `STATS_SETTLE_MS`, because the card copy and the session picture are
 * generated beside the lesson and their telemetry can land in the ledger
 * after the room has closed (`createSessionMetaJobs`). The write is
 * idempotent, so the second pass replaces the first — and the same
 * idempotence is what lets `stats:backfill` re-derive a year of ledgers.
 */

/** How often the queue is drained. Seconds, because this is a dashboard and not a lesson. */
export const STATS_DRAIN_MS = 10_000;
/** How long after a session ends the second pass runs, for late background work. */
export const STATS_SETTLE_MS = 120_000;

export interface StatsDeriverDeps {
  ledger: Pick<FileLedger, 'read' | 'list'>;
  sessions: Pick<SessionRepository, 'get'>;
  participants: Pick<ParticipantRepository, 'get'>;
  stats: Pick<StatsRepository, 'putDerivedSession' | 'derivedState'>;
  onError: (area: string, error: unknown, detail?: Record<string, unknown>) => void;
  onEvent?: (name: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

export interface DeriveOptions {
  /** What the room knew and the ledger cannot say. */
  completed?: boolean | undefined;
  endReason?: EndReason | undefined;
  /** Skip when the ledger has not grown and the derivation has not changed. */
  ifChanged?: boolean | undefined;
}

export type DeriveOutcome = 'written' | 'unchanged' | 'no-session' | 'no-ledger';

interface Queued extends DeriveOptions {
  /** Not before this moment; the settle pass sets it into the future. */
  after: number;
  /** Whether the settle pass has already been queued for this session. */
  settleQueued: boolean;
}

export class StatsDeriver {
  private readonly queue = new Map<string, Queued>();
  private draining = false;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly d: StatsDeriverDeps) {
    this.now = d.now ?? Date.now;
  }

  /**
   * This session's ledger is finished with; derive it on the next drain.
   * Synchronous, allocation-only, and impossible to fail: a room calls this
   * as the last thing it does and never waits for anything.
   */
  enqueue(sessionId: string, opts: DeriveOptions = {}): void {
    if (this.closed) return;
    const existing = this.queue.get(sessionId);
    this.queue.set(sessionId, {
      ...existing,
      ...opts,
      after: existing?.after ?? 0,
      settleQueued: existing?.settleQueued ?? false,
    });
  }

  /** How many sessions are waiting. For a readiness line and for tests. */
  get pending(): number {
    return this.queue.size;
  }

  /**
   * Derive everything due, one session at a time. Never throws, never runs
   * twice at once, and stops at the first session that is not due yet only in
   * the sense of skipping it — a settling session does not block the rest.
   */
  async drain(): Promise<number> {
    if (this.draining || this.closed) return 0;
    this.draining = true;
    let done = 0;
    try {
      const at = this.now();
      for (const [sessionId, queued] of [...this.queue]) {
        if (this.closed) break;
        if (queued.after > at) continue;
        this.queue.delete(sessionId);
        try {
          await this.derive(sessionId, queued);
          done += 1;
        } catch (error) {
          this.d.onError('stats.derive', error, { sessionId });
          continue;
        }
        // Come back once more, after the background card and picture have had
        // time to land in the ledger. `ifChanged` makes that a no-op when
        // nothing did.
        if (!queued.settleQueued && !this.closed)
          this.queue.set(sessionId, {
            ...queued,
            ifChanged: true,
            after: this.now() + STATS_SETTLE_MS,
            settleQueued: true,
          });
      }
    } finally {
      this.draining = false;
    }
    return done;
  }

  /**
   * Derive one session now. The backfill, the drain loop and the tests call
   * this; a room never does.
   */
  async derive(sessionId: string, opts: DeriveOptions = {}): Promise<DeriveOutcome> {
    const record = await this.d.sessions.get(sessionId);
    if (!record) return 'no-session';
    const entries = this.d.ledger.read(sessionId);
    if (entries.length === 0) return 'no-ledger';

    if (opts.ifChanged) {
      const state = (await this.d.stats.derivedState([sessionId])).get(sessionId);
      if (
        state &&
        state.ledgerEntries === entries.length &&
        state.schemaVersion === STATS_SCHEMA_VERSION
      )
        return 'unchanged';
    }

    const telemetry = computeTelemetry({
      sessionId,
      expertId: record.expertId,
      language: record.language,
      entries,
    });
    // The host's analytics choice, read now rather than remembered: they may
    // have turned it off since the session ran, and the newer answer wins.
    const host = await this.d.participants.get(record.hostId).catch(() => null);
    const derived = deriveSession({
      telemetry,
      record,
      ledgerEntries: entries.length,
      completed: opts.completed,
      endReason: opts.endReason,
      hostOptedOut: host?.analyticsOptOut ?? false,
      derivedAt: this.now(),
    });
    await this.d.stats.putDerivedSession({
      session: derived.session,
      stages: derived.stages,
      errors: derived.errors,
      generated: derived.generated,
      reused: derived.reused,
      topic: record.topic,
    });
    this.d.onEvent?.('stats.derived', {
      sessionId,
      entries: entries.length,
      leaveReason: derived.session.leaveReason,
      reuseLinks: derived.reused.length,
    });
    return 'written';
  }

  /** Stop accepting and stop draining (process shutdown, tests). */
  close(): void {
    this.closed = true;
    this.queue.clear();
  }
}
