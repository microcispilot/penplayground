import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerEntry } from '@pen/contracts';
import { z } from 'zod';
import { safeId } from '../ledger.js';

export const ExportStatus = z.enum(['queued', 'rendering', 'ready', 'failed', 'stale']);
export type ExportStatus = z.infer<typeof ExportStatus>;

/** Persisted as `<data>/sessions/<id>/export.json`; the in-memory copy is the source of truth while the process lives. */
export const ExportJobRecord = z.object({
  sessionId: z.string(),
  status: ExportStatus,
  /** 0–1. */
  progress: z.number().min(0).max(1),
  /** User-facing reason when failed; never a path or a raw tool message. */
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
  /** Fingerprint of the render-relevant ledger content (cues + audio) the file was made from. */
  ledgerFingerprint: z.string().nullable(),
  /** Which process is (or was) rendering, and when it last reported progress. */
  pid: z.number().int().nullable(),
  heartbeatAt: z.number().int().nullable(),
});
export type ExportJobRecord = z.infer<typeof ExportJobRecord>;

export interface RenderResult {
  /** Length on the page's clock (what the replay reported), ms. */
  durationMs: number;
  /** Recording clock minus page clock over the whole render; null when the closing curtain was not found. */
  syncDriftMs: number | null;
  /** Page-clock offsets (ms) at which each say started, in play order. */
  sayStartsMs: number[];
  /** The same offsets on the recording's clock (drift-corrected): where the audio was actually placed. */
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

/** Why a request was refused (mapped to HTTP by the route). */
export class ExportRefused extends Error {
  constructor(
    readonly code: 'QUEUE_FULL' | 'TOO_LONG' | 'NO_LEDGER',
    message: string,
  ) {
    super(message);
  }
}

/** A renderer may throw this to give the user a precise reason without leaking internals. */
export class RenderError extends Error {
  constructor(
    readonly userMessage: string,
    detail: string,
  ) {
    super(detail);
  }
}

export interface ExportJobsOptions {
  /** `<data>/sessions`. */
  sessionsDir: string;
  renderer: Renderer;
  /** Queue depth (queued + rendering) beyond which requests are refused. */
  maxQueue?: number;
  /** Longest spoken length accepted, ms. */
  maxSpokenMs?: number;
  /** A persisted rendering job whose heartbeat is older than this belongs to a dead process. */
  staleHeartbeatMs?: number;
  now?: () => number;
  pid?: number;
  onEvent?: (name: string, data: Record<string, number | boolean | string>) => void;
  onError?: (
    area: string,
    error: unknown,
    data?: Record<string, number | boolean | string>,
  ) => void;
}

const FILE = 'export.json';
const OUTPUT = 'export.mp4';
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_MAX_SPOKEN_MS = 45 * 60_000;
const DEFAULT_STALE_HEARTBEAT_MS = 10 * 60_000;

/**
 * One render at a time per process; jobs persisted next to the session's
 * ledger so a restart never loses a finished file and a dead process's
 * "rendering" record is recognised for what it is (stale heartbeat), while a
 * live sibling process's job is left alone. Idempotent: an `export.mp4` made
 * from the ledger's current cues + audio is `ready` without rendering; a
 * ledger with new speech renders again.
 */
export class ExportJobs {
  private readonly jobs = new Map<string, ExportJobRecord>();
  private readonly queue: string[] = [];
  private active: { sessionId: string; abort: AbortController } | null = null;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly fingerprints = new Map<
    string,
    { mtimeMs: number; value: string; spokenMs: number }
  >();
  private closed = false;

  constructor(private readonly o: ExportJobsOptions) {
    this.now = o.now ?? (() => Date.now());
    this.pid = o.pid ?? process.pid;
  }

  /**
   * Enqueue, or return the current job when one is already queued, rendering,
   * or the file is fresh. Throws `ExportRefused` when the queue is full, the
   * session has too much speech to render, or has no ledger.
   */
  request(sessionId: string): ExportJobRecord {
    const current = this.status(sessionId);
    if (current && (current.status === 'queued' || current.status === 'rendering')) return current;
    if (current?.status === 'ready') return current;
    const ledger = this.ledger(sessionId);
    if (!ledger) throw new ExportRefused('NO_LEDGER', 'This session has nothing to export.');
    const maxSpoken = this.o.maxSpokenMs ?? DEFAULT_MAX_SPOKEN_MS;
    if (ledger.spokenMs > maxSpoken)
      throw new ExportRefused(
        'TOO_LONG',
        `Sessions longer than ${Math.round(maxSpoken / 60_000)} minutes cannot be exported yet.`,
      );
    if (this.pending >= (this.o.maxQueue ?? DEFAULT_MAX_QUEUE))
      throw new ExportRefused(
        'QUEUE_FULL',
        'Too many videos are rendering right now. Try again in a few minutes.',
      );
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
      ledgerFingerprint: ledger.value,
      pid: this.pid,
      heartbeatAt: this.now(),
    };
    this.save(job);
    this.queue.push(sessionId);
    this.o.onEvent?.('export.queued', { sessionId, depth: this.queue.length });
    this.pump();
    return job;
  }

