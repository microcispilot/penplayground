import type { BoardExecution, BoardPort } from '@pen/conductor';
import type { BoardEvent, NoteEvent } from '@pen/contracts';

/**
 * A board port that buffers until the real board mounts, so cues that arrive
 * during the first render are never lost and never reordered.
 */
export class LazyBoard implements BoardPort {
  private real: BoardPort | null = null;
  private readonly queue: Array<() => void> = [];
  private dimmed = false;

  attach(board: BoardPort): void {
    this.real = board;
    board.setDimmed(this.dimmed);
    for (const fn of this.queue.splice(0)) fn();
  }

  execute(op: BoardEvent, opts: { paceMs: number | null }): BoardExecution {
    if (this.real) return this.real.execute(op, opts);
    let inner: BoardExecution | null = null;
    let paused = false;
    let finished = false;
    let cancelled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.queue.push(() => {
      if (cancelled || !this.real) {
        resolveDone();
        return;
      }
      inner = this.real.execute(op, opts);
      if (paused) inner.pause();
      if (finished) inner.finish();
      void inner.done.then(resolveDone);
    });
    return {
      done,
      pause: () => {
        paused = true;
        inner?.pause();
      },
      resume: () => {
        paused = false;
        inner?.resume();
      },
      finish: () => {
        finished = true;
        inner?.finish();
      },
      cancel: () => {
        cancelled = true;
        inner?.cancel();
        resolveDone();
      },
    };
  }
  pinNote(note: NoteEvent, id: string): void {
    if (this.real) this.real.pinNote(note, id);
    else this.queue.push(() => this.real?.pinNote(note, id));
  }
  setDimmed(dimmed: boolean): void {
    this.dimmed = dimmed;
    this.real?.setDimmed(dimmed);
  }
  clear(): void {
    this.real?.clear();
  }
}
