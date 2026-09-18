import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CostLine, PlanCode } from '@pen/contracts';
import { hasEntitlement, LedgerEntry as LedgerEntrySchema, utcDayStart } from '@pen/contracts';
import { logger } from './logger.js';

/**
 * The day's provider spend, and the decision to hold new sessions back before
 * it runs away (ADR-0015).
 *
 * Every priced provider call already writes a `CostLine` into its session's
 * ledger through the telemetry port (ADR-0011). This listens to the same
 * lines as they are recorded, so the number the breaker acts on is the number
 * the Insights tab shows — there is no second meter to disagree with the
 * first. On boot it rebuilds the running total from today's ledgers on disk,
 * so a restart mid-day does not reset the budget.
 *
 * Ads are revenue, not spend: `ads` lines are tallied separately and never
 * reduce the amount the cap measures, because a cap that ad revenue could
 * inflate would stop protecting the card behind it.
 */
export interface SpendDecision {
  ok: boolean;
  /** Provider spend booked for the current UTC day. */
  usd: number;
  /** The cap in force for this plan (cap for free, cap × multiple for paid). */
  limitUsd: number;
}

export interface SpendBreakerOptions {
  /** `PEN_DAILY_SPEND_CAP_USD`; 0 disables the breaker entirely. */
  capUsd: number;
  /** Paid plans keep going to `capUsd × paidMultiple`. */
  paidMultiple: number;
  /** Fires once per day when the day's spend first crosses 80 % of the cap. */
  onWarning?: (info: { usd: number; capUsd: number; fraction: number }) => void;
  now?: () => number;
}

/** Warn while there is still a fifth of the budget left to react in. */
const WARN_FRACTION = 0.8;

export class SpendBreaker {
  private day: number;
  private usd = 0;
  private revenueUsd = 0;
  private warned = false;
  private readonly now: () => number;

  constructor(private readonly o: SpendBreakerOptions) {
    this.now = o.now ?? (() => Date.now());
    this.day = utcDayStart(this.now());
  }

  /** Disabled breakers are honest about it rather than silently allowing everything. */
  get enabled(): boolean {
    return this.o.capUsd > 0;
  }

  get capUsd(): number {
    return this.o.capUsd;
  }

  /** Today's provider spend and estimated ad revenue (revenue never offsets the cap). */
  snapshot(): { dayStart: number; usd: number; revenueUsd: number; capUsd: number } {
    this.rollover();
    return {
      dayStart: this.day,
      usd: this.usd,
      revenueUsd: this.revenueUsd,
      capUsd: this.o.capUsd,
    };
  }

  /** One priced line of provider work, as it is written to a session's ledger. */
  record(line: CostLine): void {
    this.rollover();
    if (line.component === 'ads') {
      this.revenueUsd += line.usd;
      return;
    }
    this.usd += line.usd;
    if (!this.enabled || this.warned) return;
    const fraction = this.usd / this.o.capUsd;
    if (fraction < WARN_FRACTION) return;
    this.warned = true;
    this.o.onWarning?.({ usd: this.usd, capUsd: this.o.capUsd, fraction });
  }

  /**
   * May a session start on this plan right now? Free sessions stop at the cap;
   * paying learners — who are the reason the cap is affordable at all — keep
   * going to a multiple of it, so a spend spike never silently bills them for
   * a product they cannot open.
   */
  check(plan: PlanCode): SpendDecision {
    this.rollover();
    const limitUsd = this.limitFor(plan);
    if (!this.enabled) return { ok: true, usd: this.usd, limitUsd };
    return { ok: this.usd < limitUsd, usd: this.usd, limitUsd };
  }

  limitFor(plan: PlanCode): number {
    const paid = hasEntitlement(plan, 'unlimited_sessions');
    return this.o.capUsd * (paid ? this.o.paidMultiple : 1);
  }

  /**
   * Recover today's total from the ledgers on disk. Only files touched since
   * the day began are read, so the scan stays proportional to today's traffic
   * rather than to everything the node has ever recorded.
   */
  rebuild(sessionsDir: string): { sessions: number; usd: number } {
    this.rollover();
    if (!existsSync(sessionsDir)) return { sessions: 0, usd: this.usd };
    let sessions = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (error) {
      logger.warn({ evt: 'spend.rebuild_failed', detail: String(error) });
      return { sessions: 0, usd: this.usd };
    }
    for (const id of entries) {
      const file = join(sessionsDir, id, 'ledger.jsonl');
      try {
        if (!existsSync(file)) continue;
        if (statSync(file).mtimeMs < this.day) continue;
        sessions += 1;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
          if (!parsed.success || parsed.data.kind !== 'cost') continue;
          // `t` on a ledger entry is wall-clock ms: only today's lines count.
          if (parsed.data.t < this.day) continue;
          if (parsed.data.line.component === 'ads') this.revenueUsd += parsed.data.line.usd;
          else this.usd += parsed.data.line.usd;
        }
      } catch (error) {
        // One unreadable ledger must not cost us the whole day's total.
        logger.warn({ evt: 'spend.ledger_unreadable', sessionId: id, detail: String(error) });
      }
    }
    return { sessions, usd: this.usd };
  }

  private rollover(): void {
    const day = utcDayStart(this.now());
    if (day === this.day) return;
    this.day = day;
    this.usd = 0;
    this.revenueUsd = 0;
    this.warned = false;
  }
}
