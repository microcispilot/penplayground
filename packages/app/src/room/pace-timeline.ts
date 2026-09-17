import type { LedgerEntry } from '@pen/contracts';
import { clampPace, PACE_DEFAULT } from '@pen/contracts';

/**
 * The teaching pace at every moment of a recording, from the ledger's `pace`
 * entries (ADR-0010). A session starts at 1× unless the host's remembered
 * pace arrived before the first cue; every later change is stamped with the
 * server clock, so `at(cue.at)` is the pace the room was in when a sentence
 * was emitted — which is when its synthesis (and so its board rate) began.
 */
export interface PaceTimeline {
  /** Pace in force at server time `t`. */
  at(t: number): number;
  /** Pace when the first cue was emitted (the replay's starting state). */
  readonly initial: number;
  /** True when the pace never changed: replay can skip the bookkeeping. */
  readonly constant: boolean;
}

export function paceTimeline(entries: readonly LedgerEntry[]): PaceTimeline {
  const changes: Array<{ t: number; pace: number }> = [];
  for (const e of entries) if (e.kind === 'pace') changes.push({ t: e.t, pace: clampPace(e.pace) });
  changes.sort((a, b) => a.t - b.t);
  const at = (t: number): number => {
    let pace = PACE_DEFAULT;
    for (const c of changes) {
      if (c.t > t) break;
      pace = c.pace;
    }
    return pace;
  };
  const firstCue = entries.find((e) => e.kind === 'cue');
  const initial = at(firstCue?.t ?? Number.POSITIVE_INFINITY);
  const constant = changes.every((c) => Math.abs(c.pace - initial) < 1e-6);
  return { at, initial, constant };
}
