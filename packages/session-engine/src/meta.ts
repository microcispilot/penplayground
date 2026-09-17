import type { Expert, LessonPlan, SelectionBand, SessionMeta } from '@pen/contracts';
import {
  ModelSessionMeta,
  normaliseSessionMeta,
  SessionMeta as SessionMetaSchema,
} from '@pen/contracts';
import type { LanguageModel, Usage } from '@pen/llm';
import { metaMessages } from './prompts.js';
import { type RoomObserver, SILENT_OBSERVER } from './transport.js';

/**
 * Background session metadata (ADR-0013): once a room has its plan, one
 * cheap structured-output call produces the card description, keywords,
 * category and the thumbnail sketch. The queue never blocks a session —
 * `enqueue` returns at once — and bounds the model fan-out so a burst of
 * new sessions cannot starve the turn loop's budget. Each job retries once
 * on any failure; after that the session keeps its deterministic placeholder.
 */

export const META_PURPOSE = 'session_meta';
export const META_MAX_OUTPUT_TOKENS = 1400;

export interface SessionMetaInput {
  sessionId: string;
  expert: Expert;
  band: SelectionBand;
  topic: string;
  plan: LessonPlan;
  /** BCP-47 session language (labels and copy follow it). */
  language: string;
  /** The room's cache key so the shared persona prefix hits the prompt cache. */
  cacheKey: string;
}

export interface SessionMetaResult {
  meta: SessionMeta;
  usage: Usage;
  attempts: number;
  /** Wall time from dequeue to the validated result, ms. */
  ms: number;
}

export interface SessionMetaJobsOptions {
  model: LanguageModel;
  /** Consumes a result (render, store, persist). Its failure is reported, never retried. */
  onResult: (input: SessionMetaInput, result: SessionMetaResult) => Promise<void> | void;
  /** Called once when both attempts failed; the caller keeps the placeholder thumbnail. */
  onFailure?: (input: SessionMetaInput, error: unknown, attempts: number) => void;
  /** Cost hook: every attempt's usage, so a `CostLine` can be attached when telemetry lands. */
  onUsage?: (input: SessionMetaInput, usage: Usage & { purpose: string }) => void;
  concurrency?: number;
  retryDelayMs?: number;
  observer?: RoomObserver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRY_DELAY_MS = 1500;
const ATTEMPTS = 2;

export class SessionMetaJobs {
  private readonly queue: SessionMetaInput[] = [];
  private readonly known = new Set<string>();
  private readonly observer: RoomObserver;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private running = 0;
  private closed = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly o: SessionMetaJobsOptions) {
    this.observer = o.observer ?? SILENT_OBSERVER;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
  }

  /** Queue a job; duplicates for a session already queued or running are ignored. Never throws. */
  enqueue(input: SessionMetaInput): boolean {
    if (this.closed || this.known.has(input.sessionId)) return false;
    this.known.add(input.sessionId);
    this.queue.push(input);
    this.observer.event('session_meta.queued', {
      sessionId: input.sessionId,
      queued: this.queue.length,
      running: this.running,
    });
    this.pump();
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }

  /** Resolves once nothing is queued or running (tests, graceful shutdown). */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop taking work; queued jobs are dropped, running ones finish. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private pump(): void {
    const limit = Math.max(1, this.o.concurrency ?? DEFAULT_CONCURRENCY);
    while (this.running < limit && this.queue.length > 0) {
      const input = this.queue.shift();
      if (!input) break;
      this.running += 1;
      void this.run(input).finally(() => {
        this.running -= 1;
        this.known.delete(input.sessionId);
        if (this.queue.length === 0 && this.running === 0)
          for (const w of this.idleWaiters.splice(0)) w();
        this.pump();
      });
    }
  }

  private async run(input: SessionMetaInput): Promise<void> {
    const started = this.now();
    let lastError: unknown = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      attempts = attempt;
      try {
        const { value, usage } = await this.o.model.complete({
          messages: metaMessages(input),
          schema: ModelSessionMeta,
          schemaName: 'session_meta',
          cacheKey: input.cacheKey,
          maxOutputTokens: META_MAX_OUTPUT_TOKENS,
          purpose: META_PURPOSE,
        });
        this.o.onUsage?.(input, { ...usage, purpose: META_PURPOSE });
        // Clamp first, then validate: the contract is the guard, not the model.
        const meta = SessionMetaSchema.parse(normaliseSessionMeta(value));
        const result: SessionMetaResult = {
          meta,
          usage,
          attempts: attempt,
          ms: this.now() - started,
        };
        this.observer.event('session_meta.done', {
          sessionId: input.sessionId,
          attempts: attempt,
          ms: result.ms,
          elements: meta.thumbnail.elements.length,
          inputTokens: usage.inputTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          usd: usage.usd,
        });
        try {
          await this.o.onResult(input, result);
        } catch (error) {
          this.observer.error('session_meta.consume', error, { sessionId: input.sessionId });
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS && !this.closed) {
          // A first failure is expected noise (timeouts, 5xx); only the final one is an incident.
          this.observer.event('session_meta.retry', {
            sessionId: input.sessionId,
            attempt,
            reason: error instanceof Error ? error.message.slice(0, 120) : String(error),
          });
          await this.sleep(this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
          continue;
        }
        this.observer.error('session_meta.failed', error, { sessionId: input.sessionId, attempts });
        break;
      }
    }
    this.o.onFailure?.(input, lastError, attempts);
  }
}
