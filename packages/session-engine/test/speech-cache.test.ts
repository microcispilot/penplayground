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
import { describe, expect, it } from 'vitest';
import { SayPipeline } from '../src/speech.js';
import type { RoomObserver, RoomTransport } from '../src/transport.js';

/**
 * What a cache hit does to a session's books (ADR-0016 + ADR-0011): the
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
