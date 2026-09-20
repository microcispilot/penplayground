import type {
  CostLine,
  DownstreamAudioHeader,
  SayEvent,
  ServerMessage,
  StageSample,
  TelemetryPort,
} from '@pen/contracts';
import { ttsUsd } from '@pen/contracts';
import type { SpeechChunk, SpeechSynthesizer, SynthesisRequest } from '@pen/voice';
import { describe, expect, it, vi } from 'vitest';
import { SayPipeline } from '../src/speech.js';
import type { RoomObserver, RoomTransport } from '../src/transport.js';

/**
 * What a cache hit does to a session's books (ADR-0017 + ADR-0011): the
 * sentence still streams and still lands in the ledger, but it costs nothing
 * and records what buying it again would have cost, which is the number
 * `SessionTelemetry.reuse` adds up.
 */

const ENGINE = 'fish-cloud:s2.1-pro';

class Recorder implements TelemetryPort {
  samples: StageSample[] = [];
  costs: CostLine[] = [];
  sample(input: { stage: string; ms: number; ok: boolean; meta?: Record<string, unknown> }) {
    this.samples.push(input as unknown as StageSample);
  }
  cost(line: CostLine) {
    this.costs.push(line);
  }
  error() {}
}

class Transport implements RoomTransport {
  messages: ServerMessage[] = [];
  audio: DownstreamAudioHeader[] = [];
  broadcast(m: ServerMessage) {
    this.messages.push(m);
  }
  send() {}
  broadcastAudio(h: DownstreamAudioHeader) {
    this.audio.push(h);
  }
}

const observer: RoomObserver = { event: () => undefined, error: () => null };

/** Streams one frame, flagged however the test wants — a hit or a purchase. */
class FlaggedSynthesizer implements SpeechSynthesizer {
  readonly id = ENGINE;
  constructor(private readonly reused: boolean) {}
  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    yield {
      audioChunkId: 0,
      audioClockMs: 0,
      sampleRate: request.sampleRate,
      durationMs: 120,
      pcm: new Uint8Array(Math.floor((request.sampleRate * 120) / 1000) * 2),
      textSpan: null,
      ...(this.reused ? { reused: true } : {}),
    };
  }
}

const SENTENCE = 'Each token becomes a vector.';
const BYTES = new TextEncoder().encode(SENTENCE).length;

async function speak(reused: boolean) {
  const telemetry = new Recorder();
  const transport = new Transport();
  const say: SayEvent = { type: 'say', id: 's1', text: SENTENCE, tone: 'warm' };
  await new Promise<void>((resolve) => {
    const pipeline = new SayPipeline({
      synthesizer: new FlaggedSynthesizer(reused),
      voice: 'voice-en',
      sampleRate: 44100,
      transport,
      observer,
      telemetry,
      // No beat here: this is about the books, not the rhythm.
      gapAfter: () => null,
      onComplete: () => resolve(),
    });
    pipeline.enqueue(say, 'lesson');
  });
  return { telemetry, transport };
}

describe('SayPipeline and the synthesis cache', () => {
  it('bills a bought sentence at the engine price and calls it fresh', async () => {
    const { telemetry } = await speak(false);
    const cost = telemetry.costs.find((l) => l.component === 'tts');
    expect(cost).toMatchObject({ unit: 'bytes', units: BYTES, meta: { engine: ENGINE } });
    expect(cost?.usd).toBeCloseTo(ttsUsd(ENGINE, BYTES), 12);
    expect(cost?.meta.reused).toBe(false);
    expect(cost?.meta.savedUsd).toBeUndefined();

    const stage = telemetry.samples.find((s) => s.stage === 'tts');
    expect(stage?.meta.reused).toBe(false);
    expect(stage?.meta.savedUsd).toBe(0);
  });

  it('bills a cached sentence at nothing and books what it would have cost', async () => {
    const { telemetry, transport } = await speak(true);
    const cost = telemetry.costs.find((l) => l.component === 'tts');
    // The bytes are still recorded — the sentence was still spoken — but the
    // money was spent the first time a learner heard it.
    expect(cost).toMatchObject({ unit: 'bytes', units: BYTES, usd: 0 });
    expect(cost?.meta.reused).toBe(true);
    expect(cost?.meta.savedUsd).toBeCloseTo(ttsUsd(ENGINE, BYTES), 12);

    const stage = telemetry.samples.find((s) => s.stage === 'tts');
    expect(stage?.meta.reused).toBe(true);
    expect(stage?.meta.savedUsd).toBeCloseTo(ttsUsd(ENGINE, BYTES), 12);

    // And it is audio like any other: the sentence still closes on the clock.
    expect(transport.messages.some((m) => m.kind === 'say_complete')).toBe(true);
  });

  it('records exactly one cost line per sentence', async () => {
    const { telemetry } = await speak(true);
    expect(telemetry.costs.filter((l) => l.component === 'tts')).toHaveLength(1);
  });
});

