/**
 * A timeline is the pure description of one board op's animation: a list of
 * tracks, each owning one shape and a window on the op's clock. Sampling the
 * timeline at time t returns the shape updates that changed since the last
 * sample, so the executor can push exactly one `updateShapes` per frame.
 */

export interface ShapeUpdate {
  id: string;
  props?: Record<string, unknown>;
  opacity?: number;
}

export interface Track {
  /** Shape id this track drives. */
  id: string;
  startMs: number;
  durationMs: number;
  /** Map local progress (0..1) to a shape update. */
  at(local: number): ShapeUpdate;
}

export type TrackInit = Omit<Track, 'startMs'>;

export class Timeline {
  readonly tracks: Track[] = [];
  private cursorMs = 0;
  private readonly last = new Map<Track, number>();

  get totalMs(): number {
    return this.tracks.reduce((m, t) => Math.max(m, t.startMs + t.durationMs), 0);
  }

  /** Append a track after everything added so far (with an optional gap). */
  append(track: TrackInit, gapMs = 0): this {
    const startMs = this.cursorMs + gapMs;
    this.tracks.push({ ...track, startMs });
    this.cursorMs = startMs + track.durationMs;
    return this;
  }

  /** Add a track at an explicit start (parallel to others). */
  at(startMs: number, track: TrackInit): this {
    this.tracks.push({ ...track, startMs });
    this.cursorMs = Math.max(this.cursorMs, startMs + track.durationMs);
    return this;
  }

  /** Uniformly slow the whole timeline down (used when pacing to a sentence). */
  stretch(factor: number): this {
    if (!(factor > 0) || factor === 1) return this;
    for (const t of this.tracks) {
      t.startMs *= factor;
      t.durationMs *= factor;
    }
    this.cursorMs *= factor;
    return this;
  }

  /** Updates for tracks whose local progress changed since the previous sample. */
  sample(tMs: number): ShapeUpdate[] {
    const out: ShapeUpdate[] = [];
    for (const track of this.tracks) {
      const local = localProgress(track, tMs);
      if (this.last.get(track) === local) continue;
      this.last.set(track, local);
      out.push(track.at(local));
    }
    return out;
  }

  /** Every track at its final state (used by finish/cancel bookkeeping). */
  finalUpdates(): ShapeUpdate[] {
    return this.tracks.map((t) => {
      this.last.set(t, 1);
      return t.at(1);
    });
  }
}

export function localProgress(track: Track, tMs: number): number {
  if (track.durationMs <= 0) return tMs >= track.startMs ? 1 : 0;
  const local = (tMs - track.startMs) / track.durationMs;
  return local <= 0 ? 0 : local >= 1 ? 1 : local;
}

/** The common case: a shape whose `progress` prop goes 0→1. */
export function progressTrack(id: string, durationMs: number): TrackInit {
  return { id, durationMs, at: (p) => ({ id, props: { progress: p } }) };
}

/** Opacity fade used by `erase`. */
export function fadeTrack(id: string, durationMs: number, from = 1, to = 0): TrackInit {
  return { id, durationMs, at: (p) => ({ id, opacity: from + (to - from) * p }) };
}
