import { describe, expect, it } from 'vitest';
import { AnimationClock, ManualTicker } from '../src/clock.js';
import { Timeline, fadeTrack, progressTrack } from '../src/timeline.js';

describe('AnimationClock', () => {
  function make(durationMs: number) {
    const ticker = new ManualTicker();
    const frames: number[] = [];
    let settled: string | null = null;
    const clock = new AnimationClock({
      ticker,
      durationMs,
      onFrame: (_e, p) => frames.push(p),
      onSettled: (r) => {
        settled = r;
      },
    });
    return { ticker, frames, clock, settled: () => settled };
  }

  it('runs to completion and settles once', () => {
    const { ticker, frames, clock, settled } = make(100);
    clock.start();
    expect(frames).toEqual([0]);
    ticker.advance(48);
    expect(frames.at(-1)).toBeCloseTo(0.48, 6);
    ticker.advance(100);
    expect(frames.at(-1)).toBe(1);
    expect(settled()).toBe('finished');
    expect(ticker.pendingCount).toBe(0);
  });

  it('pause freezes time and resume continues from the same point', () => {
    const { ticker, frames, clock, settled } = make(200);
    clock.start();
    ticker.advance(64);
    clock.pause();
    const atPause = frames.at(-1);
    ticker.advance(500);
    expect(frames.at(-1)).toBe(atPause);
    expect(settled()).toBeNull();
    clock.resume();
    ticker.advance(16);
    expect(frames.at(-1)).toBeCloseTo((64 + 16) / 200, 6);
    ticker.advance(200);
    expect(settled()).toBe('finished');
  });

  it('finish jumps to progress 1 immediately', () => {
    const { ticker, frames, clock, settled } = make(1000);
    clock.start();
    ticker.advance(16);
    clock.finish();
    expect(frames.at(-1)).toBe(1);
    expect(settled()).toBe('finished');
    expect(ticker.pendingCount).toBe(0);
  });

  it('cancel stops without a final frame', () => {
    const { ticker, frames, clock, settled } = make(1000);
    clock.start();
    ticker.advance(32);
    const before = frames.length;
    clock.cancel();
    expect(frames.length).toBe(before);
    expect(settled()).toBe('cancelled');
    clock.finish(); // no-op after cancel
    expect(frames.length).toBe(before);
  });

  it('a zero-duration clock completes on start', () => {
    const { frames, clock, settled } = make(0);
    clock.start();
    expect(frames).toEqual([1]);
    expect(settled()).toBe('finished');
  });
});

describe('Timeline', () => {
  it('sequences tracks and only emits changed updates', () => {
    const tl = new Timeline().then(progressTrack('a', 100)).then(progressTrack('b', 100), 50);
    expect(tl.totalMs).toBe(250);
    expect(tl.sample(0)).toEqual([
      { id: 'a', props: { progress: 0 } },
      { id: 'b', props: { progress: 0 } },
    ]);
    expect(tl.sample(50)).toEqual([{ id: 'a', props: { progress: 0.5 } }]);
    expect(tl.sample(120)).toEqual([{ id: 'a', props: { progress: 1 } }]);
    expect(tl.sample(120)).toEqual([]);
    expect(tl.sample(200)).toEqual([{ id: 'b', props: { progress: 0.5 } }]);
    expect(tl.finalUpdates()).toEqual([
      { id: 'a', props: { progress: 1 } },
      { id: 'b', props: { progress: 1 } },
    ]);
  });

  it('stretch scales starts and durations uniformly', () => {
    const tl = new Timeline().then(progressTrack('a', 100)).then(progressTrack('b', 100)).stretch(2);
    expect(tl.totalMs).toBe(400);
    expect(tl.tracks[1]?.startMs).toBe(200);
  });

  it('fade tracks drive opacity', () => {
    const tl = new Timeline().at(0, fadeTrack('x', 100));
    expect(tl.sample(50)).toEqual([{ id: 'x', opacity: 0.5 }]);
  });
});
