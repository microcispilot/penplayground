import type { CostLine, StageSample } from '@pen/contracts';
import type { CompletionRequest, EventStream, EventStreamRequest, LanguageModel } from '@pen/llm';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import type { IntentClassifier, IntentDecision, IntentRequest } from '../src/intent.js';
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
  sleep,
  until,
} from './fixtures.js';

/**
 * The three-step chain in `SessionRoom.decide()`: the local heuristics, the
 * hosted classifier behind `PEN_INTENT_PROVIDER`, and the model call that has
 * always been there. Everything is asserted through the room's own surface —
 * the `room.intent` observer event and the session's telemetry — never by
 * reaching into the classifier.
 */

/** Counts what the model was actually asked, so "no network call" is a measurement. */
class CountingModel implements LanguageModel {
  readonly id: string;
  intentCalls = 0;
  constructor(private readonly inner: LanguageModel) {
    this.id = inner.id;
  }
  streamEvents(request: EventStreamRequest): EventStream {
    return this.inner.streamEvents(request);
  }
  /** The system prompt of each intent call, so "what was the model told" is measurable. */
  readonly intentPrompts: string[] = [];
  complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: never }> {
    if (request.purpose === 'intent') {
      this.intentCalls += 1;
      this.intentPrompts.push(request.messages.find((m) => m.role === 'system')?.content ?? '');
    }
    return this.inner.complete(request) as Promise<{ value: T; usage: never }>;
  }
}

/** A hosted classifier with a scripted answer, counting the turns handed to it. */
class SpyClassifier implements IntentClassifier {
  readonly id = 'typesafe/jev-1.13';
  readonly seen: IntentRequest[] = [];
  constructor(private readonly answer: () => Promise<IntentDecision>) {}
  classify(request: IntentRequest): Promise<IntentDecision> {
    this.seen.push(request);
    return this.answer();
  }
}

const decision = (
  intent: IntentDecision['intent'],
  command: IntentDecision['command'],
  confidence: number,
): IntentDecision => ({
  intent,
  command,
  confidence,
  usage: {
    model: 'typesafe/jev-1.13',
    inputTokens: 685,
    outputTokens: 128,
    usd: 0.00002877,
    totalMs: 211,
  },
});

/** The model's own scripted intent answer, distinguishable from every hosted one. */
const MODEL_INTENT = { purpose: 'intent', value: { intent: 'off_topic', command: 'none' } };

interface Harness {
  room: SessionRoom;
  model: CountingModel;
  classifier: SpyClassifier | null;
  events: Array<{ name: string; data: Record<string, unknown> }>;
  errors: Array<{ area: string; stage: unknown }>;
  samples: StageSample[];
  costs: CostLine[];
  /** Everything the room decided, in order. */
  intents(): Array<Record<string, unknown>>;
}

async function harness(opts: {
  classifier?: SpyClassifier;
  /** Omit to leave the model with no scripted intent answer, so its call fails too. */
  modelAnswers?: boolean;
}): Promise<Harness> {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const events: Harness['events'] = [];
  const errors: Harness['errors'] = [];
  const samples: StageSample[] = [];
  const costs: CostLine[] = [];
  const observer: RoomObserver = {
    event: (name, data) => events.push({ name, data }),
    error: (area, _error, data) => {
      errors.push({ area, stage: data?.stage });
      return 'sentry-ref';
    },
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
      [planCompletion(2), ...(opts.modelAnswers === false ? [] : [MODEL_INTENT])],
    ),
  );
  const room = new SessionRoom({
    sessionId: 'sess-intent',
    topic: 'How Transformers work in LLMs',
    host: { id: 'host-1234', name: 'Sam', plan: 'free' },
    expert,
    band: 'beginner',
    language: 'en',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo,
    model,
    ...(opts.classifier ? { intent: opts.classifier } : {}),
    synthesizer: new SilentSynthesizer({ realtime: false }),
    voice: 'v',
    sampleRate: 44100,
    transport,
    observer,
    acquirer: null,
    targetMinutes: 2,
    metrics: new SessionMetrics({
      sessionId: 'sess-intent',
      startedAt: Date.now(),
      onSample: (s) => samples.push(s),
      onCost: (c) => costs.push(c),
    }),
  });
  await room.start();
  await until(() => transport.audio.length > 0);
  return {
    room,
    model,
    classifier: opts.classifier ?? null,
    events,
    errors,
    samples,
    costs,
    intents: () => events.filter((e) => e.name === 'room.intent').map((e) => e.data),
  };
}

