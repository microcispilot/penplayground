import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from './types.js';

/**
 * Synthesis cache: the same sentence, in the same voice at the same speed, is
 * bought from the provider once (ADR-0017).
 *
 * A lesson that is served from the memo speaks the *identical* sentences the
 * previous learner heard, so without this every memo hit still paid full price
 * for audio — the one stage of a session that ADR-0011 had to record as
 * `reused: false` every time. This is the seam that closes it: a
 * `SpeechSynthesizer` that wraps another one, so nothing above it (the
 * `SayPipeline`, the room, the ledger) needs to know a cache exists beyond the
 * `reused` flag the chunks carry.
 *
 * Three properties matter more than the hit rate:
 *
 * 1. **Cadence.** A cache hit streams like a healthy provider rather than
 *    dumping a sentence at once: first chunk immediately, the rest paced at
 *    `replaySpeed` × realtime. The client's jitter buffer and bounded bank
 *    (30 s) then behave exactly as they do live, and the beat that follows the
 *    sentence is still the `SayPipeline`'s to add.
 * 2. **One synthesis per sentence, even under a race.** Two rooms asking for
 *    the same sentence at the same moment share one upstream call and both
 *    stream from it as it arrives; neither waits for the other to finish.
 * 3. **Only whole syntheses are cached.** A barge-in mid-sentence leaves no
 *    truncated entry to be replayed as a cut-off word later.
 */

/** Same framing as the Fish adapter, so a hit and a miss are indistinguishable downstream. */
const FRAME_MS = 120;
/**
 * How much faster than realtime a cache hit streams.
 *
 * A single Fish request arrives at ≈ 4.5× realtime, but a *lesson* does not:
 * between sentences the pipeline waits for the next request to connect and
 * produce its first byte, so the rate the client actually sees is close to
 * realtime. A cache has no such wait, and replaying at the single-request rate
 * made the whole lesson arrive far ahead of playback — measured, that is what
 * pushed the room and the player out of step (the sentence at the speaker and
 * the sentence on the wire stopped being neighbours). The first chunk still
 * goes out with no delay at all, which is the latency the learner actually
 * feels; the tail is paced to what a healthy session looks like.
 */
const DEFAULT_REPLAY_SPEED = 1.25;
/** Sentences longer than this are not worth an entry (and are not what a lesson says). */
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;

export interface SynthesisCacheOptions {
  /** The real engine. Its `id` is part of every key, so changing model changes the key. */
  inner: SpeechSynthesizer;
  /** Cache root, usually `<PEN_DATA_DIR>/tts-cache`. */
  dir: string;
  /** LRU ceiling in bytes (`PEN_TTS_CACHE_MB`). 0 disables storing and reading. */
  maxBytes: number;
  replaySpeed?: number;
  now?: () => number;
  /** Test seam for the replay cadence. */
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (name: string, data: Record<string, string | number | boolean>) => void;
}

interface IndexEntry {
  key: string;
  bytes: number;
  sampleRate: number;
  /** ms epoch, for the LRU. */
  lastUsed: number;
  createdAt: number;
}

interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Requests that joined a synthesis already in flight for the same key. */
  coalesced: number;
  evictions: number;
  entries: number;
  bytes: number;
}

/**
 * The key. Everything that can change a single sample is in it: the engine and
 * its model (`fish-cloud:s2.1-pro`), the voice reference (which is also how a
 * persona's language is chosen, so language is covered), the speed the pace
 * asked for, the sample rate, the delivery tone, and the text itself.
 */
export function cacheKey(engineId: string, request: SynthesisRequest): string {
  const speed = (request.speed ?? 1).toFixed(3);
  const parts = [
    engineId,
    request.voice,
    speed,
    String(request.sampleRate),
    request.tone ?? '',
    request.text,
    // A separator no field can contain, so "voice a" + "b" can never collide with "voice" + "a b".
  ].join('\u0000');
  return createHash('sha256').update(parts).digest('hex');
}

