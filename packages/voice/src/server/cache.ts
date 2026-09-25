import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LessonIdentity, SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

/**
 * The lesson's voice, stored beside the lesson (ADR-0017).
 *
 * A lesson is the same for everyone who asks for it: the same expert, the same
 * band, the same sentences, in the same order. Onten's memo already keeps the
 * *words* so a second learner does not pay a model to write them again; this
 * keeps the **audio of those words**, so they do not pay a voice engine to say
 * them again either. Together they are the whole reusable half of a session.
 *
 * The other half is never stored. A learner's question, the answer composed
 * for it, a check-in verdict, an honest line about a failure — those belong to
 * one person's session. They are synthesised fresh every time, for two reasons
 * that point the same way: they are different for every learner, so caching
 * them would buy nothing; and they are the one part of a session that is about
 * a person, so keeping them would be the wrong thing to do. They are still
 * recorded in that session's own ledger, where the observability work
 * (ADR-0011) can see them — they are simply not reusable material.
 *
 * ## Layout
 *
 * ```
 * <dir>/<canonicalId>/<band>/<expertId>/
 *   manifest.json     what is stored, and for which version of the words
 *   <sayId>.<hash>.pcm
 * ```
 *
 * The file name carries a hash of everything that decides a single sample —
 * the text, the engine and model, the voice, the speed, the sample rate, the
 * delivery tone and the language. Re-write a sentence, change the persona's voice, move the
 * pace, switch the model: the hash changes, the old take stops being used and
 * is deleted the next time that lesson is spoken. There is no separate
 * invalidation step to forget to run, because identity *is* the version.
 */

/** Same framing as the Fish adapter, so a hit and a miss are indistinguishable downstream. */
const FRAME_MS = 120;
/**
 * How much faster than realtime a stored lesson streams back.
 *
 * A live provider is not instant between sentences: each one costs a request,
 * a connection and a first byte, so what the client sees over a lesson is
 * close to realtime. Disk has no such wait, and delivering a whole lesson in
 * seconds would leave the room minutes ahead of the learner — every barge-in
 * would then throw away far more banked audio than it needed to. The first
 * chunk still goes out with no delay at all, which is the latency anyone
 * actually feels.
 */
/*
 * 4×, not 1.25×. The pipeline streams one sentence at a time, so at 1.25× a
 * stored sentence had streamed only a quarter of its length ahead of the
 * player by the time the next one could start, and a re-take after a pause,
 * a check-in or a barge-in began every time with an empty bank and that
 * thin margin: the player ran dry and said "Buffering…" in a lesson whose
 * every sentence was already on disk. The lookahead (three sentences, twenty
 * seconds) still bounds what a barge-in throws away.
 */
const DEFAULT_REPLAY_SPEED = 4;
/** A sentence longer than this is not a sentence; it is a bug, and it is not stored. */
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;
const MANIFEST = 'manifest.json';

export interface SynthesisCacheOptions {
  /** The real engine. Its `id` is part of every take's hash. */
  inner: SpeechSynthesizer;
  /** Store root, usually `<PEN_DATA_DIR>/lesson-voice`. */
  dir: string;
  /** LRU ceiling in bytes (`PEN_TTS_CACHE_MB`). 0 disables storing and reading. */
  maxBytes: number;
  replaySpeed?: number;
  now?: () => number;
  /** Test seam for the replay cadence. */
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (name: string, data: Record<string, string | number | boolean>) => void;
}

/** One stored sentence. `take` is the content hash: it is the version, and the file name. */
interface StoredSay {
  sayId: string;
  take: string;
  bytes: number;
  sampleRate: number;
  /** ms epoch, for the LRU. */
  lastUsed: number;
  createdAt: number;
}

