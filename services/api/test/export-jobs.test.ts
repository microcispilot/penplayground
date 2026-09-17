import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportJobs, type Renderer, type RenderResult } from '../src/export/jobs.js';

function fixture() {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pen-export-jobs-'));
  const session = (id: string, ledgerAt = 1_000_000) => {
    const dir = join(sessionsDir, id);
    mkdirSync(join(dir, 'audio'), { recursive: true });
    writeFileSync(join(dir, 'ledger.jsonl'), '{"kind":"join"}\n');
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
    // The ledger moves on (the session was appended to): the file is stale.
    utimesSync(join(dir, 'ledger.jsonl'), 3_000, 3_000);
    expect(jobs.status('s')?.status).not.toBe('ready');
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

  it('records a failure with its message, reports it, and lets the next request retry', async () => {
    const { sessionsDir, session } = fixture();
    session('s');
    const failing = fakeRenderer({ fail: 'ffmpeg failed (exit 1): boom' });
    const errors: string[] = [];
    const jobs = new ExportJobs({
      sessionsDir,
      renderer: failing.renderer,
      onError: (area) => errors.push(area),
    });
    jobs.request('s');
    await new Promise((r) => setTimeout(r, 10));
    failing.release();
    await jobs.idle();
    const failed = jobs.status('s');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('boom');
    expect(errors).toEqual(['export.render']);
    expect(jobs.request('s').status).toBe('queued');
    failing.release();
    await jobs.idle();
  });

  it('treats a persisted rendering/queued record from a previous process as failed', () => {
    const { sessionsDir, session } = fixture();
    const dir = session('s');
    writeFileSync(
      join(dir, 'export.json'),
      JSON.stringify({
        sessionId: 's',
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
        ledgerMtimeMs: null,
      }),
    );
    const jobs = new ExportJobs({ sessionsDir, renderer: fakeRenderer().renderer });
    const st = jobs.status('s');
    expect(st?.status).toBe('failed');
    expect(st?.error).toMatch(/interrupted/);
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
