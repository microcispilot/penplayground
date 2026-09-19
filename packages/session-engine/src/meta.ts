import { createHash } from 'node:crypto';
import type {
  Expert,
  KeyOwner,
  LessonPlan,
  SelectionBand,
  SessionMeta,
  TelemetryPort,
  ThumbnailQuality,
} from '@pen/contracts';
import {
  freshEstimateUsd,
  freshThumbnailUsd,
  ModelSessionMeta,
  normaliseSessionMeta,
  SessionMeta as SessionMetaSchema,
  THUMBNAIL_SIZE,
} from '@pen/contracts';
import {
  type ImageModel,
  type ImageUsage,
  type LanguageModel,
  type Usage,
  withImageTelemetry,
  withTelemetry,
} from '@pen/llm';
import { metaMessages, thumbnailImagePrompt } from './prompts.js';
import { type RoomObserver, SILENT_OBSERVER } from './transport.js';

/**
 * Background session metadata (ADR-0013, amended by ADR-0021 and ADR-0022):
 * once a room has its plan, two background calls produce the catalogue card.
 *
 *   the copy     one cheap structured-output call → description, keywords,
 *                category, and the picture's subject
 *   the picture  one `gpt-image-1` generation from the title and that subject
 *
 * They still fail apart — a session whose picture never arrives keeps its
 * copy, and a copy that never arrives still leaves a paid-for picture in the
 * cache — but they are no longer quite independent: the picture wants the
 * subject the copy call names (ADR-0022), so a generation waits for it. The
 * dependency is one-way and optional. The cache lookup happens first and needs
 * nothing, so a reused picture waits for nothing; and a copy that fails or
 * names nothing usable yields `''`, which is ADR-0021's title-only prompt.
 * Each call retries once. The queue never blocks a session — `enqueue` returns
 * at once — and bounds the fan-out so a burst of new sessions cannot starve
 * the turn loop's budget.
 *
 * **Both calls bill to the host's plan key**, the one the lesson itself ran on
 * (`input.billTo`). A free learner's card must not be drawn on a paying
 * tier's budget, nor the reverse: that is what makes per-plan spend readable
 * and keeps one tier's rate limit out of another's way.
 */

export const META_PURPOSE = 'session_meta';
export const THUMBNAIL_PURPOSE = 'session_thumbnail';
export const META_MAX_OUTPUT_TOKENS = 400;

export interface SessionMetaInput {
  sessionId: string;
  expert: Expert;
  band: SelectionBand;
  topic: string;
  plan: LessonPlan;
  /** BCP-47 session language (labels and copy follow it). */
  language: string;
  /**
   * Whose key both calls bill to. For a room it is the HOST'S plan — the same
   * key `modelFor(plan)` gave the lesson, never the platform's, because this
   * work belongs to that learner's session. `platform` is only for work that
   * belongs to no learner: the backfill passes it, a room never does.
   */
  billTo: KeyOwner;
  /**
   * `${lang}.${slug}` from the Onten registry. It is the lesson memo's scope,
   * so it is also the cache's: the same topic, band, persona and language
   * describe the same card. Absent (a topic that never resolved) = no cache.
   */
  canonicalId?: string;
  /** The room's cache key so the shared persona prefix hits the prompt cache. */
  cacheKey: string;
  /**
   * The session's telemetry port (ADR-0011): the copy call lands as one `llm`
   * stage sample with its `CostLine`s under purpose `session_meta`, the
   * picture as one `image` sample with its lines under `session_thumbnail`.
   * The Insights tab and the cost totals therefore include both.
   */
  telemetry?: TelemetryPort;
}

/** The picture a session ended up with, generated or reused. */
export interface SessionThumbnail {
  /** PNG bytes at `THUMBNAIL_SIZE`; every displayed size is a downscale of these. */
  png: Buffer;
  /** The generation's usage, or null when the picture came off the cache. */
  usage: ImageUsage | null;
  reused: boolean;
  /** What generating it fresh would have cost (0 when it was generated). */
  savedUsd: number;
  /**
   * Wall time from the job being dequeued to these bytes being in hand — so
   * since ADR-0022 it includes the wait for the copy call's `subject`, which
   * `session_thumbnail.done` reports separately as `copyWaitMs`. The
   * generation's own duration is `usage.totalMs`; the two differ by design.
   */
  ms: number;
  attempts: number;
}

