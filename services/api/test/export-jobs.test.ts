import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportJobs, ExportRefused, type Renderer, type RenderResult } from '../src/export/jobs.js';

/** One spoken sentence in the ledger: a say cue plus `ms` of 44.1 kHz audio. */
function sayLines(n: number, ms: number): string {
  const cue = {
    kind: 'cue',
    t: 1_000_000 + n,
    cue: {
      seq: n,
      segment: 0,
      thread: 'lesson',
      at: 1_000_000 + n,
      event: { type: 'say', id: `L0.s${n}`, text: `sentence ${n}`, tone: 'neutral' },
    },
  };
  const audio = {
    kind: 'audio',
    t: 1_000_000 + n,
    header: {
      dir: 'down',
      sayId: `L0.s${n}`,
      audioChunkId: 0,
      audioClockMs: 0,
      sampleRate: 44100,
      durationMs: ms,
      textSpan: null,
      final: true,
      take: 0,
    },
    audioRef: `L0.s${n}.0.pcm#0`,
  };
  return `${JSON.stringify(cue)}\n${JSON.stringify(audio)}\n`;
}

function fixture() {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pen-export-jobs-'));
  const session = (id: string, ledgerAt = 1_000_000) => {
    const dir = join(sessionsDir, id);
    mkdirSync(join(dir, 'audio'), { recursive: true });
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      `${JSON.stringify({ kind: 'join', t: ledgerAt, participantId: 'p_hosthost', name: 'Ada' })}\n${sayLines(1, 3000)}`,
    );
    utimesSync(join(dir, 'ledger.jsonl'), ledgerAt / 1000, ledgerAt / 1000);
    return dir;
  };
  return { sessionsDir, session };
}

/** A renderer that writes a file after `resolve()` is called (or fails), recording call order. */
function fakeRenderer(opts: { fail?: string } = {}) {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const renderer: Renderer = {
    async render({ sessionId, outputPath, onProgress }) {
      calls.push(sessionId);
      onProgress(0.5);
      await new Promise<void>((r) => gates.push(r));
      if (opts.fail) throw new Error(opts.fail);
      writeFileSync(outputPath, Buffer.alloc(1024));
      const result: RenderResult = {
        durationMs: 12_000,
        syncDriftMs: 8,
        sayStartsMs: [0, 4000, 8000],
        tapeStartsMs: [0, 4000, 8000],
      };
      return result;
    },
  };
  return { renderer, calls, release: () => gates.shift()?.() };
}

