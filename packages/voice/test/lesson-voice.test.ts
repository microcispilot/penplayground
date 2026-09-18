import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachingSynthesizer, sayTake } from '../src/server/cache.js';
import type {
  LessonIdentity,
  SpeechChunk,
  SpeechSynthesizer,
  SynthesisRequest,
} from '../src/server/types.js';

/**
 * The lesson's voice is stored beside the lesson it speaks (ADR-0017), so
 * these tests hold the store to the four things that matter: a lesson is
 * bought once, a learner's own words are never written down, re-writing a
 * sentence retires exactly that sentence, and what comes back off disk is
 * indistinguishable from what the engine would have sent.
 */

const SAMPLE_RATE = 44_100 as const;
/** 120 ms of s16le at 44.1 kHz — one frame, the unit everything downstream expects. */
const FRAME_BYTES = Math.floor((SAMPLE_RATE * 120) / 1000) * 2;

const LESSON: Omit<LessonIdentity, 'sayId'> = {
  canonicalId: 'en.how-transformers-work-in-llms',
  band: 'beginner',
  expertId: 'ada-okonkwo',
};

/** A synthesizer that counts its calls and can be held open, so races are observable. */
class CountingSynthesizer implements SpeechSynthesizer {
  readonly id = 'fish-cloud:s2.1-pro';
  calls = 0;
  /** Awaited before the first frame; lets a test hold a synthesis open. */
  gate: (() => Promise<void>) | null = null;
  constructor(private readonly frames = 3) {}

  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    this.calls += 1;
    for (let i = 0; i < this.frames; i += 1) {
      if (this.gate) await this.gate();
      if (request.signal?.aborted) return;
      // A recognisable byte per frame, so a replay can be compared sample for sample.
      yield {
        audioChunkId: i,
        audioClockMs: i * 120,
        sampleRate: request.sampleRate,
        durationMs: 120,
        pcm: new Uint8Array(FRAME_BYTES).fill(i + 1),
        textSpan: null,
      };
    }
  }
}

/** A sentence of the taught lesson: shared material. */
const lessonSay = (
  sayId: string,
  text: string,
  over: Partial<SynthesisRequest> = {},
): SynthesisRequest => ({
  text,
  voice: 'voice-en',
  sampleRate: SAMPLE_RATE,
  speed: 0.95,
  lesson: { ...LESSON, sayId },
  ...over,
});

