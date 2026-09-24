import type { CostLine, StageSample } from '@pen/contracts';
import { defaultFeaturesFor } from '@pen/contracts';
import type { CompletionRequest, EventStream, EventStreamRequest, LanguageModel } from '@pen/llm';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import { questionsUpgrade } from '../src/brain.js';
import { SessionMetrics } from '../src/metrics.js';
import { SessionRoom } from '../src/room.js';
import type { RoomObserver } from '../src/transport.js';
import {
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  say,
  segmentScript,
  until,
} from './fixtures.js';

/**
 * What a plan without answers hears (ADR-0040): the question is heard, the
 * expert says so and asks for an upgrade in one warm breath, the client is
 * told to show the way, and no model is called. The recap on such a plan is
 * the lesson's own goals. Asserted through the room's surface — cues, the
 * `nudge` message, the ledger, the model's own call count.
 */
class CountingModel implements LanguageModel {
  readonly id: string;
  calls: string[] = [];
  constructor(private readonly inner: LanguageModel) {
    this.id = inner.id;
  }
  streamEvents(request: EventStreamRequest): EventStream {
    this.calls.push(request.purpose);
    return this.inner.streamEvents(request);
  }
  complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: never }> {
    this.calls.push(request.purpose);
    return this.inner.complete(request) as Promise<{ value: T; usage: never }>;
  }
}

async function harness(opts: {
  plan: 'free' | 'standard';
  anonymous?: boolean;
  language?: string;
}) {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const samples: StageSample[] = [];
  const costs: CostLine[] = [];
  const observer: RoomObserver = {
    event: (name, data) => events.push({ name, data }),
    error: () => 'sentry-ref',
  };
  const model = new CountingModel(
    new FakeLanguageModel(
      [
        segmentScript(1, 2),
        segmentScript(2, 2),
        {
          match: (r) => r.purpose === 'turn',
          gapMs: 2,
          events: [say('a1', 'Here is the answer.'), { type: 'done' }],
        },
      ],
      [
        planCompletion(2),
        { purpose: 'intent', value: { intent: 'question', command: 'none' } },
        { purpose: 'recap', value: { points: ['Written by the model'] } },
      ],
    ),
  );
  const language = opts.language ?? 'en';
  // The pack is English: resolved under the English title, as the API does.
  const resolution = await onten.registry.resolveTopic({
    text: 'How Transformers work in LLMs',
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  const room = new SessionRoom({
    sessionId: 'sess-tiers',
    topic: 'How Transformers work in LLMs',
    host: { id: 'host-1234', name: 'Sam', plan: opts.plan, anonymous: opts.anonymous ?? false },
    expert,
    band: 'beginner',
    language,
    locale: language === 'en' ? 'en-US' : language,
    resolution,
    onten,
    runtime: onten.newRuntime(),
    memo,
    model,
    synthesizer: new SilentSynthesizer({ realtime: false }),
    voice: 'v',
    sampleRate: 44100,
    transport,
    observer,
    acquirer: null,
    targetMinutes: 2,
    metrics: new SessionMetrics({
      sessionId: 'sess-tiers',
      startedAt: Date.now(),
      onSample: (s) => samples.push(s),
      onCost: (c) => costs.push(c),
    }),
  });
  await room.start();
  await until(() => transport.audio.length > 0);
  return { room, model, transport, events, samples, costs };
}

const ask = async (h: Awaited<ReturnType<typeof harness>>, text: string) => {
  h.room.handle('host-1234', { kind: 'progress', seq: 0, clockMs: 500 });
  h.room.handle('host-1234', { kind: 'interrupt', atSeq: 0, sayId: null, offsetMs: 0 });
  h.room.handle('host-1234', { kind: 'transcript', utteranceId: 'u1', text, final: true });
  await until(() => h.transport.messages.some((m) => m.kind === 'turn_done'));
};

const turnSays = (h: Awaited<ReturnType<typeof harness>>) =>
  h.transport
    .cues()
    .filter((c) => c.thread !== 'lesson' && c.event.type === 'say')
    .map((c) => (c.event.type === 'say' ? c.event.text : ''));

describe('a plan without answers (ADR-0040)', () => {
  it('is what the free plan is by default, signed in or not', () => {
    expect(defaultFeaturesFor('free').ask_questions).toBe(false);
    expect(defaultFeaturesFor('free', 'web', { anonymous: true }).ask_questions).toBe(false);
    expect(defaultFeaturesFor('standard').ask_questions).toBe(true);
  });

  it('hears the question, asks for an upgrade in its own words, tells the client, and calls no model', async () => {
    const h = await harness({ plan: 'free', anonymous: true });
    await ask(h, 'Why do we divide by the square root of d?');
    expect(turnSays(h)).toEqual([questionsUpgrade(1, 'en')]);
    expect(h.transport.messages.some((m) => m.kind === 'nudge' && m.reason === 'questions')).toBe(
      true,
    );
    expect(h.model.calls.filter((p) => p === 'turn')).toHaveLength(0);
    expect(h.events.some((e) => e.name === 'room.question_upgrade_required')).toBe(true);
    // Recorded, so what people asked before they upgraded can be read later.
    const asked = h.transport.messages.some((m) => m.kind === 'turn_done');
    expect(asked).toBe(true);
    await h.room.end();
    // The recap is the lesson's own goals, not a model call.
    expect(h.model.calls.filter((p) => p === 'recap')).toHaveLength(0);
    expect(h.room.getState().recap).toEqual(['Goal 1', 'Goal 2']);
  });

  it('says it in the lesson’s language', async () => {
    const h = await harness({ plan: 'free', language: 'es' });
    await ask(h, '¿Por qué dividimos por la raíz de d?');
    expect(turnSays(h)[0]).toBe(questionsUpgrade(1, 'es'));
    await h.room.end();
  });

  it('answers with the model on a paid plan, and writes the recap with it', async () => {
    const h = await harness({ plan: 'standard' });
    await ask(h, 'Why do we divide by the square root of d?');
    expect(turnSays(h)).toContain('Here is the answer.');
    expect(h.transport.messages.some((m) => m.kind === 'nudge')).toBe(false);
    expect(h.model.calls.filter((p) => p === 'turn')).toHaveLength(1);
    await h.room.end();
    expect(h.room.getState().recap).toEqual(['Written by the model']);
  });
});