export interface SessionMetaResult {
  meta: SessionMeta;
  usage: Usage;
  attempts: number;
  /** Wall time from dequeue to the validated result, ms. */
  ms: number;
  /** The copy was served from the cache: the same lesson already has a card. */
  reused: boolean;
  /** What the reused copy AND the reused picture would have cost to make (0 for what was made). */
  savedUsd: number;
  /** The picture, or null when both its attempts failed; the session keeps its placeholder. */
  image: SessionThumbnail | null;
}

/**
 * The copy cache's key. `scope` is the lesson memo's scope — the same
 * canonical topic, band, persona and language yield the same card — and
 * `planDigest` is the lesson the card describes, so a memo (or plan) that
 * changed misses and the copy is written again.
 */
export interface SessionMetaCacheKey {
  scope: string;
  planDigest: string;
}

export interface CachedSessionMeta {
  meta: SessionMeta;
  planDigest: string;
  /** What the original call cost (USD), so a reuse reports exactly what it saved. */
  usd: number;
  model: string;
}

/**
 * Where generated cards are kept between sessions (ADR-0013). One entry per
 * scope: a new plan for the same scope replaces the old card rather than
 * growing the file. The API implements it on disk next to the lesson memo.
 */
export interface SessionMetaCachePort {
  get(key: SessionMetaCacheKey): Promise<CachedSessionMeta | null>;
  put(key: SessionMetaCacheKey, value: CachedSessionMeta): Promise<void>;
}

/**
 * The picture cache's key. `scope` is the lesson memo's scope again — a topic
 * taught before must not be paid for twice — but the digest is of the TITLE,
 * not of the plan: the title is the whole prompt, so a re-planned lesson with
 * the same title would get a picture indistinguishable from the one we hold.
 */
export interface ThumbnailImageCacheKey {
  scope: string;
  titleDigest: string;
}

export interface CachedThumbnailImage {
  png: Buffer;
  /** What the original generation cost (USD); a reuse reports exactly that as saved. */
  usd: number;
  model: string;
  quality: ThumbnailQuality;
}

/**
 * Pictures already generated, kept between sessions and keyed by scope. The
 * bytes are the only copy worth holding — every rendered size is a downscale
 * of them — so the API implements this as files beside the lesson memo rather
 * than inside the card cache's JSON.
 */
export interface ThumbnailImageCachePort {
  get(key: ThumbnailImageCacheKey): Promise<CachedThumbnailImage | null>;
  put(key: ThumbnailImageCacheKey, value: CachedThumbnailImage): Promise<void>;
}

/** The scope a card is cached under: the lesson memo's key plus the language the copy is written in. */
export function sessionMetaScope(input: {
  canonicalId: string;
  band: SelectionBand;
  expertId: string;
  language: string;
}): string {
  return [input.canonicalId, input.band, input.expertId, input.language].join('|');
}

function digest(material: string): string {
  return createHash('sha256').update(material).digest('base64url').slice(0, 22);
}

/**
 * Everything of the lesson that reaches the copy prompt: a card describes this
 * plan, so anything else changing (a re-planned memo, a renamed segment)
 * must miss.
 */
export function planDigest(plan: LessonPlan): string {
  return digest(
    [
      plan.title,
      plan.promise,
      plan.band,
      ...plan.segments.map((s) => `${s.index}:${s.title}`),
    ].join(' '),
  );
}

/** Everything of the lesson that reaches the picture prompt: the title, and nothing else. */
export function thumbnailDigest(plan: LessonPlan): string {
  return digest(plan.title);
}

function cacheKeyOf(input: SessionMetaInput): SessionMetaCacheKey | null {
  const scope = scopeOf(input);
  if (!scope) return null;
  return { scope, planDigest: planDigest(input.plan) };
}

/**
 * One picture per topic, even when two sessions ask at the same instant.
 *
 * The cache stops the *second* session paying — but only once the first has
 * finished and written it. Two learners starting the same topic seconds apart
 * both miss the cache, both commission a photograph, and at ~$0.016 each that
 * is the most expensive thing in a session bought twice. Measured on
 * production: two sessions on one topic, `imageReused: false` on both.
 *
 * So a generation claims its key while it runs, and anyone else who wants that
 * key waits for it and then reads the cache like any other reuse. The claim is
 * per process, which is what this deployment is; a second API node would need
 * a shared lock, and the cache read on either side still prevents a third
 * payment.
 */
const PICTURE_IN_FLIGHT = new Map<string, Promise<unknown>>();

const imageKeyString = (key: ThumbnailImageCacheKey): string =>
  `${key.scope}\u0000${key.titleDigest}`;

