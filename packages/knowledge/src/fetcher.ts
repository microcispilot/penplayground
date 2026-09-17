import type { RobotsGate } from './robots.js';
import type { Budget, KnowledgeObserver } from './types.js';

export interface FetchedPage {
  url: string;
  /** After redirects. */
  finalUrl: string;
  status: number;
  /** Lower-case media type without parameters; '' when the server sent none. */
  contentType: string;
  body: string;
  truncated: boolean;
}

export type SkipReason = 'robots' | 'budget' | 'status' | 'type' | 'aborted' | 'timeout' | 'error';

export type FetchOutcome = { ok: true; page: FetchedPage } | { ok: false; reason: SkipReason; status?: number };

const TEXT_TYPES = /^(text\/|application\/(json|xhtml\+xml|xml|markdown|x-markdown))/;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Per-host spacing: every request to a host is at least `gapMs` after the previous reservation. */
export class HostThrottle {
  private readonly nextAt = new Map<string, number>();
  constructor(
    private readonly gapMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until the host accepts another request (0 when ready). */
  readyIn(host: string): number {
    return Math.max(0, (this.nextAt.get(host) ?? 0) - this.now());
  }

  /** Reserve the next slot; returns how long the caller must wait before sending. */
  reserve(host: string): number {
    const now = this.now();
    const start = Math.max(now, this.nextAt.get(host) ?? 0);
    this.nextAt.set(host, start + this.gapMs);
    return start - now;
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function readBounded(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const charset = /charset=["']?([^;"']+)/i.exec(res.headers.get('content-type') ?? '')?.[1]?.trim() ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { text: decoder.decode(buf.subarray(0, maxBytes)), truncated: buf.byteLength > maxBytes };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: decoder.decode(merged), truncated };
}

export interface FetcherOptions {
  fetchImpl: typeof fetch;
  userAgent: string;
  robots: RobotsGate;
  throttle: HostThrottle;
  budget: Pick<Budget, 'maxPages' | 'timeoutMs' | 'maxPageBytes'>;
  observer: KnowledgeObserver;
  signal: AbortSignal;
}

/**
 * Robots-aware, rate-limited, bounded text fetcher. Every request (documents
 * and mdbook includes alike) goes through the per-host throttle; only
 * documents count toward the page budget.
 */
export class Fetcher {
  private pages = 0;
  constructor(private readonly opts: FetcherOptions) {}

  get pagesFetched(): number {
    return this.pages;
  }

  async get(url: string, options: { api?: boolean; countsTowardBudget?: boolean } = {}): Promise<FetchOutcome> {
    const { signal, observer } = this.opts;
    const counts = options.countsTowardBudget ?? true;
    if (signal.aborted) return { ok: false, reason: 'aborted' };
    if (counts && this.pages >= this.opts.budget.maxPages) return { ok: false, reason: 'budget' };
    try {
      if (!options.api) {
        const allowed = await this.opts.robots.isAllowed(url, signal);
        if (!allowed) {
          observer.event('knowledge.robots_blocked', { url });
          return { ok: false, reason: 'robots' };
        }
      }
      if (counts) {
        if (this.pages >= this.opts.budget.maxPages) return { ok: false, reason: 'budget' };
        this.pages += 1;
      }
      await sleep(this.opts.throttle.reserve(hostOf(url)), signal);
      const res = await this.opts.fetchImpl(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.budget.timeoutMs)]),
        headers: {
          'user-agent': this.opts.userAgent,
          accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1',
          'accept-language': 'en',
        },
        redirect: 'follow',
      });
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'status', status: res.status };
      }
      if (contentType && !TEXT_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'type' };
      }
      const { text, truncated } = await readBounded(res, this.opts.budget.maxPageBytes);
      return { ok: true, page: { url, finalUrl: res.url || url, status: res.status, contentType, body: text, truncated } };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return { ok: false, reason: 'aborted' };
      if (error instanceof Error && error.name === 'TimeoutError') {
        observer.event('knowledge.fetch_timeout', { url, timeoutMs: this.opts.budget.timeoutMs });
        return { ok: false, reason: 'timeout' };
      }
      observer.error('knowledge.fetch', error, { url });
      return { ok: false, reason: 'error' };
    }
  }
}

export interface QueueJob {
  url: string;
  priority: number;
}

/**
 * Priority queue drained by `concurrency` workers. Workers prefer jobs whose
 * host is ready now so one slow host never blocks the others; the throttle
 * itself (inside Fetcher) is the only enforcement point for spacing.
 */
export class FetchQueue<T extends QueueJob> {
  private readonly pending: T[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private alive: number;
  private resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(
    private readonly opts: {
      concurrency: number;
      throttle: HostThrottle;
      run: (job: T) => Promise<void>;
      signal: AbortSignal;
      observer: KnowledgeObserver;
    },
  ) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.alive = Math.max(1, opts.concurrency);
    opts.signal.addEventListener('abort', () => this.wake(), { once: true });
    for (let i = 0; i < this.alive; i++) void this.worker();
  }

  get size(): number {
    return this.pending.length;
  }

  push(job: T): void {
    if (this.closed) return;
    let i = this.pending.length;
    while (i > 0 && (this.pending[i - 1]?.priority ?? 0) > job.priority) i -= 1;
    this.pending.splice(i, 0, job);
    this.wake();
  }

  /** No more jobs will be pushed; `done` resolves once the queue drains. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  private waitForWake(maxMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = maxMs === Number.POSITIVE_INFINITY ? null : setTimeout(() => {
        this.waiters.delete(resolve);
        resolve();
      }, maxMs);
      const wrapped = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.add(wrapped);
    });
  }

  private async next(): Promise<T | null> {
    for (;;) {
      if (this.opts.signal.aborted) return null;
      if (this.pending.length === 0) {
        if (this.closed) return null;
        await this.waitForWake(Number.POSITIVE_INFINITY);
        continue;
      }
      let bestIdx = 0;
      let bestWait = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.pending.length; i++) {
        const job = this.pending[i];
        if (!job) continue;
        const wait = this.opts.throttle.readyIn(hostOf(job.url));
        if (wait <= 0) {
          bestIdx = i;
          bestWait = 0;
          break;
        }
        if (wait < bestWait) {
          bestWait = wait;
          bestIdx = i;
        }
      }
      if (bestWait > 0) {
        await this.waitForWake(bestWait);
        continue;
      }
      const [job] = this.pending.splice(bestIdx, 1);
      if (job) return job;
    }
  }

  private async worker(): Promise<void> {
    try {
      for (;;) {
        const job = await this.next();
        if (!job) break;
        try {
          await this.opts.run(job);
        } catch (error) {
          if (!this.opts.signal.aborted) this.opts.observer.error('knowledge.fetch_job', error, { url: job.url });
        }
      }
    } finally {
      this.alive -= 1;
      if (this.alive === 0) this.resolveDone();
    }
  }
}