/** One synthesis in flight, fanned out to every caller that wants the same sentence. */
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

  /** Every sample produced so far, concatenated — what gets written to the cache. */
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
  /** The engine's own id: pricing, telemetry and the cache key all stay on the real engine. */
  readonly id: string;
  private readonly index = new Map<string, IndexEntry>();
  private readonly inFlight = new Map<string, SharedSynthesis>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly replaySpeed: number;
  private totalBytes = 0;
  private dirty = false;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    evictions: 0,
    entries: 0,
    bytes: 0,
  };

  constructor(private readonly o: SynthesisCacheOptions) {
    this.id = o.inner.id;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.replaySpeed = Math.max(1, o.replaySpeed ?? DEFAULT_REPLAY_SPEED);
    if (this.enabled) {
      mkdirSync(this.audioDir, { recursive: true });
      this.load();
    }
  }

  get enabled(): boolean {
    return this.o.maxBytes > 0;
  }

  /** How much faster than realtime a hit streams back (1 = exactly realtime). */
  get replayRate(): number {
    return this.replaySpeed;
  }

  snapshot(): CacheStats {
    return { ...this.stats, entries: this.index.size, bytes: this.totalBytes };
  }

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    if (!this.enabled) {
      yield* this.o.inner.synthesize(request);
      return;
    }
    const key = cacheKey(this.id, request);
    const hit = this.read(key);
    if (hit) {
      this.stats.hits += 1;
      this.o.onEvent?.('tts.cache_hit', { bytes: hit.pcm.length, sampleRate: hit.sampleRate });
      yield* this.replay(hit.pcm, request.sampleRate, request.signal);
      return;
    }
    const existing = this.inFlight.get(key);
    if (existing?.joinable) {
      // Someone else is already buying this exact sentence: ride along. It is a
      // hit in every sense that matters (one provider call, one bill).
      this.stats.coalesced += 1;
      this.o.onEvent?.('tts.cache_join', { key: key.slice(0, 12) });
      yield* existing.subscribe(request.signal, true);
      return;
    }
    this.stats.misses += 1;
    const shared = new SharedSynthesis();
    this.inFlight.set(key, shared);
    // The upstream call belongs to the shared synthesis, not to whoever asked
    // first: one caller's barge-in must not cut a second room's audio.
    void this.pump(key, request, shared);
    yield* shared.subscribe(request.signal, false);
  }

  /** Drive the real engine, fan chunks out, and write a complete synthesis through to disk. */
  private async pump(
    key: string,
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
      if (shared.complete) this.write(key, shared.pcm(), shared.sampleRate ?? request.sampleRate);
    } catch (error) {
      shared.fail(error);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Stream cached PCM the way a provider would: framed, clocked, first chunk
   * immediately, the rest paced so the client's bank fills at a sane rate.
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

  private get audioDir(): string {
    return join(this.o.dir, 'audio');
  }

  private get indexPath(): string {
    return join(this.o.dir, 'index.json');
  }

  private fileFor(key: string): string {
    return join(this.audioDir, `${key}.pcm`);
  }

  private read(key: string): { pcm: Uint8Array; sampleRate: number } | null {
    const entry = this.index.get(key);
    if (!entry) return null;
    const file = this.fileFor(key);
    if (!existsSync(file)) {
      // The index outlived the file (a manual clean-out): forget it quietly.
      this.index.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      this.dirty = true;
      return null;
    }
    entry.lastUsed = this.now();
    this.dirty = true;
    this.save();
    return { pcm: readFileSync(file), sampleRate: entry.sampleRate };
  }

  private write(key: string, pcm: Uint8Array, sampleRate: number): void {
    if (pcm.length === 0 || pcm.length > MAX_CACHEABLE_BYTES) return;
    if (this.index.has(key)) return;
    try {
      // Write beside the target and rename: a reader can never see half a file.
      const tmp = `${this.fileFor(key)}.${process.pid}.tmp`;
      writeFileSync(tmp, pcm);
      renameSync(tmp, this.fileFor(key));
    } catch (error) {
      this.o.onEvent?.('tts.cache_write_failed', { detail: String(error).slice(0, 120) });
      return;
    }
    const at = this.now();
    this.index.set(key, { key, bytes: pcm.length, sampleRate, lastUsed: at, createdAt: at });
    this.totalBytes += pcm.length;
    this.dirty = true;
    this.evict();
    this.save();
  }

  /** Least recently used first, until the store is back inside its ceiling. */
  private evict(): void {
    if (this.totalBytes <= this.o.maxBytes) return;
    const byAge = [...this.index.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of byAge) {
      if (this.totalBytes <= this.o.maxBytes) break;
      this.index.delete(entry.key);
      this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      this.stats.evictions += 1;
      try {
        rmSync(this.fileFor(entry.key), { force: true });
      } catch {
        /* the index no longer points at it; a stray file is harmless */
      }
    }
    this.dirty = true;
  }

  private load(): void {
    try {
      if (!existsSync(this.indexPath)) return;
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries) {
        if (typeof entry?.key !== 'string' || typeof entry.bytes !== 'number') continue;
        if (!existsSync(this.fileFor(entry.key))) continue;
        this.index.set(entry.key, entry);
        this.totalBytes += entry.bytes;
      }
      this.evict();
    } catch (error) {
      // A corrupt index costs a cold cache, never a failed boot.
      this.o.onEvent?.('tts.cache_index_unreadable', { detail: String(error).slice(0, 120) });
      this.index.clear();
      this.totalBytes = 0;
    }
  }

  /** Persist the index. Cheap (one small file) and always consistent with what is on disk. */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const file: IndexFile = { version: 1, entries: [...this.index.values()] };
    try {
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file));
      renameSync(tmp, this.indexPath);
    } catch (error) {
      this.o.onEvent?.('tts.cache_index_write_failed', { detail: String(error).slice(0, 120) });
    }
  }

  /** Bytes on disk right now (the index is the truth; this verifies it). */
  measure(): number {
    let bytes = 0;
    for (const entry of this.index.values()) {
      try {
        bytes += statSync(this.fileFor(entry.key)).size;
      } catch {
        /* counted as gone */
      }
    }
    return bytes;
  }
}