/** One learner turn, from the floor to a decision. */
async function speak(h: Harness, text: string, utteranceId = 'u1'): Promise<void> {
  const before = h.intents().length;
  h.room.handle('host-1234', { kind: 'progress', seq: 0, clockMs: 500 });
  h.room.handle('host-1234', { kind: 'interrupt', atSeq: 0, sayId: null, offsetMs: 0 });
  h.room.handle('host-1234', { kind: 'transcript', utteranceId, text, final: true });
  await until(() => h.intents().length > before);
}

/** Falls through every branch of `classifyLocally`: no "?", no wh-word, no command phrase. */
const FALLS_THROUGH = "let's move to the next bit";

describe('SessionRoom intent chain', () => {
  it('lets the local heuristics decide without touching either classifier', async () => {
    const classifier = new SpyClassifier(async () => decision('command', 'end', 1));
    const h = await harness({ classifier });

    await speak(h, 'Why do we divide by the square root of d?', 'u1');
    await speak(h, 'okay', 'u2');

    expect(h.intents().map((d) => d.via)).toEqual(['local', 'local']);
    expect(h.intents().map((d) => d.intent)).toEqual(['question', 'backchannel']);
    // Most turns must stay free: no hosted call, no model call, no cost line.
    expect(classifier.seen).toHaveLength(0);
    expect(h.model.intentCalls).toBe(0);
    expect(h.costs.filter((c) => c.component === 'intent')).toHaveLength(0);
    await h.room.end();
  });

  it('acts on a confident hosted answer and never reaches the model', async () => {
    const classifier = new SpyClassifier(async () => decision('command', 'next', 0.99));
    const h = await harness({ classifier });

    await speak(h, FALLS_THROUGH);

    expect(h.intents()[0]).toMatchObject({
      intent: 'command',
      command: 'next',
      via: 'typesafe/jev-1.13',
      confidence: 0.99,
    });
    expect(classifier.seen[0]).toMatchObject({ text: FALLS_THROUGH, pendingCheck: false });
    expect(h.model.intentCalls).toBe(0);
    // Priced in the session's own ledger, under its own stage and component.
    expect(h.samples.filter((s) => s.stage === 'intent')).toHaveLength(1);
    const line = h.costs.find((c) => c.component === 'intent');
    expect(line).toMatchObject({ unit: 'tokens_in', units: 685 });
    expect(line?.usd).toBeCloseTo(0.00002877, 12);
    await h.room.end();
  });

  it('hands an unsure answer to the model rather than acting on it', async () => {
    // A command the classifier is not sure of is the case that matters: acting
    // on this one would end the session.
    const classifier = new SpyClassifier(async () => decision('command', 'end', 0.52));
    const h = await harness({ classifier });

    await speak(h, FALLS_THROUGH);

    expect(classifier.seen).toHaveLength(1);
    expect(h.model.intentCalls).toBe(1);
    expect(h.intents()[0]).toMatchObject({
      intent: 'off_topic',
      command: 'none',
      via: 'model',
      confidence: null,
    });
    expect(h.events.some((e) => e.name === 'room.intent_unsure')).toBe(true);
    // An unsure answer is not a failure: nothing is captured for it.
    expect(h.errors).toHaveLength(0);
    await h.room.end();
  });

  it('falls to the model when the hosted call fails, and records why', async () => {
    const classifier = new SpyClassifier(() =>
      Promise.reject(new Error('DECISION_TIMEOUT: no answer in 600 ms')),
    );
    const h = await harness({ classifier });

    await speak(h, FALLS_THROUGH);

    expect(h.model.intentCalls).toBe(1);
    expect(h.intents()[0]).toMatchObject({ intent: 'off_topic', via: 'model' });
    expect(h.errors).toContainEqual({ area: 'room.intent', stage: 'intent' });
    expect(h.samples.find((s) => s.stage === 'intent')).toMatchObject({ ok: false });
    await h.room.end();
  });

  it('answers the learner as a question when every classifier is gone', async () => {
    const classifier = new SpyClassifier(() =>
      Promise.reject(new Error('DECISION_UNREACHABLE: x')),
    );
    const h = await harness({ classifier, modelAnswers: false });

    await speak(h, FALLS_THROUGH);

    // A dead classifier must not end a session, or command it in any way.
    expect(h.intents()[0]).toMatchObject({
      intent: 'question',
      command: 'none',
      via: 'default',
    });
    expect(h.errors.map((e) => e.stage)).toEqual(['intent', 'llm']);
    await h.room.end();
  });

  it('does not report a classifier that lost its race with the end of the session', async () => {
    let reject!: (error: unknown) => void;
    const classifier = new SpyClassifier(
      () =>
        new Promise<IntentDecision>((_resolve, rejectIt) => {
          reject = rejectIt;
        }),
    );
    const h = await harness({ classifier });

    h.room.handle('host-1234', { kind: 'progress', seq: 0, clockMs: 500 });
    h.room.handle('host-1234', { kind: 'interrupt', atSeq: 0, sayId: null, offsetMs: 0 });
    h.room.handle('host-1234', {
      kind: 'transcript',
      utteranceId: 'u1',
      text: FALLS_THROUGH,
      final: true,
    });
    await until(() => classifier.seen.length === 1);

    await h.room.end();
    reject(new Error('DECISION_ABORTED: the caller gave up'));
    await sleep(50);

    // A session closing is not a provider failing: no Sentry issue for it,
    // and no failed `intent` stage in the session's own Insights.
    expect(h.errors.filter((e) => e.area === 'room.intent')).toHaveLength(0);
    expect(h.samples.filter((sample) => sample.stage === 'intent')).toHaveLength(0);
    // And the room stops: an ended session buys no model call and no turn.
    expect(h.model.intentCalls).toBe(0);
    expect(h.intents()).toHaveLength(0);
  });

  it('asks both classifiers about the room it is actually in', async () => {
    const classifier = new SpyClassifier(() =>
      Promise.reject(new Error('DECISION_TIMEOUT: no answer in 600 ms')),
    );
    const h = await harness({ classifier });

    await speak(h, FALLS_THROUGH);

    // Each call reads the room at the moment it is made rather than reusing a
    // snapshot taken before the hosted await — a check-in can land inside it,
    // and a stale `pendingCheck` reads the learner's answer as a new question.
    // "listening" is the mode while a turn is being placed; by the time the
    // answer is being composed the room has already moved on to "answering",
    // which is why neither call may reuse a mode read before it.
    expect(classifier.seen[0]).toMatchObject({ mode: 'listening', pendingCheck: false });
    expect(h.model.intentPrompts[0]).toContain('Room mode: listening');
    expect(h.model.intentPrompts[0]).not.toContain('waiting for the answer');
  });

  it('uses the model alone when no hosted classifier is configured', async () => {
    const h = await harness({});

    await speak(h, FALLS_THROUGH);

    expect(h.model.intentCalls).toBe(1);
    expect(h.intents()[0]).toMatchObject({ via: 'model', confidence: null });
    expect(h.samples.some((s) => s.stage === 'intent')).toBe(false);
    // The model's own intent call stays exactly what it was: one priced llm stage.
    expect(h.samples.some((s) => s.stage === 'llm' && s.meta.purpose === 'intent')).toBe(true);
    await h.room.end();
  });
});