/** A sentence spoken to one learner: never stored. */
const personalSay = (text: string, over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
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
  dir = mkdtempSync(join(tmpdir(), 'pen-lesson-voice-'));
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

const store = (inner: SpeechSynthesizer, over: Partial<{ maxBytes: number }> = {}) =>
  new CachingSynthesizer({
    inner,
    dir,
    maxBytes: over.maxBytes ?? 10 << 20,
    sleep: recordingSleep().sleep,
  });

describe('the lesson voice store', () => {
  it('buys a lesson sentence once and replays it byte for byte', async () => {
    const inner = new CountingSynthesizer();
    const cache = store(inner);

    const first = await collect(cache.synthesize(lessonSay('L0.s1', 'Six tokens is all it sees.')));
    const second = await collect(
      cache.synthesize(lessonSay('L0.s1', 'Six tokens is all it sees.')),
    );

    expect(inner.calls).toBe(1);
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1, says: 1 });
    // Same audio, same clock, same framing: a stored take is indistinguishable downstream.
    expect(second.map((c) => c.audioClockMs)).toEqual(first.map((c) => c.audioClockMs));
    expect(second.map((c) => c.durationMs)).toEqual(first.map((c) => c.durationMs));
    expect(Buffer.concat(second.map((c) => Buffer.from(c.pcm)))).toEqual(
      Buffer.concat(first.map((c) => Buffer.from(c.pcm))),
    );
    // Only the replay claims reuse; the sentence that paid for itself does not.
    expect(first.every((c) => c.reused !== true)).toBe(true);
    expect(second.every((c) => c.reused === true)).toBe(true);
  });

  it('never stores a sentence that belongs to one learner', async () => {
    const inner = new CountingSynthesizer();
    const cache = store(inner);

    // The same question asked twice, by two different learners, is synthesised
    // twice: their words are not shared material, whatever they happen to be.
    const question = 'Good one. Without it the dot products get huge.';
    await collect(cache.synthesize(personalSay(question)));
    await collect(cache.synthesize(personalSay(question)));

    expect(inner.calls).toBe(2);
    expect(cache.snapshot()).toMatchObject({ says: 0, hits: 0, personal: 2 });
    // And nothing of it reached the disk.
    expect(cache.lessonTakes(LESSON)).toEqual([]);
    expect(cache.measure()).toBe(0);
  });

  it('keeps the lesson it belongs to: two lessons never share a sentence', async () => {
    const inner = new CountingSynthesizer();
    const cache = store(inner);
    const text = 'Each token becomes a vector.';
    await collect(cache.synthesize(lessonSay('L0.s1', text)));
    await collect(
      cache.synthesize({
        ...lessonSay('L0.s1', text),
        lesson: { ...LESSON, canonicalId: 'en.attention-is-all-you-need', sayId: 'L0.s1' },
      }),
    );
    // Same words, different lessons: each lesson owns its own voice, so a
    // change to one can never quietly alter the other.
    expect(inner.calls).toBe(2);
    expect(cache.lessonTakes(LESSON)).toEqual(['L0.s1']);
    expect(cache.lessonTakes({ ...LESSON, canonicalId: 'en.attention-is-all-you-need' })).toEqual([
      'L0.s1',
    ]);
  });

  it('retires exactly the sentence whose words changed, and keeps the rest', async () => {
    const inner = new CountingSynthesizer();
    const cache = store(inner);
    await collect(cache.synthesize(lessonSay('L0.s1', 'The first sentence.')));
    await collect(cache.synthesize(lessonSay('L0.s2', 'The second sentence.')));
    expect(inner.calls).toBe(2);
    const staleTake = sayTake(inner.id, lessonSay('L0.s1', 'The first sentence.'));
    expect(existsSync(lessonFile(dir, 'L0.s1', staleTake))).toBe(true);

    // The lesson is edited: s1 is re-written, s2 is untouched.
    await collect(cache.synthesize(lessonSay('L0.s1', 'The first sentence, rewritten.')));
    await collect(cache.synthesize(lessonSay('L0.s2', 'The second sentence.')));

    // Only the changed sentence was bought again, and the old take is gone.
    expect(inner.calls).toBe(3);
    expect(cache.snapshot().superseded).toBe(1);
    expect(existsSync(lessonFile(dir, 'L0.s1', staleTake))).toBe(false);
    expect(cache.lessonTakes(LESSON).sort()).toEqual(['L0.s1', 'L0.s2']);

    // And the rewritten sentence is now the stored one.
    const inner2 = new CountingSynthesizer();
    const reopened = store(inner2);
    await collect(reopened.synthesize(lessonSay('L0.s1', 'The first sentence, rewritten.')));
    expect(inner2.calls).toBe(0);
  });

  it('retires a sentence when the voice or the pace changes, not just the words', async () => {
    const inner = new CountingSynthesizer();
    const cache = store(inner);
    const text = 'Attention weighs every word against every other.';
    await collect(cache.synthesize(lessonSay('L0.s1', text)));
    await collect(cache.synthesize(lessonSay('L0.s1', text, { speed: 1.3 })));
    await collect(cache.synthesize(lessonSay('L0.s1', text, { voice: 'voice-fa' })));
    // Each is a different sound for the same sentence, so each is bought once
    // and only the newest is kept for that sayId.
    expect(inner.calls).toBe(3);
    expect(cache.lessonTakes(LESSON)).toEqual(['L0.s1']);
  });

  it('streams a stored lesson like a live one: first frame immediately, the rest paced', async () => {
    const inner = new CountingSynthesizer(5);
    const { sleep, waits } = recordingSleep();
    const cache = new CachingSynthesizer({
      inner,
      dir,
      maxBytes: 10 << 20,
      sleep,
      replaySpeed: 4,
    });
    await collect(cache.synthesize(lessonSay('L0.s1', 'A paced sentence.')));
    waits.length = 0;
    const chunks = await collect(cache.synthesize(lessonSay('L0.s1', 'A paced sentence.')));

    expect(chunks).toHaveLength(5);
    // Four waits for five frames: nothing at all delays the first one.
    expect(waits).toHaveLength(4);
    expect(waits.every((ms) => Math.abs(ms - 120 / 4) < 1e-9)).toBe(true);
    // The clock stays contiguous, which is what the player's validator demands.
    let expectedClock = 0;
    for (const chunk of chunks) {
      expect(chunk.audioClockMs).toBe(expectedClock);
      expectedClock += chunk.durationMs;
    }
  });

  it('never streams a lesson faster than a live one would arrive', () => {
    // A store that delivers a whole lesson in seconds leaves the room minutes
    // ahead of the learner, and every barge-in then discards far more audio.
    const cache = store(new CountingSynthesizer(1));
    expect(cache.replayRate).toBeGreaterThan(1);
    expect(cache.replayRate).toBeLessThanOrEqual(2);
  });

  it('shares one synthesis between two rooms teaching the same lesson at once', async () => {
    const inner = new CountingSynthesizer(3);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    inner.gate = async () => {
      // Hold the first frame so the second room certainly arrives mid-flight.
      if (gated) return;
      gated = true;
      await held;
    };
    const cache = store(inner);

    const a = collect(cache.synthesize(lessonSay('L0.s1', 'Shared sentence.')));
    // Give the leader a turn of the event loop to register itself as in flight.
    await Promise.resolve();
    const b = collect(cache.synthesize(lessonSay('L0.s1', 'Shared sentence.')));
    release();
    const [first, second] = await Promise.all([a, b]);

    expect(inner.calls).toBe(1);
    expect(cache.snapshot().coalesced).toBe(1);
    expect(Buffer.concat(second.map((c) => Buffer.from(c.pcm)))).toEqual(
      Buffer.concat(first.map((c) => Buffer.from(c.pcm))),
    );
    // The follower's audio is reuse: it cost nothing beyond the leader's call.
    expect(second.every((c) => c.reused === true)).toBe(true);
  });

  it('evicts the least recently heard sentences to stay inside its ceiling', async () => {
    const inner = new CountingSynthesizer(1);
    let clock = 1_000;
    const cache = new CachingSynthesizer({
      inner,
      dir,
      // Room for two sentences, not three.
      maxBytes: FRAME_BYTES * 2 + 1,
      sleep: recordingSleep().sleep,
      now: () => (clock += 1_000),
    });
    await collect(cache.synthesize(lessonSay('L0.s1', 'one')));
    await collect(cache.synthesize(lessonSay('L0.s2', 'two')));
    // Hear "one" again so "two" becomes the oldest.
    await collect(cache.synthesize(lessonSay('L0.s1', 'one')));
    await collect(cache.synthesize(lessonSay('L0.s3', 'three')));

    expect(cache.snapshot().says).toBe(2);
    expect(cache.snapshot().evictions).toBe(1);
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(FRAME_BYTES * 2 + 1);

    // "two" was evicted, so it is bought again; the others are not.
    const before = inner.calls;
    await collect(cache.synthesize(lessonSay('L0.s1', 'one')));
    await collect(cache.synthesize(lessonSay('L0.s3', 'three')));
    expect(inner.calls).toBe(before);
    await collect(cache.synthesize(lessonSay('L0.s2', 'two')));
    expect(inner.calls).toBe(before + 1);
  });

  it('never stores a sentence that was cut short', async () => {
    const inner = new CountingSynthesizer(4);
    const cache = store(inner);
    const controller = new AbortController();
    const chunks: SpeechChunk[] = [];
    for await (const chunk of cache.synthesize(
      lessonSay('L0.s1', 'Interrupted mid-', { signal: controller.signal }),
    )) {
      chunks.push(chunk);
      // A barge-in after the first frame: the rest is never heard.
      controller.abort();
    }
    expect(chunks.length).toBeLessThan(4);
    expect(cache.lessonTakes(LESSON)).toEqual([]);

    // Asked again, it is synthesised properly rather than replayed truncated.
    const full = await collect(cache.synthesize(lessonSay('L0.s1', 'Interrupted mid-')));
    expect(full).toHaveLength(4);
    expect(full.every((c) => c.reused !== true)).toBe(true);
  });

  it('survives a restart: the manifest on disk is what the next process reads', async () => {
    const inner = new CountingSynthesizer();
    const first = store(inner);
    await collect(first.synthesize(lessonSay('L0.s1', 'Persisted.')));
    expect(inner.calls).toBe(1);

    const second = store(inner);
    expect(second.lessonTakes(LESSON)).toEqual(['L0.s1']);
    const chunks = await collect(second.synthesize(lessonSay('L0.s1', 'Persisted.')));
    expect(inner.calls).toBe(1);
    expect(chunks.every((c) => c.reused === true)).toBe(true);
  });

  it('is a plain pass-through when the store is switched off', async () => {
    const inner = new CountingSynthesizer();
    const cache = new CachingSynthesizer({ inner, dir, maxBytes: 0 });
    await collect(cache.synthesize(lessonSay('L0.s1', 'No store here.')));
    await collect(cache.synthesize(lessonSay('L0.s1', 'No store here.')));
    expect(cache.enabled).toBe(false);
    expect(inner.calls).toBe(2);
    expect(cache.snapshot().says).toBe(0);
  });

  it('keeps the engine id, so pricing and telemetry still name the real provider', () => {
    expect(store(new CountingSynthesizer()).id).toBe('fish-cloud:s2.1-pro');
  });
});

/** Where a take lands on disk, for the tests that check the files themselves. */
function lessonFile(root: string, sayId: string, take: string): string {
  return join(root, LESSON.canonicalId, LESSON.band, LESSON.expertId, `${sayId}.${take}.pcm`);
}