  /**
   * Current state, consulting (in order) memory, the persisted record, and the
   * files on disk. A persisted `rendering`/`queued` whose heartbeat went cold
   * belongs to a process that died: reported as failed so the client can ask
   * again; a warm one is another process's live job and is returned as is.
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
      const warm =
        persisted.pid !== this.pid &&
        persisted.heartbeatAt !== null &&
        this.now() - persisted.heartbeatAt <
          (this.o.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS);
      if (warm) return persisted;
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

  /**
   * What the export depends on: the say cues and the audio chunks. Participant
   * joins/leaves after the session ended must not invalidate a finished file.
   * Recomputed only when the ledger file's mtime moves.
   */
  private ledger(sessionId: string): { value: string; spokenMs: number } | null {
    const p = join(this.o.sessionsDir, safeId(sessionId), 'ledger.jsonl');
    if (!existsSync(p)) return null;
    const mtimeMs = statSync(p).mtimeMs;
    const cached = this.fingerprints.get(sessionId);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let cues = 0;
    let audio = 0;
    let lastAudioT = 0;
    const ends = new Map<string, number>();
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let parsed: LedgerEntry;
      try {
        const r = LedgerEntry.safeParse(JSON.parse(line));
        if (!r.success) continue;
        parsed = r.data;
      } catch {
        continue;
      }
      if (parsed.kind === 'cue' && parsed.cue.event.type === 'say') cues += 1;
      if (parsed.kind === 'audio') {
        audio += 1;
        lastAudioT = Math.max(lastAudioT, parsed.t);
        const key = `${parsed.header.sayId}@${parsed.header.take}`;
        ends.set(
          key,
          Math.max(ends.get(key) ?? 0, parsed.header.audioClockMs + parsed.header.durationMs),
        );
      }
    }
    // Last take per say, like the replay (an upper bound: says without audio add their estimate later).
    const lastTake = new Map<string, number>();
    for (const key of ends.keys()) {
      const at = key.lastIndexOf('@');
      const id = key.slice(0, at);
      lastTake.set(id, Math.max(lastTake.get(id) ?? 0, Number(key.slice(at + 1))));
    }
    let spokenMs = 0;
    for (const [id, take] of lastTake) spokenMs += ends.get(`${id}@${take}`) ?? 0;
    const entry = {
      mtimeMs,
      value: `${cues}:${audio}:${lastAudioT}:${Math.round(spokenMs)}`,
      spokenMs,
    };
    this.fingerprints.set(sessionId, entry);
    return entry;
  }

  /** A `ready` record whose file vanished or whose speech changed is stale (persisted so polls stop churning). */
  private validate(job: ExportJobRecord): ExportJobRecord {
    if (job.status !== 'ready') return job;
    const out = this.outputPath(job.sessionId);
    const current = this.ledger(job.sessionId)?.value ?? null;
    const stale =
      !existsSync(out) ||
      (current !== null && job.ledgerFingerprint !== null && current !== job.ledgerFingerprint);
    if (!stale) return job;
    return this.save({ ...job, status: 'stale', error: null, output: null, bytes: null });
  }

  /** An `export.mp4` newer than the ledger with no record (e.g. restored from backup) counts as ready. */
  private freshOutput(sessionId: string): ExportJobRecord | null {
    const out = this.outputPath(sessionId);
    if (!existsSync(out)) return null;
    const st = statSync(out);
    const ledgerFile = join(this.o.sessionsDir, safeId(sessionId), 'ledger.jsonl');
    if (existsSync(ledgerFile) && statSync(ledgerFile).mtimeMs > st.mtimeMs) return null;
    return {
      sessionId,
      status: 'ready',
      progress: 1,
      error: null,
      createdAt: Math.round(st.mtimeMs),
      startedAt: null,
      finishedAt: Math.round(st.mtimeMs),
      output: out,
      bytes: st.size,
      durationMs: null,
      syncDriftMs: null,
      ledgerFingerprint: this.ledger(sessionId)?.value ?? null,
      pid: null,
      heartbeatAt: null,
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
    return this.save({ ...job, ...patch, heartbeatAt: this.now() });
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
    this.update(sessionId, { status: 'rendering', startedAt, progress: 0.01, pid: this.pid });
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
        ledgerFingerprint: this.ledger(sessionId)?.value ?? null,
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
      const renderMs = this.now() - startedAt;
      if (signal.aborted) {
        // A deliberate stop (shutdown), not a failure worth a Sentry issue.
        this.o.onEvent?.('export.cancelled', { sessionId, renderMs });
        this.update(sessionId, {
          status: 'failed',
          finishedAt: this.now(),
          error: 'The render was cancelled.',
        });
        return;
      }
      const ref = Math.random().toString(36).slice(2, 8);
      this.o.onError?.('export.render', error, { sessionId, renderMs, ref });
      this.update(sessionId, {
        status: 'failed',
        finishedAt: this.now(),
        // Users see a reason, never a path or a tool's stderr; `ref` finds the Sentry event.
        error:
          error instanceof RenderError
            ? error.userMessage
            : `The render failed. Please try again (ref ${ref}).`,
      });
    }
  }
}
