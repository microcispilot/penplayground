import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../ledger.js';

export const ExportStatus = z.enum(['queued', 'rendering', 'ready', 'failed']);
export type ExportStatus = z.infer<typeof ExportStatus>;

/** Persisted as `<data>/sessions/<id>/export.json`; the in-memory copy is the source of truth while the process lives. */
export const ExportJobRecord = z.object({
  sessionId: z.string(),
  status: ExportStatus,
  /** 0–1. */
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  /** Absolute path of the finished MP4. */
  output: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  /** ms the export is long; null until ready. */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Measured video/audio drift over the whole render (see render.ts); null when unmeasured. */
  syncDriftMs: z.number().nullable(),
  /** Ledger mtime the render was based on: a newer ledger invalidates the file. */
  ledgerMtimeMs: z.number().nullable(),
});
export type ExportJobRecord = z.infer<typeof ExportJobRecord>;

export interface RenderResult {
  durationMs: number;
  syncDriftMs: number | null;
  /** Page-clock offsets (ms) at which each say started, in play order. */
  sayStartsMs: number[];
  /** The same offsets on the tape's clock (drift-corrected); where the audio was placed. */
  tapeStartsMs: number[];
}

/** The renderer seam: Playwright + ffmpeg in production, a fake in tests. */
export interface Renderer {
  render(input: {
    sessionId: string;
    sessionDir: string;
    outputPath: string;
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
  }): Promise<RenderResult>;
}

export interface ExportJobsOptions {
  /** `<data>/sessions`. */
  sessionsDir: string;
  renderer: Renderer;
  now?: () => number;
  onEvent?: (name: string, data: Record<string, number | boolean | string>) => void;
  onError?: (
    area: string,
    error: unknown,
    data?: Record<string, number | boolean | string>,
  ) => void;
}

const FILE = 'export.json';
const OUTPUT = 'export.mp4';

/**
 * One render at a time per process; jobs persisted next to the session's
 * ledger so a restart never loses a finished file and a stale "rendering"
 * record is recognised for what it is. Idempotent: an `export.mp4` newer than
 * the ledger is `ready` without rendering; a newer ledger renders again.
 */
export class ExportJobs {
  private readonly jobs = new Map<string, ExportJobRecord>();
  private readonly queue: string[] = [];
  private active: { sessionId: string; abort: AbortController } | null = null;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly o: ExportJobsOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  /** Enqueue (or return the current job when one is already queued, rendering, or the file is fresh). */
  request(sessionId: string): ExportJobRecord {
    const current = this.status(sessionId);
    if (current && (current.status === 'queued' || current.status === 'rendering')) return current;
    if (current?.status === 'ready') return current;
    const job: ExportJobRecord = {
      sessionId,
      status: 'queued',
      progress: 0,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      output: null,
      bytes: null,
      durationMs: null,
      syncDriftMs: null,
      ledgerMtimeMs: this.ledgerMtime(sessionId),
    };
    this.save(job);
    this.queue.push(sessionId);
    this.o.onEvent?.('export.queued', { sessionId, depth: this.queue.length });
    this.pump();
    return job;
  }

  /**
   * Current state, consulting (in order) memory, the persisted record, and the
   * files on disk. A persisted `rendering`/`queued` from a previous process is
   * a crash: reported as failed so the client can ask again.
   */
  status(sessionId: string): ExportJobRecord | null {
    const mem = this.jobs.get(sessionId);
    if (mem) return this.validate(mem);
    const persisted = this.load(sessionId);
    if (!persisted) {
      const fresh = this.freshOutput(sessionId);
      return fresh ? this.save(fresh) : null;
    }
    if (persisted.status === 'queued' || persisted.status === 'rendering') {
      return this.save({
        ...persisted,
        status: 'failed',
        error: 'The render was interrupted. Please try again.',
        finishedAt: this.now(),
      });
    }
    return this.validate(this.save(persisted));
  }

  get isBusy(): boolean {
    return this.active !== null;
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** Stop taking work and abort the active render (shutdown). */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.active?.abort.abort();
  }