function imageKeyOf(input: SessionMetaInput): ThumbnailImageCacheKey | null {
  const scope = scopeOf(input);
  if (!scope) return null;
  return { scope, titleDigest: thumbnailDigest(input.plan) };
}

function scopeOf(input: SessionMetaInput): string | null {
  if (!input.canonicalId) return null;
  return sessionMetaScope({
    canonicalId: input.canonicalId,
    band: input.band,
    expertId: input.expert.id,
    language: input.language,
  });
}

export interface SessionMetaJobsOptions {
  /** The text model on a given key — the host's plan for a room, so the card copy bills where the lesson did. */
  modelFor: (owner: KeyOwner) => LanguageModel;
  /** The image model on the same key, same rule. */
  imageFor: (owner: KeyOwner) => ImageModel;
  /**
   * Picture quality, asked for once per picture rather than held: it is a
   * runtime setting (ADR-0025) and may change between two jobs in the same
   * process. `low` is the default everywhere (docs/COST.md).
   */
  quality: () => ThumbnailQuality;
  /** Consumes a result (render, store, persist). Its failure is reported, never retried. */
  onResult: (input: SessionMetaInput, result: SessionMetaResult) => Promise<void> | void;
  /** Called once when both copy attempts failed; the caller keeps the placeholder thumbnail. */
  onFailure?: (input: SessionMetaInput, error: unknown, attempts: number) => void;
  /** Usage hook per attempt (house accounting, tests); the session's own cost lines come from `input.telemetry`. */
  onUsage?: (input: SessionMetaInput, usage: (Usage | ImageUsage) & { purpose: string }) => void;
  /** Cards already written for this scope; absent = every session pays for its own. */
  cache?: SessionMetaCachePort;
  /** Pictures already generated for this scope; absent = every session pays for its own. */
  imageCache?: ThumbnailImageCachePort;
  concurrency?: number;
  retryDelayMs?: number;
  observer?: RoomObserver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRY_DELAY_MS = 1500;
const ATTEMPTS = 2;

/** What the copy half of a job produced; the picture half reads `meta.subject` off it. */
type CopyResult =
  | {
      ok: true;
      meta: SessionMeta;
      usage: Usage;
      attempts: number;
      reused: boolean;
      savedUsd: number;
    }
  | { ok: false; error: unknown; attempts: number };

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
      plan: input.billTo,
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

  /**
   * The copy already written for this lesson: reuse it with zero model calls
   * and record exactly what that saved (ADR-0011's `reused` / `savedUsd`, the
   * same shape the lesson memo reports). Null when there is nothing to reuse,
   * so the caller generates.
   */
  private async copyFromCache(
    input: SessionMetaInput,
    key: SessionMetaCacheKey,
    started: number,
  ): Promise<{ meta: SessionMeta; usage: Usage; savedUsd: number } | null> {
    const cache = this.o.cache;
    if (!cache) return null;
    let hit: CachedSessionMeta | null = null;
    try {
      hit = await cache.get(key);
    } catch (error) {
      this.observer.error('session_meta.cache_read', error, { sessionId: input.sessionId });
      return null;
    }
    if (!hit) return null;
    const model = this.o.modelFor(input.billTo).id;
    const savedUsd = hit.usd > 0 ? hit.usd : freshEstimateUsd('sessionMeta', model);
    const ms = this.now() - started;
    // The reuse is the session's own telemetry line: one `llm` sample, no cost lines.
    input.telemetry?.sample({
      stage: 'llm',
      ms: 0,
      ok: true,
      meta: {
        purpose: META_PURPOSE,
        model,
        firstTokenMs: -1,
        reused: true,
        memo: true,
        savedUsd,
      },
    });
    this.observer.event('session_meta.reused', { sessionId: input.sessionId, ms, savedUsd });
    return {
      meta: hit.meta,
      usage: {
        model: hit.model,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        usd: 0,
        firstTokenMs: null,
        totalMs: ms,
      },
      savedUsd,
    };
  }

