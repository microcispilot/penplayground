/**
 * How many sessions one learner, and one address, may be *starting* at once.
 *
 * `POST /api/sessions` has two ceilings — a plan's sessions per day, and
 * `PEN_MAX_SESSIONS_PER_IP` live rooms from one machine — and both were
 * check-then-act across a long `await`. The check reads a count; the thing
 * that makes the count true is written on the far side of `rooms.create()`,
 * which runs the intake model call and takes on the order of a second and a
 * half. Every request that arrives inside that window reads the world as it
 * was before any of them, and every one of them passes.
 *
 * Measured against a real server: eight concurrent POSTs on a three-a-day
 * free plan returned eight 201s and built eight rooms; with
 * `PEN_MAX_SESSIONS_PER_IP=2`, six concurrent POSTs returned six 201s, while
 * a seventh sent afterwards was correctly refused. Both ceilings exist to
 * bound spend on real providers, so neither is a formality.
 *
 * This is the missing half: a place is taken **in the same tick as the
 * check**, and given back when the creation finishes, whether it succeeded or
 * threw. A caller then counts what is already true (rows in the database,
 * rooms in the registry) *plus* what is in flight, and the eighth request
 * sees the seven ahead of it.
 *
 * ## What this is not
 *
 * In-process, like `SpendBreaker` and `liveByIp` beside it. A second node
 * would have its own counters and the ceilings would be per node — the same
 * caveat already recorded for the spend breaker in `tasks/todo.md`, and the
 * same answer when it matters: a shared counter, or a constraint the database
 * enforces. Nothing here pretends otherwise, and a hold is cheap enough
 * (two map entries) that adding one changes no timing.
 *
 * It is also not a rate limiter. `allowSession` in `rate-limit.ts` is still
 * what bounds how *often* a caller may ask; this bounds how many answers can
 * be in the air at once.
 */

/** A place taken. Give it back exactly once, in a `finally`. */
export interface Admission {
  release(): void;
}

export class Admissions {
  private readonly byHost = new Map<string, number>();
  private readonly byAddress = new Map<string, number>();

  /** Creations in flight for this participant right now. */
  pendingForHost(hostId: string): number {
    return this.byHost.get(hostId) ?? 0;
  }

  /** Creations in flight from this address right now. */
  pendingForAddress(address: string): number {
    return this.byAddress.get(address) ?? 0;
  }

  /**
   * Take a place for a creation about to start.
   *
   * Must be called with no `await` between the caller's checks and this, or
   * it guards nothing — that gap is the whole bug. `release()` is idempotent
   * so a `finally` that runs twice cannot drive a counter negative and let an
   * extra session through.
   */
  hold(hostId: string, address: string): Admission {
    bump(this.byHost, hostId, 1);
    bump(this.byAddress, address, 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        bump(this.byHost, hostId, -1);
        bump(this.byAddress, address, -1);
      },
    };
  }
}

/** Counters that delete themselves at zero, so neither map grows with traffic. */
function bump(counts: Map<string, number>, key: string, by: number): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}