  /** Resolves when the queue drains (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active || this.queue.length > 0) await new Promise((r) => setTimeout(r, 10));
  }

  private outputPath(sessionId: string): string {
    return join(this.o.sessionsDir, safeId(sessionId), OUTPUT);
  }

  private ledgerMtime(sessionId: string): number | null {
    const p = join(this.o.sessionsDir, safeId(sessionId), 'ledger.jsonl');
    return existsSync(p) ? statSync(p).mtimeMs : null;
  }

  /** A `ready` record whose file vanished or whose ledger moved on is no longer ready. */
  private validate(job: ExportJobRecord): ExportJobRecord {
    if (job.status !== 'ready') return job;
    const out = this.outputPath(job.sessionId);
    const ledger = this.ledgerMtime(job.sessionId);
    const stale =
      !existsSync(out) ||
      (ledger !== null && job.ledgerMtimeMs !== null && ledger > job.ledgerMtimeMs + 1);
    if (!stale) return job;
    this.jobs.delete(job.sessionId);
    return { ...job, status: 'failed', error: null, output: null };
  }

  /** An `export.mp4` newer than the ledger with no record (e.g. restored from backup) counts as ready. */
  private freshOutput(sessionId: string): ExportJobRecord | null {
    const out = this.outputPath(sessionId);
    if (!existsSync(out)) return null;
    const st = statSync(out);
    const ledger = this.ledgerMtime(sessionId);
    if (ledger !== null && ledger > st.mtimeMs) return null;
    return {
      sessionId,
      status: 'ready',
      progress: 1,
      error: null,
      createdAt: st.mtimeMs,
      startedAt: null,
      finishedAt: st.mtimeMs,
      output: out,
      bytes: st.size,
      durationMs: null,
      syncDriftMs: null,
      ledgerMtimeMs: ledger,
    };
  }

  private load(sessionId: string): ExportJobRecord | null {
    const p = join(this.o.sessionsDir, safeId(sessionId), FILE);
    if (!existsSync(p)) return null;
    try {
      const parsed = ExportJobRecord.safeParse(JSON.parse(readFileSync(p, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private save(job: ExportJobRecord): ExportJobRecord {
    this.jobs.set(job.sessionId, job);
    const dir = join(this.o.sessionsDir, safeId(job.sessionId));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, FILE), JSON.stringify(job));
    } catch (error) {
      this.o.onError?.('export.persist', error);
    }
    return job;
  }

  private update(sessionId: string, patch: Partial<ExportJobRecord>): ExportJobRecord | null {
    const job = this.jobs.get(sessionId);
    if (!job) return null;
    return this.save({ ...job, ...patch });
  }

  private pump(): void {
    if (this.closed || this.active) return;
    const sessionId = this.queue.shift();
    if (!sessionId) return;
    const abort = new AbortController();
    this.active = { sessionId, abort };
    void this.run(sessionId, abort.signal).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  private async run(sessionId: string, signal: AbortSignal): Promise<void> {
    const startedAt = this.now();
    this.update(sessionId, { status: 'rendering', startedAt, progress: 0.01 });
    const sessionDir = join(this.o.sessionsDir, safeId(sessionId));
    const outputPath = this.outputPath(sessionId);
    try {
      const result = await this.o.renderer.render({
        sessionId,
        sessionDir,
        outputPath,
        signal,
        onProgress: (fraction) =>
          this.update(sessionId, { progress: Math.min(0.99, Math.max(0.01, fraction)) }),
      });
      const bytes = existsSync(outputPath) ? statSync(outputPath).size : 0;
      if (bytes === 0) throw new Error('renderer produced no output');
      const finishedAt = this.now();
      this.update(sessionId, {
        status: 'ready',
        progress: 1,
        error: null,
        finishedAt,
        output: outputPath,
        bytes,
        durationMs: Math.round(result.durationMs),
        syncDriftMs: result.syncDriftMs,
        ledgerMtimeMs: this.ledgerMtime(sessionId),
      });
      this.o.onEvent?.('export.ready', {
        sessionId,
        renderMs: finishedAt - startedAt,
        durationMs: Math.round(result.durationMs),
        bytes,
        syncDriftMs: result.syncDriftMs ?? -1,
        says: result.sayStartsMs.length,
      });
    } catch (error) {
      this.o.onError?.('export.render', error, { sessionId, renderMs: this.now() - startedAt });
      this.update(sessionId, {
        status: 'failed',
        finishedAt: this.now(),
        error: signal.aborted
          ? 'The render was cancelled.'
          : (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
}