interface Manifest {
  version: 1;
  canonicalId: string;
  band: string;
  expertId: string;
  says: StoredSay[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Requests that joined a synthesis already in flight for the same sentence. */
  coalesced: number;
  /** Sentences dropped because the lesson's words (or voice, or pace) changed. */
  superseded: number;
  evictions: number;
  /** Sentences never offered to the store because they belong to one learner. */
  personal: number;
  says: number;
  bytes: number;
}

/**
 * The version of one sentence: everything that can change a single sample.
 * The text is in here, so re-writing a lesson retires exactly the sentences
 * that changed and keeps the rest.
 */
export function sayTake(engineId: string, request: SynthesisRequest): string {
  const parts = [
    engineId,
    request.voice,
    (request.speed ?? 1).toFixed(3),
    String(request.sampleRate),
    request.tone ?? '',
    request.language ?? '',
    request.text,
    // A separator no field can contain, so "voice a" + "b" can never collide
    // with "voice" + "a b".
  ].join('\u0000');
  return createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

/** One synthesis in flight, fanned out to every room that wants the same sentence. */
class SharedSynthesis {
  private readonly chunks: SpeechChunk[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private failure: unknown = null;
  private subscribers = 0;
  readonly controller = new AbortController();

  push(chunk: SpeechChunk): void {
    this.chunks.push(chunk);
    this.wake();
  }

  finish(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.ended = true;
    this.wake();
  }

  /** Every sample produced so far, concatenated — what gets written to the store. */
  pcm(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.pcm.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c.pcm, offset);
      offset += c.pcm.length;
    }
    return out;
  }

  get sampleRate(): number | null {
    return this.chunks[0]?.sampleRate ?? null;
  }

  get complete(): boolean {
    return this.ended && this.failure === null && !this.controller.signal.aborted;
  }

  /**
   * Whether a newcomer may still ride along. A synthesis that has ended — or
   * that was abandoned when its last listener barged in — holds only part of a
   * sentence, and joining it would hand the newcomer a cut-off word.
   */
  get joinable(): boolean {
    return !this.ended && !this.controller.signal.aborted;
  }

  async *subscribe(signal: AbortSignal | undefined, reused: boolean): AsyncIterable<SpeechChunk> {
    this.subscribers += 1;
    try {
      let index = 0;
      for (;;) {
        while (index < this.chunks.length) {
          if (signal?.aborted) return;
          const chunk = this.chunks[index];
          index += 1;
          if (chunk) yield reused ? { ...chunk, reused: true } : chunk;
        }
        if (this.failure !== null) throw this.failure;
        if (this.ended) return;
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    } finally {
      this.subscribers -= 1;
      // Nobody is listening any more: stop paying the provider for audio that
      // will never be heard. A second room still on the stream keeps it alive.
      if (this.subscribers === 0 && !this.ended) this.controller.abort();
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }
}

export class CachingSynthesizer implements SpeechSynthesizer {
  /** The engine's own id: pricing, telemetry and the take hash all stay on the real engine. */
  readonly id: string;
  /** Loaded lesson manifests, by lesson path. */
  private readonly lessons = new Map<string, Manifest>();
  private readonly inFlight = new Map<string, SharedSynthesis>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly replaySpeed: number;
  private totalBytes = 0;
  private readonly dirtyLessons = new Set<string>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    superseded: 0,
    evictions: 0,
    personal: 0,
    says: 0,
    bytes: 0,
  };

  constructor(private readonly o: SynthesisCacheOptions) {
    this.id = o.inner.id;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.replaySpeed = Math.max(1, o.replaySpeed ?? DEFAULT_REPLAY_SPEED);
    if (this.enabled) {
      mkdirSync(this.o.dir, { recursive: true });
      this.load();
    }
  }

  get enabled(): boolean {
    return this.o.maxBytes > 0;
  }

  /** How much faster than realtime a stored lesson streams back (1 = exactly realtime). */
  get replayRate(): number {
    return this.replaySpeed;
  }

  snapshot(): CacheStats {
    let says = 0;
    for (const m of this.lessons.values()) says += m.says.length;
    return { ...this.stats, says, bytes: this.totalBytes };
  }

  /** What is stored for one lesson, for tests and for the admin view. */
  lessonTakes(lesson: Omit<LessonIdentity, 'sayId'>): string[] {
    return (this.lessons.get(lessonPath(lesson))?.says ?? []).map((s) => s.sayId);
  }

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    const lesson = request.lesson;
    // A sentence with no lesson belongs to one learner: never stored, never
    // looked up, never shared with another room. Straight to the engine.
    if (!this.enabled || !lesson) {
      if (this.enabled) this.stats.personal += 1;
      yield* this.o.inner.synthesize(request);
      return;
    }
    const take = sayTake(this.id, request);
    const stored = this.read(lesson, take);
    if (stored) {
      this.stats.hits += 1;
      this.o.onEvent?.('tts.lesson_voice_hit', {
        canonicalId: lesson.canonicalId,
        sayId: lesson.sayId,
        bytes: stored.length,
      });
      yield* this.replay(stored, request.sampleRate, request.signal);
      return;
    }
    const key = `${lessonPath(lesson)}/${lesson.sayId}.${take}`;
    const existing = this.inFlight.get(key);
    if (existing?.joinable) {
      // Another room is already buying this very sentence: ride along. It is a
      // hit in every sense that matters — one provider call, one bill.
      this.stats.coalesced += 1;
      this.o.onEvent?.('tts.lesson_voice_join', { sayId: lesson.sayId });
      yield* existing.subscribe(request.signal, true);
      return;
    }
    this.stats.misses += 1;
    const shared = new SharedSynthesis();
    this.inFlight.set(key, shared);
    // The upstream call belongs to the shared synthesis, not to whoever asked
    // first: one learner's barge-in must not cut a second room's audio.
    void this.pump(key, lesson, take, request, shared);
    yield* shared.subscribe(request.signal, false);
  }

  /** Drive the real engine, fan chunks out, and write a complete sentence through to disk. */
  private async pump(
    key: string,
    lesson: LessonIdentity,
    take: string,
    request: SynthesisRequest,
    shared: SharedSynthesis,
  ): Promise<void> {
    try {
      const stream = this.o.inner.synthesize({ ...request, signal: shared.controller.signal });
      for await (const chunk of stream) {
        if (shared.controller.signal.aborted) break;
        shared.push(chunk);
      }
      shared.finish();
      // Only a whole sentence is stored: a barge-in leaves nothing behind that
      // could be replayed later as a cut-off word.
      if (shared.complete)
        this.write(lesson, take, shared.pcm(), shared.sampleRate ?? request.sampleRate);
    } catch (error) {
      shared.fail(error);
    } finally {
      // Release this claim, and only this one.
      //
      // A barge-in leaves a synthesis abandoned but still parked in the
      // provider call. The next room finds it unjoinable, rightly buys its
      // own, and claims this same key — and when the abandoned pump finally
      // unwinds, a bare `delete(key)` evicted *that* room's live claim.
      // Everyone after it missed a synthesis that was running at that moment
      // and paid the provider for the same sentence again.
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    }
  }

  /**
   * Stream a stored sentence the way the engine would: framed, clocked, first
   * chunk immediately, the rest paced so the client's bank fills at the rate a
   * live lesson fills it.
   */
  private async *replay(
    pcm: Uint8Array,
    sampleRate: SynthesisRequest['sampleRate'],
    signal: AbortSignal | undefined,
  ): AsyncIterable<SpeechChunk> {
    const frameBytes = Math.floor((sampleRate * FRAME_MS) / 1000) * 2;
    let index = 0;
    let clockMs = 0;
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      if (signal?.aborted) return;
      const payload = pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes));
      const durationMs = Math.max(1, Math.round(((payload.length / 2) * 1000) / sampleRate));
      // The first frame goes out with no wait at all: that is the whole point.
      if (index > 0) await this.sleep(durationMs / this.replaySpeed);
      if (signal?.aborted) return;
      yield {
        audioChunkId: index,
        audioClockMs: clockMs,
        sampleRate,
        durationMs,
        pcm: new Uint8Array(payload),
        textSpan: null,
        reused: true,
      };
      index += 1;
      clockMs += durationMs;
    }
  }

  // ── store ────────────────────────────────────────────────────────────────

  private fileFor(lesson: Omit<LessonIdentity, 'sayId'>, sayId: string, take: string): string {
    return join(this.o.dir, lessonPath(lesson), `${safe(sayId)}.${take}.pcm`);
  }

  private manifestFor(lesson: Omit<LessonIdentity, 'sayId'>): Manifest {
    const path = lessonPath(lesson);
    const existing = this.lessons.get(path);
    if (existing) return existing;
    const fresh: Manifest = {
      version: 1,
      canonicalId: lesson.canonicalId,
      band: lesson.band,
      expertId: lesson.expertId,
      says: [],
    };
    this.lessons.set(path, fresh);
    return fresh;
  }

  private read(lesson: LessonIdentity, take: string): Uint8Array | null {
    const manifest = this.lessons.get(lessonPath(lesson));
    if (!manifest) return null;
    const entry = manifest.says.find((s) => s.sayId === lesson.sayId);
    if (!entry) return null;
    if (entry.take !== take) {
      // The words (or the voice, or the pace) changed: this take is history.
      // Retiring it here is the whole of invalidation — identity is the version.
      this.drop(manifest, entry);
      this.stats.superseded += 1;
      this.o.onEvent?.('tts.lesson_voice_superseded', {
        canonicalId: lesson.canonicalId,
        sayId: lesson.sayId,
      });
      return null;
    }
    const file = this.fileFor(lesson, entry.sayId, entry.take);
    if (!existsSync(file)) {
      // The manifest outlived the file (a manual clean-out): forget it quietly.
      this.drop(manifest, entry);
      return null;
    }
    entry.lastUsed = this.now();
    this.dirtyLessons.add(lessonPath(lesson));
    this.save();
    return readFileSync(file);
  }

  private write(lesson: LessonIdentity, take: string, pcm: Uint8Array, sampleRate: number): void {
    if (pcm.length === 0 || pcm.length > MAX_CACHEABLE_BYTES) return;
    const manifest = this.manifestFor(lesson);
    const previous = manifest.says.find((s) => s.sayId === lesson.sayId);
    if (previous?.take === take) return;
    if (previous) this.drop(manifest, previous);
    const file = this.fileFor(lesson, lesson.sayId, take);
    try {
      mkdirSync(join(this.o.dir, lessonPath(lesson)), { recursive: true });
      // Write beside the target and rename: a reader can never see half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, pcm);
      renameSync(tmp, file);
    } catch (error) {
      this.o.onEvent?.('tts.lesson_voice_write_failed', { detail: String(error).slice(0, 120) });
      return;
    }
    const at = this.now();
    manifest.says.push({
      sayId: lesson.sayId,
      take,
      bytes: pcm.length,
      sampleRate,
      lastUsed: at,
      createdAt: at,
    });
    this.totalBytes += pcm.length;
    this.dirtyLessons.add(lessonPath(lesson));
    this.evict();
    this.save();
  }

  /** Forget one stored sentence, on disk and in the manifest. */
  private drop(manifest: Manifest, entry: StoredSay): void {
    manifest.says = manifest.says.filter((s) => s !== entry);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    this.dirtyLessons.add(lessonPath(manifest));
    try {
      rmSync(this.fileFor(manifest, entry.sayId, entry.take), { force: true });
    } catch {
      /* the manifest no longer points at it; a stray file is harmless */
    }
  }

  /**
   * Least recently used first, until the store is back inside its ceiling.
   * Eviction is per sentence rather than per lesson: a lesson nobody asks for
   * any more fades out of the store one sentence at a time, and a popular one
   * keeps the sentences that are actually being heard.
   */
  private evict(): void {
    if (this.totalBytes <= this.o.maxBytes) return;
    const all: Array<{ manifest: Manifest; entry: StoredSay }> = [];
    for (const manifest of this.lessons.values())
      for (const entry of manifest.says) all.push({ manifest, entry });
    all.sort((a, b) => a.entry.lastUsed - b.entry.lastUsed);
    for (const { manifest, entry } of all) {
      if (this.totalBytes <= this.o.maxBytes) break;
      this.drop(manifest, entry);
      this.stats.evictions += 1;
    }
  }

  private load(): void {
    const walk = (relative: string, depth: number): void => {
      const absolute = join(this.o.dir, relative);
      if (depth === 3) {
        try {
          const manifest = JSON.parse(readFileSync(join(absolute, MANIFEST), 'utf8')) as Manifest;
          if (manifest.version !== 1 || !Array.isArray(manifest.says)) return;
          manifest.says = manifest.says.filter((s) => {
            if (typeof s?.sayId !== 'string' || typeof s.bytes !== 'number') return false;
            if (!existsSync(join(absolute, `${safe(s.sayId)}.${s.take}.pcm`))) return false;
            this.totalBytes += s.bytes;
            return true;
          });
          this.lessons.set(relative, manifest);
        } catch {
          /* a lesson with no readable manifest is simply a cold lesson */
        }
        return;
      }
      for (const child of readdirSync(absolute, { withFileTypes: true }))
        if (child.isDirectory()) walk(join(relative, child.name), depth + 1);
    };
    try {
      walk('', 0);
      this.evict();
    } catch (error) {
      // A corrupt store costs a cold cache, never a failed boot.
      this.o.onEvent?.('tts.lesson_voice_unreadable', { detail: String(error).slice(0, 120) });
      this.lessons.clear();
      this.totalBytes = 0;
    }
  }

  /** Persist the manifests that changed. Small files, always consistent with the disk. */
  save(): void {
    for (const path of this.dirtyLessons) {
      const manifest = this.lessons.get(path);
      if (!manifest) continue;
      try {
        const dir = join(this.o.dir, path);
        mkdirSync(dir, { recursive: true });
        const target = join(dir, MANIFEST);
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(manifest));
        renameSync(tmp, target);
      } catch (error) {
        this.o.onEvent?.('tts.lesson_voice_manifest_failed', {
          detail: String(error).slice(0, 120),
        });
      }
    }
    this.dirtyLessons.clear();
  }

  /** Bytes on disk right now (the manifests are the truth; this verifies them). */
  measure(): number {
    let bytes = 0;
    for (const [path, manifest] of this.lessons)
      for (const entry of manifest.says) {
        try {
          bytes += statSync(join(this.o.dir, path, `${safe(entry.sayId)}.${entry.take}.pcm`)).size;
        } catch {
          /* counted as gone */
        }
      }
    return bytes;
  }
}

/** `<canonicalId>/<band>/<expertId>` — one directory per lesson as it is taught. */
function lessonPath(lesson: Omit<LessonIdentity, 'sayId'>): string {
  return join(safe(lesson.canonicalId), safe(lesson.band), safe(lesson.expertId));
}

/** Ids become path segments: only characters that cannot escape a directory. */
function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || '_';
}