  /** The card copy: cache, else up to two attempts on the host's plan key. */
  private async copy(input: SessionMetaInput, started: number): Promise<CopyResult> {
    const key = cacheKeyOf(input);
    if (key) {
      const hit = await this.copyFromCache(input, key, started);
      if (hit)
        return {
          ok: true,
          meta: hit.meta,
          usage: hit.usage,
          attempts: 0,
          reused: true,
          savedUsd: hit.savedUsd,
        };
    }
    const base = this.o.modelFor(input.billTo);
    // The model is shared by every session on that plan; the port is not, so the wrap is per job.
    const model = input.telemetry ? withTelemetry(base, input.telemetry) : base;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const { value, usage } = await model.complete({
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
        if (key && this.o.cache) {
          try {
            await this.o.cache.put(key, {
              meta,
              planDigest: key.planDigest,
              usd: usage.usd,
              model: usage.model,
            });
          } catch (error) {
            this.observer.error('session_meta.cache_write', error, { sessionId: input.sessionId });
          }
        }
        return { ok: true, meta, usage, attempts: attempt, reused: false, savedUsd: 0 };
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
        this.observer.error('session_meta.failed', error, {
          sessionId: input.sessionId,
          attempts: attempt,
        });
        return { ok: false, error, attempts: attempt };
      }
    }
    return { ok: false, error: lastError, attempts: ATTEMPTS };
  }

  /**
   * A picture already generated for this lesson: reuse its bytes, pay nothing
   * and say what that saved. Null when there is nothing to reuse.
   */
  private async pictureFromCache(
    input: SessionMetaInput,
    key: ThumbnailImageCacheKey,
    started: number,
  ): Promise<SessionThumbnail | null> {
    const cache = this.o.imageCache;
    if (!cache) return null;
    let hit: CachedThumbnailImage | null = null;
    try {
      hit = await cache.get(key);
    } catch (error) {
      this.observer.error('session_thumbnail.cache_read', error, { sessionId: input.sessionId });
      return null;
    }
    if (!hit) return null;
    const model = this.o.imageFor(input.billTo).id;
    const savedUsd = hit.usd > 0 ? hit.usd : freshThumbnailUsd(model, hit.quality);
    const ms = this.now() - started;
    // One `image` sample, no cost lines: nothing was bought. `savedUsd` on a
    // `reused` sample is what the reuse statistics are summed from.
    input.telemetry?.sample({
      stage: 'image',
      ms: 0,
      ok: true,
      meta: {
        purpose: THUMBNAIL_PURPOSE,
        model,
        quality: hit.quality,
        bytes: hit.png.length,
        reused: true,
        savedUsd,
      },
    });
    this.observer.event('session_thumbnail.reused', {
      sessionId: input.sessionId,
      ms,
      bytes: hit.png.length,
      savedUsd,
    });
    return { png: hit.png, usage: null, reused: true, savedUsd, ms, attempts: 0 };
  }

  /**
   * The thing to point a camera at (ADR-0022), waited for only once a
   * generation is certain. Never rejects and never throws: a copy call that
   * failed, or that named nothing a lens could find, is worth a title-only
   * picture and not worth losing one over.
   */
  private async subjectFrom(copy: Promise<CopyResult>): Promise<string> {
    try {
      const result = await copy;
      return result.ok ? result.meta.subject : '';
    } catch {
      return '';
    }
  }