/**
 * The bound that stops the room and the learner deadlocking.
 *
 * The client's player banks at most 30 s of audio and rejects what will not
 * fit; a rejected chunk is a sentence that never completes, and the progress
 * report that would have released the next one never arrives. Counting
 * sentences alone does not protect against that — three long ones are a
 * minute of speech — so the pipeline counts seconds too. A stored lesson
 * (ADR-0017) is what makes this reachable, but any fast provider can do it.
 */
class LongSynthesizer implements SpeechSynthesizer {
  readonly id = ENGINE;
  calls = 0;
  /** Twelve seconds of audio per sentence, delivered instantly. */
  async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
    this.calls += 1;
    const frames = 100; // 100 × 120 ms = 12 s
    for (let i = 0; i < frames; i += 1)
      yield {
        audioChunkId: i,
        audioClockMs: i * 120,
        sampleRate: request.sampleRate,
        durationMs: 120,
        pcm: new Uint8Array(Math.floor((request.sampleRate * 120) / 1000) * 2),
        textSpan: null,
        reused: true,
      };
  }
}

describe('how far ahead the pipeline may run', () => {
  it('stops at the audio bound, not just the sentence count, and resumes as the learner hears', async () => {
    const synthesizer = new LongSynthesizer();
    const pipeline = new SayPipeline({
      synthesizer,
      voice: 'voice-en',
      sampleRate: 44100,
      transport: new Transport(),
      observer,
      gapAfter: () => null,
      // Four sentences of headroom by count, 20 s by duration: the duration is
      // what has to bite, at two sentences.
      lookahead: 4,
      maxBankMs: 20_000,
    });
    for (let i = 0; i < 4; i += 1)
      pipeline.enqueue(
        { type: 'say', id: `s${i}`, text: `Sentence ${i}.`, tone: 'warm' },
        'lesson',
      );

    await vi.waitFor(() => expect(synthesizer.calls).toBe(2));
    // A third would put 36 s on a 30 s bank, so it waits.
    await new Promise((r) => setTimeout(r, 50));
    expect(synthesizer.calls).toBe(2);
    expect(pipeline.banked).toBeGreaterThan(20_000 - 12_000);

    // The learner hears one: there is room again, and exactly one more goes out.
    pipeline.markHeard();
    await vi.waitFor(() => expect(synthesizer.calls).toBe(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(synthesizer.calls).toBe(3);
  });
});

describe('when the learner takes the floor', () => {
  it('releases the audio budget, so the answer is never held back by audio nobody will hear', async () => {
    const synthesizer = new LongSynthesizer();
    const pipeline = new SayPipeline({
      synthesizer,
      voice: 'voice-en',
      sampleRate: 44100,
      transport: new Transport(),
      observer,
      gapAfter: () => null,
      lookahead: 4,
      maxBankMs: 20_000,
    });
    for (let i = 0; i < 4; i += 1)
      pipeline.enqueue(
        { type: 'say', id: `s${i}`, text: `Sentence ${i}.`, tone: 'warm' },
        'lesson',
      );
    await vi.waitFor(() => expect(synthesizer.calls).toBe(2));
    expect(pipeline.banked).toBeGreaterThan(20_000 - 12_000);

    // Every conductor throws its banked audio away the moment the learner takes
    // the floor, so the seconds it was holding are spent on audio nobody will
    // ever hear. The room says so, and the budget comes back at once — without
    // this, an answer queued behind a full bank would never be spoken. Measured
    // on a warm lesson-voice store: the room reached `answering` and sent no
    // turn audio at all, and the between-segment ad was never shown.
    pipeline.resetLookahead();
    expect(pipeline.banked).toBe(0);

    pipeline.enqueue({ type: 'say', id: 'answer', text: 'Good question.', tone: 'warm' }, 't1');
    await vi.waitFor(() => expect(synthesizer.calls).toBeGreaterThanOrEqual(3));
  });
});

/**
 * The lookahead budget, and the one way it silently stopped being a budget.
 *
 * `enqueued - heardUpTo` is how many sentences have been bought ahead of what
 * the learner has heard, and the pipeline stops synthesising when that
 * reaches `lookahead`. A barge-in calls `cancel()`, which throws away the
 * audio nobody will hear and rebases the count: `enqueued = heardUpTo`.
 *
 * But the host's progress reports are asynchronous, and `room.ts`'s
 * `progress` walks *every* lesson sentence between the last report and this
 * one, calling `markHeard()` for each. The reports for sentences the barge-in
 * has already written off arrive afterwards — and `markHeard` raised
 * `heardUpTo` with nothing on the other side, so the difference went negative
 * and the window grew, permanently, once per late report.
 *
 * Which costs money in exactly the place the budget exists to protect: more
 * sentences synthesised ahead than the room allows, and every one of them
 * thrown away by the next barge-in. `started.shift()` on an empty array is a
 * silent no-op, so nothing said a word about it.
 */
describe('the lookahead budget', () => {
  /** Completes at once, and counts how many sentences the pipeline let through. */
  class CountingSynthesizer implements SpeechSynthesizer {
    readonly id = ENGINE;
    calls = 0;
    async *synthesize(request: SynthesisRequest): AsyncIterable<SpeechChunk> {
      this.calls += 1;
      yield {
        audioChunkId: 0,
        audioClockMs: 0,
        sampleRate: request.sampleRate,
        durationMs: 120,
        pcm: new Uint8Array(Math.floor((request.sampleRate * 120) / 1000) * 2),
        textSpan: null,
      };
    }
  }

  function pipelineOf(inner: CountingSynthesizer) {
    return new SayPipeline({
      synthesizer: inner,
      voice: 'voice-en',
      sampleRate: 44100,
      transport: new Transport(),
      observer,
      telemetry: new Recorder(),
      lookahead: 3,
      gapAfter: () => null,
    });
  }

  const sentences = (n: number, from = 0): SayEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      type: 'say' as const,
      id: `s${from + i}`,
      text: SENTENCE,
      tone: 'warm' as const,
    }));

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('stops at the lookahead when nothing has been heard', async () => {
    const inner = new CountingSynthesizer();
    const pipeline = pipelineOf(inner);
    for (const say of sentences(10)) pipeline.enqueue(say, 'lesson');
    await settle();
    expect(inner.calls).toBe(3);
  });

  it('is not widened by progress reports that arrive after a barge-in', async () => {
    const inner = new CountingSynthesizer();
    const pipeline = pipelineOf(inner);
    for (const say of sentences(10)) pipeline.enqueue(say, 'lesson');
    await settle();
    expect(inner.calls).toBe(3);

    // The learner cuts in: everything not yet heard is thrown away and the
    // budget is rebased.
    pipeline.cancel();
    // Their conductor's progress for the sentences played before the barge-in
    // now lands. `room.ts` walks every lesson sentence between the last
    // report and this one and reports each one heard.
    for (let i = 0; i < 3; i += 1) pipeline.markHeard();
    await settle();

    // The lesson resumes. It may run three sentences ahead — no more.
    for (const say of sentences(10, 100)) pipeline.enqueue(say, 'lesson');
    await settle();
    expect(inner.calls).toBe(6);
  });

  it('cannot be widened without bound by a client that keeps reporting', async () => {
    const inner = new CountingSynthesizer();
    const pipeline = pipelineOf(inner);
    pipeline.cancel();
    for (let i = 0; i < 40; i += 1) pipeline.markHeard();
    for (const say of sentences(10)) pipeline.enqueue(say, 'lesson');
    await settle();
    expect(inner.calls).toBe(3);
  });
});