describe('ExportJobs', () => {
  it('queues, renders one at a time, and persists ready with the file size', async () => {
    const { sessionsDir, session } = fixture();
    session('a');
    session('b');
    const fake = fakeRenderer();
    const events: string[] = [];
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fake.renderer,
      onEvent: (name) => events.push(name),
    });
    const a = jobs.request('a');
    const b = jobs.request('b');
    expect(a.status).toBe('queued');
    expect(b.status).toBe('queued');
    await new Promise((r) => setTimeout(r, 20));
    expect(jobs.status('a')?.status).toBe('rendering');
    expect(jobs.status('a')?.progress).toBe(0.5);
    // b waits: strictly one render per process.
    expect(jobs.status('b')?.status).toBe('queued');
    expect(fake.calls).toEqual(['a']);
    fake.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(jobs.status('a')?.status).toBe('ready');
    expect(jobs.status('a')?.bytes).toBe(1024);
    expect(jobs.status('a')?.durationMs).toBe(12_000);
    expect(jobs.status('a')?.syncDriftMs).toBe(8);
    expect(fake.calls).toEqual(['a', 'b']);
    fake.release();
    await jobs.idle();
    expect(jobs.status('b')?.status).toBe('ready');
    expect(events).toEqual(['export.queued', 'export.queued', 'export.ready', 'export.ready']);
    const persisted = JSON.parse(readFileSync(join(sessionsDir, 'a', 'export.json'), 'utf8'));
    expect(persisted.status).toBe('ready');
    expect(persisted.output).toBe(join(sessionsDir, 'a', 'export.mp4'));
  });

  it('is idempotent: a fresh export.mp4 is ready without rendering; a newer ledger renders again', async () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s', 1_000_000);
    const fake = fakeRenderer();
    const jobs = new ExportJobs({ sessionsDir, renderer: fake.renderer });
    // Pre-existing output newer than the ledger (e.g. restored from a backup, no export.json).
    writeFileSync(join(dir, 'export.mp4'), Buffer.alloc(10));
    utimesSync(join(dir, 'export.mp4'), 2_000, 2_000);
    expect(jobs.request('s').status).toBe('ready');
    expect(jobs.request('s').status).toBe('ready');
    expect(fake.calls).toEqual([]);
    // A participant leaving after the end touches the ledger but changes no speech: still fresh.
    appendFileSync(
      join(dir, 'ledger.jsonl'),
      `${JSON.stringify({ kind: 'leave', t: 5_000_000, participantId: 'p_guestguest' })}\n`,
    );
    utimesSync(join(dir, 'ledger.jsonl'), 3_000, 3_000);
    expect(jobs.status('s')?.status).toBe('ready');
    // New speech in the ledger: the file is stale.
    appendFileSync(join(dir, 'ledger.jsonl'), sayLines(2, 2000));
    expect(jobs.status('s')?.status).toBe('stale');
    const again = jobs.request('s');
    expect(again.status).toBe('queued');
    fake.release();
    await jobs.idle();
    expect(fake.calls).toEqual(['s']);
    expect(jobs.status('s')?.status).toBe('ready');
  });

  it('returns the in-flight job for a repeated request instead of enqueueing twice', async () => {
    const { sessionsDir, session } = fixture();
    session('s');
    const fake = fakeRenderer();
    const jobs = new ExportJobs({ sessionsDir, renderer: fake.renderer });
    jobs.request('s');
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.request('s').status).toBe('rendering');
    expect(jobs.pending).toBe(1);
    fake.release();
    await jobs.idle();
    expect(fake.calls).toEqual(['s']);
  });

  it('records a failure for the user, reports the raw error, and lets the next request retry', async () => {
    const { sessionsDir, session } = fixture();
    session('s');
    const failing = fakeRenderer({
      fail: 'ffmpeg failed (exit 1): /srv/data/sessions/s/audio boom',
    });
    const errors: Array<{ area: string; message: string; ref: unknown }> = [];
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: failing.renderer,
      onError: (area, error, data) =>
        errors.push({ area, message: error instanceof Error ? error.message : '', ref: data?.ref }),
    });
    jobs.request('s');
    await new Promise((r) => setTimeout(r, 10));
    failing.release();
    await jobs.idle();
    const failed = jobs.status('s');
    expect(failed?.status).toBe('failed');
    // Users never see paths or tool output; the ref ties the message to the Sentry event.
    expect(failed?.error).toMatch(/^The render failed\. Please try again \(ref [a-z0-9]+\)\.$/);
    expect(failed?.error).not.toContain('/srv');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.area).toBe('export.render');
    expect(errors[0]?.message).toContain('boom');
    expect(failed?.error).toContain(String(errors[0]?.ref));
    expect(jobs.request('s').status).toBe('queued');
    failing.release();
    await jobs.idle();
  });

  const persistedRendering = (pid: number, heartbeatAt: number, sessionId = 's') => ({
    sessionId,
    status: 'rendering',
    progress: 0.4,
    error: null,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    output: null,
    bytes: null,
    durationMs: null,
    syncDriftMs: null,
    ledgerFingerprint: null,
    pid,
    heartbeatAt,
  });

  const persistedQueued = (pid: number, heartbeatAt: number, createdAt = 1, sessionId = 's') => ({
    ...persistedRendering(pid, heartbeatAt, sessionId),
    status: 'queued',
    progress: 0,
    startedAt: null,
    createdAt,
  });

  it('queues a persisted queued job again after a restart instead of calling it interrupted', async () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    writeFileSync(join(dir, 'export.json'), JSON.stringify(persistedQueued(4242, 1_000)));
    const fake = fakeRenderer();
    const events: Array<{ name: string; resumed: unknown }> = [];
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fake.renderer,
      pid: 1,
      onEvent: (name, data) => events.push({ name, resumed: data.resumed }),
    });
    const st = jobs.status('s');
    expect(st?.status).toBe('queued');
    expect(st?.pid).toBe(1);
    expect(events[0]).toEqual({ name: 'export.queued', resumed: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.status('s')?.status).toBe('rendering');
    fake.release();
    await jobs.idle();
    expect(jobs.status('s')?.status).toBe('ready');
    expect(fake.calls).toEqual(['s']);
  });

  it('resume() picks up every cold queued job on disk, oldest first, and nothing else', async () => {
    const { sessionsDir, session } = fixture();
    const a = session('a');
    const b = session('b');
    const c = session('c');
    const d = session('d');
    session('e');
    writeFileSync(join(a, 'export.json'), JSON.stringify(persistedQueued(4242, 1_000, 200, 'a')));
    writeFileSync(join(b, 'export.json'), JSON.stringify(persistedQueued(4242, 1_000, 100, 'b')));
    // Rendering when the old process died: reported as interrupted, not re-run.
    writeFileSync(join(c, 'export.json'), JSON.stringify(persistedRendering(4242, 1_000, 'c')));
    // Queued by another process that is still alive: left alone.
    const now = 10_000_000;
    writeFileSync(join(d, 'export.json'), JSON.stringify(persistedQueued(7, now - 5_000, 1, 'd')));
    const fake = fakeRenderer();
    const events: string[] = [];
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fake.renderer,
      pid: 1,
      now: () => now,
      onEvent: (name) => events.push(name),
    });
    expect(jobs.resume()).toEqual(['b', 'a']);
    expect(events).toEqual(['export.queued', 'export.queued', 'export.resumed']);
    expect(jobs.pending).toBe(2);
    expect(jobs.status('c')?.status).toBe('failed');
    expect(jobs.status('d')?.status).toBe('queued');
    expect(jobs.status('d')?.pid).toBe(7);
    expect(jobs.status('e')).toBeNull();
    // A second resume is a no-op.
    expect(jobs.resume()).toEqual([]);
    fake.release();
    await new Promise((r) => setTimeout(r, 20));
    fake.release();
    await jobs.idle();
    expect(fake.calls).toEqual(['b', 'a']);
    expect(jobs.status('a')?.status).toBe('ready');
    expect(jobs.status('b')?.status).toBe('ready');
  });

  it('with resumeQueued off (no renderer here) a cold queued job reads as interrupted', () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    writeFileSync(join(dir, 'export.json'), JSON.stringify(persistedQueued(4242, 1_000)));
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fakeRenderer().renderer,
      pid: 1,
      resumeQueued: false,
    });
    expect(jobs.resume()).toEqual([]);
    const st = jobs.status('s');
    expect(st?.status).toBe('failed');
    expect(st?.error).toMatch(/interrupted/);
  });

  it('treats a persisted rendering record with a cold heartbeat as a crashed process', () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    writeFileSync(join(dir, 'export.json'), JSON.stringify(persistedRendering(4242, 1_000)));
    const jobs = new ExportJobs({ sessionsDir, renderer: fakeRenderer().renderer, pid: 1 });
    const st = jobs.status('s');
    expect(st?.status).toBe('failed');
    expect(st?.error).toMatch(/interrupted/);
  });

  it('leaves another live process’s rendering job alone while its heartbeat is warm', () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    const now = 10_000_000;
    writeFileSync(join(dir, 'export.json'), JSON.stringify(persistedRendering(4242, now - 5_000)));
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fakeRenderer().renderer,
      pid: 1,
      now: () => now,
    });
    expect(jobs.status('s')?.status).toBe('rendering');
    // Asking again does not start a second render here.
    expect(jobs.request('s').status).toBe('rendering');
    expect(jobs.pending).toBe(0);
  });

  it('refuses when the queue is full, the session is too long, or there is no ledger', async () => {
    const { sessionsDir, session } = fixture();
    session('a');
    session('b');
    const long = session('long');
    writeFileSync(join(long, 'ledger.jsonl'), sayLines(1, 20 * 60_000));
    mkdirSync(join(sessionsDir, 'empty'), { recursive: true });
    const fake = fakeRenderer();
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: fake.renderer,
      maxQueue: 1,
      maxSpokenMs: 15 * 60_000,
    });
    jobs.request('a');
    let refused: unknown = null;
    try {
      jobs.request('b');
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(ExportRefused);
    expect((refused as ExportRefused).code).toBe('QUEUE_FULL');
    expect(() => jobs.request('long')).toThrow(/15 minutes/);
    expect(() => jobs.request('empty')).toThrow(ExportRefused);
    fake.release();
    await jobs.idle();
  });

  it('a ready record whose file is gone is no longer ready', async () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    const fake = fakeRenderer();
    const jobs = new ExportJobs({ sessionsDir, renderer: fake.renderer });
    jobs.request('s');
    await new Promise((r) => setTimeout(r, 10));
    fake.release();
    await jobs.idle();
    expect(jobs.status('s')?.status).toBe('ready');
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'export.mp4'));
    expect(jobs.status('s')?.status).not.toBe('ready');
  });

  it('close() aborts the active render and drops the queue', async () => {
    const { sessionsDir, session } = fixture();
    session('a');
    session('b');
    const aborted: string[] = [];
    const renderer: Renderer = {
      render: ({ sessionId, signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            aborted.push(sessionId);
            reject(new Error('aborted'));
          }),
        ),
    };
    const jobs = new ExportJobs({ sessionsDir, renderer });
    jobs.request('a');
    jobs.request('b');
    await new Promise((r) => setTimeout(r, 10));
    jobs.close();
    await jobs.idle();
    expect(aborted).toEqual(['a']);
    expect(jobs.status('a')?.status).toBe('failed');
    expect(jobs.status('a')?.error).toMatch(/cancelled/);
    expect(jobs.status('b')?.status).toBe('queued');
  });
});