  /**
   * The picture: cache, else up to two generations on the host's plan key.
   * Exactly one API call per session that misses the cache — every rendered
   * size is a downscale of the bytes it returns, never a second generation.
   * A failure is not fatal: the session keeps its deterministic placeholder.
   *
   * The cache is consulted before `copy` is awaited, so a reused picture costs
   * nothing and waits for nothing. Only a generation waits, and only for the
   * one field it needs.
   */
  private async picture(
    input: SessionMetaInput,
    started: number,
    copy: Promise<CopyResult>,
  ): Promise<SessionThumbnail | null> {
    const key = imageKeyOf(input);
    if (key) {
      const hit = await this.pictureFromCache(input, key, started);
      if (hit) return hit;
      // Missed, but someone else may already be buying this very picture.
      const running = PICTURE_IN_FLIGHT.get(imageKeyString(key));
      if (running) {
        await running.catch(() => undefined);
        const shared = await this.pictureFromCache(input, key, started);
        // `shared` takes the ordinary reuse path — same telemetry, same
        // savedUsd. If the other session failed, we fall through and buy it.
        if (shared) return shared;
      }
    }
    // Claim the key before anything else can yield.
    //
    // This has to happen in the same tick as the miss above. Put it after the
    // next `await` — waiting for the card copy, say — and both sessions sail
    // past the check before either has claimed, which is exactly how the first
    // version of this failed its own test: two generations, not one.
    const claim = key ? imageKeyString(key) : null;
    let release = () => undefined as void;
    // Hold on to our own promise so the release below can tell whether the
    // claim still belongs to us. Two generators can both reach here — one
    // checked the map a tick before the other set it — and without this the
    // first to finish deletes the *other's* claim, leaving a third session to
    // see an unclaimed key and buy the picture again.
    const mine = claim
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;
    if (claim && mine) PICTURE_IN_FLIGHT.set(claim, mine);
    const base = this.o.imageFor(input.billTo);
    const model = input.telemetry ? withImageTelemetry(base, input.telemetry) : base;
    // One read for this picture: the attempt, the cache entry and the event
    // all say the quality it was actually drawn at.
    const quality = this.o.quality();
    const waitFrom = this.now();
    const subject = await this.subjectFrom(copy);
    const copyWaitMs = this.now() - waitFrom;
    const prompt = thumbnailImagePrompt(input.plan.title, subject);
    try {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const { png, usage } = await model.generate({
            prompt,
            size: THUMBNAIL_SIZE,
            quality,
            purpose: THUMBNAIL_PURPOSE,
          });
          this.o.onUsage?.(input, { ...usage, purpose: THUMBNAIL_PURPOSE });
          // Cached before the copy call is even known to have worked: a picture
          // that is paid for is never thrown away, whatever else the job does.
          if (key && this.o.imageCache) {
            try {
              await this.o.imageCache.put(key, {
                png,
                usd: usage.usd,
                model: usage.model,
                quality,
              });
            } catch (error) {
              this.observer.error('session_thumbnail.cache_write', error, {
                sessionId: input.sessionId,
              });
            }
          }
          this.observer.event('session_thumbnail.done', {
            sessionId: input.sessionId,
            attempts: attempt,
            ms: usage.totalMs,
            bytes: png.length,
            quality,
            outputTokens: usage.outputTokens,
            usd: usage.usd,
            // Whether the camera was given something to point at, and what the
            // wait for it cost. `subject: false` on a run of sessions is the
            // signal that ADR-0022's field has stopped arriving.
            subject: subject.length > 0,
            copyWaitMs: Math.round(copyWaitMs),
          });
          return {
            png,
            usage,
            reused: false,
            savedUsd: 0,
            ms: this.now() - started,
            attempts: attempt,
          };
        } catch (error) {
          if (attempt < ATTEMPTS && !this.closed) {
            this.observer.event('session_thumbnail.retry', {
              sessionId: input.sessionId,
              attempt,
              reason: error instanceof Error ? error.message.slice(0, 120) : String(error),
            });
            await this.sleep(this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
            continue;
          }
          this.observer.error('session_thumbnail.failed', error, {
            sessionId: input.sessionId,
            attempts: attempt,
          });
          return null;
        }
      }
    } finally {
      // Whatever happened, stop anyone else waiting on us.
      if (claim) {
        // Only ours, never someone else's.
        if (PICTURE_IN_FLIGHT.get(claim) === mine) PICTURE_IN_FLIGHT.delete(claim);
        release();
      }
    }
    return null;
  }

  private async run(input: SessionMetaInput): Promise<void> {
    const started = this.now();
    // Two calls to two different endpoints, started together. The picture is
    // handed the copy's promise rather than its result: it checks its own
    // cache first — a reused picture is ready at max(copy, cache read) — and
    // joins the copy only if it is actually going to generate, in which case
    // the card is ready at copy + generation (ADR-0022).
    const copying = this.copy(input, started);
    const [copy, image] = await Promise.all([copying, this.picture(input, started, copying)]);
    if (!copy.ok) {
      // Without copy there is no card to store. The picture is not lost: it is
      // already in the image cache, so the next session on this lesson gets it free.
      this.o.onFailure?.(input, copy.error, copy.attempts);
      return;
    }
    const result: SessionMetaResult = {
      meta: copy.meta,
      usage: copy.usage,
      attempts: copy.attempts,
      ms: this.now() - started,
      reused: copy.reused,
      savedUsd: copy.savedUsd + (image?.savedUsd ?? 0),
      image,
    };
    this.observer.event('session_meta.done', {
      sessionId: input.sessionId,
      plan: input.billTo,
      attempts: copy.attempts,
      ms: result.ms,
      reused: copy.reused,
      imageReused: image?.reused ?? false,
      imageBytes: image?.png.length ?? 0,
      inputTokens: copy.usage.inputTokens,
      cachedTokens: copy.usage.cachedTokens,
      outputTokens: copy.usage.outputTokens,
      usd: copy.usage.usd + (image?.usage?.usd ?? 0),
      savedUsd: result.savedUsd,
    });
    try {
      await this.o.onResult(input, result);
    } catch (error) {
      this.observer.error('session_meta.consume', error, { sessionId: input.sessionId });
    }
  }
}
