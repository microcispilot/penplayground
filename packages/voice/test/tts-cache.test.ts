import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachingSynthesizer, cacheKey } from '../src/server/cache.js';
import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from '../src/server/types.js';

/**
 * The cache is the seam that makes a memo-hit lesson nearly free to speak
 * (ADR-0016), so these tests hold it to the three properties that matter:
 * one purchase per sentence (even under a race), audio that streams like a
 * provider rather than arriving in a lump, and a store that stays inside its
 * ceiling.
 */

const SAMPLE_RATE = 44_100 as const;
/** 120 ms of s16le at 44.1 kHz — one frame, the unit everything downstream expects. */
const FRAME_BYTES = Math.floor((SAMPLE_RATE * 120) / 1000) * 2;

/** A synthesizer that counts its calls and can be made slow, so races are observable. */
class CountingSynthesizer implements SpeechSynthesizer {
  readonly id = 'fish-cloud:s2.1-pro';
  calls = 0;
  /** Resolved between chunks; lets a test hold a synthesis open. */
  gate: (() => Promise<void>) | null = null;
  aborted = 0;
  constructor(private readonly frames = 3) {}

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    this.calls += 1;
    for (let i = 0; i < this.frames; i += 1) {
      if (this.gate) await this.gate();
      if (request.signal?.aborted) {
        this.aborted += 1;
        return;
      }
      // A recognisable byte per frame, so a replay can be compared sample for sample.
      const pcm = new Uint8Array(FRAME_BYTES).fill(i + 1);
      yield {
        audioChunkId: i,
        audioClockMs: i * 120,
        sampleRate: request.sampleRate,
        durationMs: 120,
        pcm,
        textSpan: null,
      };
    }
  }
}

const request = (text: string, over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
  text,
  voice: 'voice-en',
  sampleRate: SAMPLE_RATE,
  speed: 0.95,
  ...over,
});

