/**
 * One writer at a time, and one failure that stays with its own caller.
 *
 * Both file caches serialise their writes the obvious way:
 *
 *     this.writing = this.writing.then(() => { …write… });
 *     await this.writing;
 *
 * which is correct exactly until a write fails. `Promise.prototype.then`
 * with no rejection handler passes the rejection straight down, so from the
 * first failure onward the chain is a permanently rejected promise: the body
 * of every later `.then` never runs, and every later caller is handed the
 * *original* error. One transient `ENOSPC`, one `EACCES` after a bad deploy,
 * one directory removed underneath a running process — and the card cache
 * and the thumbnail cache stop writing for the life of that process, while
 * reporting the same stale reason each time.
 *
 * It is silent, too. Nothing re-reads a cache it just failed to write, so the
 * symptom is not an error anyone sees: it is every session paying ~$0.016 for
 * a picture that was already bought, until someone restarts the process.
 *
 * So the queue keeps the ordering and drops the poison:
 *
 *   · a predecessor's failure does not stop the next write from running;
 *   · the chain handed to the next caller can never be in a rejected state;
 *   · each caller still learns about *its own* write, and nobody else's.
 */
export class WriteQueue {
  /** Always settled-or-pending, never rejected: see `run`. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Queue `work`, resolving (or rejecting) with what it did. Writes run in
   * the order they were queued, whatever any of them does.
   */
  run<T>(work: () => T | Promise<T>): Promise<T> {
    // `catch` first: whatever happened to the write before us is that
    // caller's business, and waiting on it must not become failing with it.
    const mine = this.tail.then(
      () => work(),
      () => work(),
    );
    // What the next caller waits on: our *outcome*, never our failure.
    this.tail = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  /** Settles when everything queued so far has finished, however it finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}
