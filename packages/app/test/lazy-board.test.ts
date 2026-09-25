import type { BoardExecution, BoardPort } from '@pen/conductor';
import type { BoardEvent, NoteEvent } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { LazyBoard } from '../src/room/LazyBoard.js';

class FakeExec implements BoardExecution {
  private resolveDone!: () => void;
  readonly done = new Promise<void>((r) => {
    this.resolveDone = r;
  });
  paused = 0;
  resumed = 0;
  finished = 0;
  cancelled = 0;
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  finish() {
    this.finished++;
    this.resolveDone();
  }
  cancel() {
    this.cancelled++;
    this.resolveDone();
  }
  /** The real board finished rendering on its own. */
  complete() {
    this.resolveDone();
  }
}

class FakeBoard implements BoardPort {
  /** Every call in arrival order, so buffering can be checked for order as well as content. */
  readonly calls: string[] = [];
  readonly execs = new Map<string, FakeExec>();
  readonly paces = new Map<string, number | null>();
  dimmed: boolean | null = null;
  cleared = 0;
  execute(op: BoardEvent, opts: { paceMs: number | null }): BoardExecution {
    this.calls.push(`execute:${op.id}`);
    const exec = new FakeExec();
    this.execs.set(op.id, exec);
    this.paces.set(op.id, opts.paceMs);
    return exec;
  }
  pinNote(note: NoteEvent, id: string): void {
    this.calls.push(`pin:${id}:${note.headline}`);
  }
  setDimmed(dimmed: boolean): void {
    this.calls.push(`dim:${dimmed}`);
    this.dimmed = dimmed;
  }
  clear(): void {
    this.calls.push('clear');
    this.cleared++;
  }
}

const op = (id: string): BoardEvent => ({
  type: 'board',
  id,
  anchor: 'now',
  op: 'write',
  text: id,
  lang: '',
  ref: '',
  ref2: '',
  place: 'flow',
  emphasis: 'ink',
});
const note = (headline: string): NoteEvent => ({
  type: 'note',
  language: 'en-US',
  question: 'q',
  headline,
  detail: 'd',
});

/** True when the promise has settled by the next macrotask (so "not yet resolved" is provable). */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('LazyBoard', () => {
  it('buffers execute and pinNote until attach and replays them in arrival order', () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    lazy.execute(op('b1'), { paceMs: 1200 });
    lazy.pinNote(note('keeps scores'), 'note-5');
    lazy.execute(op('b2'), { paceMs: null });
    lazy.pinNote(note('second'), 'note-7');
    expect(real.calls).toEqual([]);

    lazy.attach(real);
    expect(real.calls).toEqual([
      'dim:false',
      'execute:b1',
      'pin:note-5:keeps scores',
      'execute:b2',
      'pin:note-7:second',
    ]);
    expect(real.paces.get('b1')).toBe(1200);
    expect(real.paces.get('b2')).toBeNull();

    // After attach everything goes straight through, nothing is replayed twice.
    lazy.execute(op('b3'), { paceMs: 900 });
    lazy.pinNote(note('third'), 'note-9');
    expect(real.calls.slice(5)).toEqual(['execute:b3', 'pin:note-9:third']);
    expect(real.calls).toHaveLength(7);
  });

  it('applies pause requested before attach to the real execution', async () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    const exec = lazy.execute(op('b1'), { paceMs: null });
    exec.pause();
    lazy.attach(real);
    const inner = real.execs.get('b1');
    expect(inner?.paused).toBe(1);
    expect(inner?.finished).toBe(0);
    expect(await settled(exec.done)).toBe(false);
    // Later calls forward to the real execution.
    exec.resume();
    expect(inner?.resumed).toBe(1);
    inner?.complete();
    expect(await settled(exec.done)).toBe(true);
  });

  it('a pause followed by resume before attach leaves the real execution running', () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    const exec = lazy.execute(op('b1'), { paceMs: null });
    exec.pause();
    exec.resume();
    lazy.attach(real);
    expect(real.execs.get('b1')?.paused).toBe(0);
  });

  it('applies finish requested before attach and resolves done once the real execution finishes', async () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    const exec = lazy.execute(op('b1'), { paceMs: 500 });
    exec.finish();
    expect(await settled(exec.done)).toBe(false);
    lazy.attach(real);
    expect(real.execs.get('b1')?.finished).toBe(1);
    expect(await settled(exec.done)).toBe(true);
  });

  it('a cancel before attach never reaches the real board and resolves done immediately', async () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    const exec = lazy.execute(op('b1'), { paceMs: null });
    const kept = lazy.execute(op('b2'), { paceMs: null });
    exec.cancel();
    expect(await settled(exec.done)).toBe(true);
    lazy.attach(real);
    expect(real.calls.filter((c) => c.startsWith('execute:'))).toEqual(['execute:b2']);
    expect(await settled(kept.done)).toBe(false);
    kept.cancel();
    expect(real.execs.get('b2')?.cancelled).toBe(1);
    expect(await settled(kept.done)).toBe(true);
  });

  it('done of a buffered op resolves only when the real execution completes', async () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    const exec = lazy.execute(op('b1'), { paceMs: null });
    lazy.attach(real);
    expect(await settled(exec.done)).toBe(false);
    real.execs.get('b1')?.complete();
    expect(await settled(exec.done)).toBe(true);
  });

  it('replays the latest dim state on attach and forwards later changes', () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    lazy.setDimmed(true);
    lazy.setDimmed(false);
    lazy.setDimmed(true);
    lazy.attach(real);
    expect(real.dimmed).toBe(true);
    expect(real.calls).toEqual(['dim:true']);
    lazy.setDimmed(false);
    expect(real.dimmed).toBe(false);
  });

  it('dims the real board before replaying buffered ops so a learner turn in progress is honoured', () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    lazy.execute(op('b1'), { paceMs: null });
    lazy.setDimmed(true);
    lazy.attach(real);
    expect(real.calls).toEqual(['dim:true', 'execute:b1']);
  });

  it('clear is a no-op before attach and forwards afterwards', () => {
    const lazy = new LazyBoard();
    const real = new FakeBoard();
    lazy.clear();
    lazy.attach(real);
    expect(real.cleared).toBe(0);
    lazy.clear();
    expect(real.cleared).toBe(1);
  });
});

describe('ready', () => {
  it('resolves when the real board attaches, and not before', async () => {
    const lazy = new LazyBoard();
    let ready = false;
    void lazy.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    lazy.attach(new FakeBoard());
    await lazy.ready;
    expect(ready).toBe(true);
  });
});