async function collect(stream: AsyncIterable<SpeechChunk>): Promise<SpeechChunk[]> {
  const out: SpeechChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pen-tts-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** No waiting in tests: the cadence is asserted from the sleep calls, not by sleeping. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

describe('CachingSynthesizer', () => {
  it('buys a sentence once and replays it byte for byte', async () => {
    const inner = new CountingSynthesizer();
    const { sleep } = recordingSleep();
    const cache = new CachingSynthesizer({ inner, dir, maxBytes: 10 << 20, sleep });

    const first = await collect(cache.synthesize(request('Six tokens is all it sees.')));
    const second = await collect(cache.synthesize(request('Six tokens is all it sees.')));

    expect(inner.calls).toBe(1);
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1 });
    // Same audio, same clock, same framing: a hit is indistinguishable downstream.
    expect(second.map((c) => c.audioClockMs)).toEqual(first.map((c) => c.audioClockMs));
    expect(second.map((c) => c.durationMs)).toEqual(first.map((c) => c.durationMs));
    expect(Buffer.concat(second.map((c) => Buffer.from(c.pcm)))).toEqual(
      Buffer.concat(first.map((c) => Buffer.from(c.pcm))),
    );
    // Only the replay claims reuse; the sentence that paid for itself does not.
    expect(first.every((c) => c.reused !== true)).toBe(true);
    expect(second.every((c) => c.reused === true)).toBe(true);
  });

  it('keys on everything that changes a sample, so a different speed or voice is a different entry', async () => {
    const inner = new CountingSynthesizer();
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: 10 << 20,
      sleep: recordingSleep().sleep,
    });
    await collect(cache.synthesize(request('Same words.')));
    await collect(cache.synthesize(request('Same words.', { speed: 1.2 })));
    await collect(cache.synthesize(request('Same words.', { voice: 'voice-fa' })));
    await collect(cache.synthesize(request('Same words.', { tone: 'curious' })));
    await collect(cache.synthesize(request('Other words.')));
    expect(inner.calls).toBe(5);

    expect(cacheKey(inner.id, request('a'))).toBe(cacheKey(inner.id, request('a')));
    expect(cacheKey(inner.id, request('a'))).not.toBe(cacheKey(inner.id, request('b')));
    // The engine (and so the model) is part of the key: a model change invalidates everything.
    expect(cacheKey('fish-cloud:s1', request('a'))).not.toBe(cacheKey(inner.id, request('a')));
  });

  it('never streams a lesson faster than the client can hear it', () => {
    // The default has to stay near realtime: a cache that delivers a whole
    // lesson in seconds puts the room and the player out of step.
    const inner = new CountingSynthesizer(1);
    const cache = new CachingSynthesizer({ inner, dir, maxBytes: 1 << 20 });
    expect(cache.replayRate).toBeGreaterThan(1);
    expect(cache.replayRate).toBeLessThanOrEqual(2);
  });

  it('streams a hit like a healthy provider: first frame immediately, the rest paced', async () => {
    const inner = new CountingSynthesizer(5);
    const { sleep, waits } = recordingSleep();
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: 10 << 20,
      sleep,
      replaySpeed: 6,
    });
    await collect(cache.synthesize(request('A paced sentence.')));
    waits.length = 0;
    const chunks = await collect(cache.synthesize(request('A paced sentence.')));

    expect(chunks).toHaveLength(5);
    // Four waits for five frames: nothing at all delays the first one.
    expect(waits).toHaveLength(4);
    expect(waits.every((ms) => Math.abs(ms - 120 / 6) < 1e-9)).toBe(true);
    // The clock stays contiguous, which is what the player's validator demands.
    let expectedClock = 0;
    for (const chunk of chunks) {
      expect(chunk.audioClockMs).toBe(expectedClock);
      expectedClock += chunk.durationMs;
    }
  });

  it('shares one synthesis between two rooms asking at the same moment', async () => {
    const inner = new CountingSynthesizer(3);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    inner.gate = async () => {
      // Hold the very first frame so the second caller certainly arrives mid-flight.
      if (gated) return;
      gated = true;
      await held;
    };
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: 10 << 20,
      sleep: recordingSleep().sleep,
    });

    const a = collect(cache.synthesize(request('Shared sentence.')));
    // Give the leader a turn of the event loop to register itself as in flight.
    await Promise.resolve();
    const b = collect(cache.synthesize(request('Shared sentence.')));
    release();
    const [first, second] = await Promise.all([a, b]);

    expect(inner.calls).toBe(1);
    expect(cache.snapshot().coalesced).toBe(1);
    expect(second).toHaveLength(first.length);
    expect(Buffer.concat(second.map((c) => Buffer.from(c.pcm)))).toEqual(
      Buffer.concat(first.map((c) => Buffer.from(c.pcm))),
    );
    // The follower's audio is reuse: it cost nothing beyond the leader's call.
    expect(second.every((c) => c.reused === true)).toBe(true);
  });

  it('evicts least-recently-used entries to stay inside its ceiling', async () => {
    const inner = new CountingSynthesizer(1);
    let clock = 1_000;
    const cache = new CachingSynthesizer({
      inner,
      dir,
      // Room for two frames, not three.
      maxBytes: FRAME_BYTES * 2 + 1,
      sleep: recordingSleep().sleep,
      now: () => (clock += 1_000),
    });
    await collect(cache.synthesize(request('one')));
    await collect(cache.synthesize(request('two')));
    // Touch "one" so "two" becomes the oldest use.
    await collect(cache.synthesize(request('one')));
    await collect(cache.synthesize(request('three')));

    expect(cache.snapshot().entries).toBe(2);
    expect(cache.snapshot().evictions).toBe(1);
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(FRAME_BYTES * 2 + 1);
    // Files follow the index: an evicted entry leaves nothing behind.
    expect(readdirSync(join(dir, 'audio'))).toHaveLength(2);

    // "two" was evicted, so it has to be bought again; "one" and "three" have not.
    const before = inner.calls;
    await collect(cache.synthesize(request('one')));
    await collect(cache.synthesize(request('three')));
    expect(inner.calls).toBe(before);
    await collect(cache.synthesize(request('two')));
    expect(inner.calls).toBe(before + 1);
  });

  it('never caches a sentence that was cut short', async () => {
    const inner = new CountingSynthesizer(4);
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: 10 << 20,
      sleep: recordingSleep().sleep,
    });
    const controller = new AbortController();
    const chunks: SpeechChunk[] = [];
    for await (const chunk of cache.synthesize(
      request('Interrupted mid-', { signal: controller.signal }),
    )) {
      chunks.push(chunk);
      // A barge-in after the first frame: the rest of this sentence is never heard.
      controller.abort();
    }
    expect(chunks.length).toBeLessThan(4);
    expect(cache.snapshot().entries).toBe(0);

    // Asked again, it is synthesised properly rather than replayed truncated.
    const full = await collect(cache.synthesize(request('Interrupted mid-')));
    expect(full).toHaveLength(4);
    expect(full.every((c) => c.reused !== true)).toBe(true);
  });

  it('survives a restart: the index on disk is what the next process reads', async () => {
    const inner = new CountingSynthesizer();
    const opts = { inner, dir, maxBytes: 10 << 20, sleep: recordingSleep().sleep };
    const first = new CachingSynthesizer(opts);
    await collect(first.synthesize(request('Persisted.')));
    expect(inner.calls).toBe(1);

    const second = new CachingSynthesizer(opts);
    expect(second.snapshot().entries).toBe(1);
    const chunks = await collect(second.synthesize(request('Persisted.')));
    expect(inner.calls).toBe(1);
    expect(chunks.every((c) => c.reused === true)).toBe(true);
  });

  it('is a plain pass-through when the cache is switched off', async () => {
    const inner = new CountingSynthesizer();
    const cache = new CachingSynthesizer({ inner, dir, maxBytes: 0 });
    await collect(cache.synthesize(request('No cache here.')));
    await collect(cache.synthesize(request('No cache here.')));
    expect(cache.enabled).toBe(false);
    expect(inner.calls).toBe(2);
    expect(cache.snapshot().entries).toBe(0);
  });

  it('keeps the engine id, so pricing and telemetry still name the real provider', () => {
    const inner = new CountingSynthesizer();
    const cache = new CachingSynthesizer({ inner, dir, maxBytes: 1 << 20 });
    expect(cache.id).toBe('fish-cloud:s2.1-pro');
  });
});
