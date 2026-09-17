/**
 * The animation clock behind every BoardExecution. It is the board's local
 * clock only: the audio clock stays the master (ADR-0002) and the conductor
 * drives pause/resume/finish/cancel through BoardExecution. The clock is
 * built on an injectable Ticker so the executor is fully testable without a
 * browser (ManualTicker) and uses requestAnimationFrame in the app.
 */

export interface Ticker {
  /** Schedule one callback for the next frame; returns a cancel function. */
  request(cb: (nowMs: number) => void): () => void;
  now(): number;
}

export function createRafTicker(): Ticker {
  const hasRaf = typeof requestAnimationFrame === 'function';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    now,
    request(cb) {
      if (hasRaf) {
        const id = requestAnimationFrame(() => cb(now()));
        return () => cancelAnimationFrame(id);
      }
      // Background tabs / non-browser hosts: a 16 ms timer keeps the timeline honest.
      const id = setTimeout(() => cb(now()), 16);
      return () => clearTimeout(id);
    },
  };
}

/** Test ticker: time only moves when `advance()` is called. */
export class ManualTicker implements Ticker {
  private t = 0;
  private pending: Array<{ id: number; cb: (nowMs: number) => void }> = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }

  request(cb: (nowMs: number) => void): () => void {
    const id = this.nextId++;
    this.pending.push({ id, cb });
    return () => {
      this.pending = this.pending.filter((p) => p.id !== id);
    };
  }

  /** Advance time in `stepMs` frames, running scheduled callbacks each frame. */
  advance(ms: number, stepMs = 16): void {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(stepMs, remaining);
      this.t += step;
      remaining -= step;
      this.flush();
    }
  }

  /** Run whatever is scheduled for "now" without moving time. */
  flush(): void {
    const batch = this.pending;
    this.pending = [];
    for (const { cb } of batch) cb(this.t);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

export type ClockState = 'idle' | 'running' | 'paused' | 'finished' | 'cancelled';

export interface AnimationClockOptions {
  ticker: Ticker;
  durationMs: number;
  /** Called every frame with elapsed time (clamped to duration) and progress 0..1. */
  onFrame: (elapsedMs: number, progress: number) => void;
  onSettled: (reason: 'finished' | 'cancelled') => void;
}

export class AnimationClock {
  private state: ClockState = 'idle';
  private accumulated = 0;
  private segmentStart: number | null = null;
  private cancelFrame: (() => void) | null = null;
  private readonly duration: number;

  constructor(private readonly opts: AnimationClockOptions) {
    this.duration = Math.max(0, opts.durationMs);
  }

  get status(): ClockState {
    return this.state;
  }

  get elapsedMs(): number {
    if (this.state === 'running' && this.segmentStart !== null) {
      return Math.min(this.duration, this.accumulated + (this.opts.ticker.now() - this.segmentStart));
    }
    return Math.min(this.duration, this.accumulated);
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    this.segmentStart = this.opts.ticker.now();
    this.opts.onFrame(0, this.duration === 0 ? 1 : 0);
    if (this.duration === 0) {
      this.settle('finished');
      return;
    }
    this.schedule();
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.accumulated = this.elapsedMs;
    this.segmentStart = null;
    this.state = 'paused';
    this.unschedule();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.segmentStart = this.opts.ticker.now();
    this.schedule();
  }

  /** Jump to the end: one final frame at progress 1, then settle. */
  finish(): void {
    if (this.state === 'finished' || this.state === 'cancelled') return;
    this.unschedule();
    this.accumulated = this.duration;
    this.segmentStart = null;
    this.opts.onFrame(this.duration, 1);
    this.settle('finished');
  }

  /** Stop where we are; what was drawn stays. */
  cancel(): void {
    if (this.state === 'finished' || this.state === 'cancelled') return;
    this.accumulated = this.elapsedMs;
    this.segmentStart = null;
    this.unschedule();
    this.settle('cancelled');
  }

  private schedule(): void {
    this.unschedule();
    this.cancelFrame = this.opts.ticker.request(() => this.tick());
  }

  private unschedule(): void {
    if (this.cancelFrame) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
  }

  private tick(): void {
    this.cancelFrame = null;
    if (this.state !== 'running') return;
    const elapsed = this.elapsedMs;
    const progress = this.duration === 0 ? 1 : elapsed / this.duration;
    this.opts.onFrame(elapsed, progress);
    if (elapsed >= this.duration) {
      this.accumulated = this.duration;
      this.segmentStart = null;
      this.settle('finished');
      return;
    }
    this.schedule();
  }

  private settle(reason: 'finished' | 'cancelled'): void {
    this.state = reason;
    this.opts.onSettled(reason);
  }
}
