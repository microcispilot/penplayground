import type { CostLine, StageSample } from '@pen/contracts';
import type { CompletionRequest, EventStream, EventStreamRequest, LanguageModel } from '@pen/llm';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import type { GradeDecision, GradeRequest, Grader } from '../src/grading.js';
import { SessionMetrics } from '../src/metrics.js';
import { SessionRoom } from '../src/room.js';
import type { RoomObserver } from '../src/transport.js';
import { expert, MemoryTransport, preparedPack, say, until } from './fixtures.js';

/**
 * The two-step chain in `SessionRoom.gradeCheck()` (ADR-0039): the hosted
 * grader decides and the expert says a line it already had; the model call
 * that used to decide and compose in one is the floor under it. Asserted
 * through the room's own surface — the `check_result` message, the spoken
 * cue, the `room.grade` event and the telemetry — never by reaching in.
 */

class CountingModel implements LanguageModel {
  readonly id: string;
  gradeCalls = 0;
  constructor(private readonly inner: LanguageModel) {
    this.id = inner.id;
  }
  streamEvents(request: EventStreamRequest): EventStream {
    return this.inner.streamEvents(request);
  }
  complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: never }> {
    if (request.purpose === 'grade') this.gradeCalls += 1;
    return this.inner.complete(request) as Promise<{ value: T; usage: never }>;
  }
}

class SpyGrader implements Grader {
  readonly id = 'jev-latest';
  readonly seen: GradeRequest[] = [];
  constructor(private readonly answer: () => Promise<GradeDecision>) {}
  grade(request: GradeRequest): Promise<GradeDecision> {
    this.seen.push(request);
    return this.answer();
  }
}

const decision = (verdict: GradeDecision['verdict'], confidence: number): GradeDecision => ({
  verdict,
  confidence,
  usage: { model: 'jev-1.13.0', inputTokens: 398, outputTokens: 20, usd: 0.0000167, totalMs: 276 },
});

/** The model's own scripted grade, distinguishable from every hosted one. */
const MODEL_GRADE = {
  purpose: 'grade',
  value: { verdict: 'partial' as const, feedback: 'The model wrote this sentence.' },
};
const EXPLAIN = 'A vector is just a list of numbers.';

interface Harness {
  room: SessionRoom;
  model: CountingModel;
  transport: MemoryTransport;
  events: Array<{ name: string; data: Record<string, unknown> }>;
  errors: Array<{ area: string; stage: unknown }>;
  samples: StageSample[];
  costs: CostLine[];
}

async function harness(opts: { grader?: Grader; language?: string }): Promise<Harness> {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const events: Harness['events'] = [];
  const errors: Harness['errors'] = [];
  const samples: StageSample[] = [];
  const costs: CostLine[] = [];
  const observer: RoomObserver = {
    event: (name, data) => events.push({ name, data }),
    error: (area, _error, data) => {
      // The Onten mock's 20 ms budget is a measurement of the machine, not of
      // the grader: on a slow CI runner the context stage reports it and the
      // exact error list below would count it as the room's (CI, 2026-09-26).
      if (area !== 'onten.over_budget') errors.push({ area, stage: data?.stage });
      return 'sentry-ref';
    },
  };
  const model = new CountingModel(
    new FakeLanguageModel(
      [
        {
          match: (r) =>
            r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 1:')),
          gapMs: 2,
          events: [say('s1', 'Each token becomes a vector.'), { type: 'done' }],
        },
        {
          match: (r) =>
            r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 2:')),
          gapMs: 2,
          events: [
            say('s1', 'Quick one: what is a vector here?'),
            {
              type: 'check',
              id: 'c1',
              askedBy: 's1',
              options: ['A word', 'A list of numbers', 'A position'],
              expected: 'A list of numbers',
              explain: EXPLAIN,
            },
            { type: 'done' },
          ],
        },
      ],
      [
        {
          purpose: 'plan',
          value: {
            title: 'How Transformers work',
            promise: 'Learn to read an attention diagram.',
            segments: [
              { title: 'Tokens', goal: 'See tokens as vectors', minutes: 1, hasCheck: false },
              { title: 'Vectors', goal: 'Vectors and positions', minutes: 1, hasCheck: true },
            ],
          },
        },
        MODEL_GRADE,
        { purpose: 'recap', value: { points: ['Tokens become vectors'] } },
      ],
    ),
  );
  const language = opts.language ?? 'en';
  // The pack is English: resolved as the API resolves it (under the English
  // title) so a lesson taught in another language still finds it.
  const resolution = await onten.registry.resolveTopic({
    text: 'How Transformers work in LLMs',
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  const room = new SessionRoom({
    sessionId: 'sess-grade',
    topic: 'How Transformers work in LLMs',
    host: { id: 'host-1234', name: 'Sam', plan: 'standard' },
    expert,
    band: 'beginner',
    language,
    locale: language === 'en' ? 'en-US' : language,
    resolution,
    onten,
    runtime: onten.newRuntime(),
    memo,
    model,
    ...(opts.grader ? { grader: opts.grader } : {}),
    synthesizer: new SilentSynthesizer({ realtime: false }),
    voice: 'v',
    sampleRate: 44100,
    transport,
    observer,
    acquirer: null,
    targetMinutes: 2,
    metrics: new SessionMetrics({
      sessionId: 'sess-grade',
      startedAt: Date.now(),
      onSample: (s) => samples.push(s),
      onCost: (c) => costs.push(c),
    }),
  });
  await room.start();
  await until(() => transport.audio.length > 0);
  return { room, model, transport, events, errors, samples, costs };
}

/** Hear the lesson up to the check, answer it, and wait for the verdict. */
async function answer(h: Harness, text: string): Promise<void> {
  h.room.handle('host-1234', { kind: 'progress', seq: 1, clockMs: 3000 });
  await until(() => h.transport.cues().some((c) => c.event.type === 'check'));
  const check = h.transport.cues().find((c) => c.event.type === 'check');
  h.room.handle('host-1234', { kind: 'progress', seq: check?.seq ?? 0, clockMs: 6000 });
  await until(() => h.room.getState().mode === 'checking');
  h.room.handle('host-1234', { kind: 'check_answer', checkId: 'L1.c1', text });
  await until(() => h.transport.messages.some((m) => m.kind === 'check_result'));
}

const grades = (h: Harness) => h.events.filter((e) => e.name === 'room.grade').map((e) => e.data);
const spokenFeedback = (h: Harness) =>
  h.transport
    .cues()
    .filter((c) => c.thread !== 'lesson' && c.event.type === 'say')
    .map((c) => (c.event.type === 'say' ? c.event.text : ''));

describe('SessionRoom check-in grading', () => {
  it('acts on a confident hosted verdict, says its own line, and never reaches the model', async () => {
    const grader = new SpyGrader(async () => decision('correct', 0.93));
    const h = await harness({ grader });
    await answer(h, 'a list of numbers');

    expect(h.transport.messages.find((m) => m.kind === 'check_result')).toMatchObject({
      checkId: 'L1.c1',
      verdict: 'correct',
    });
    expect(grades(h)).toEqual([{ verdict: 'correct', via: 'jev-latest', confidence: 0.93 }]);
    expect(h.model.gradeCalls).toBe(0);
    // The learner's words reached the grader as content and nowhere else.
    expect(grader.seen.map((r) => r.answer)).toEqual(['a list of numbers']);
    await until(() => spokenFeedback(h).length > 0);
    const [line] = spokenFeedback(h);
    expect(line).toContain(EXPLAIN);
    expect(line).not.toContain('The model wrote this sentence.');
    // Priced as the provider it is: an `intent` stage and cost line tagged `grade`.
    expect(h.samples.filter((s) => s.stage === 'intent').map((s) => s.meta.purpose)).toEqual([
      'grade',
    ]);
    expect(h.costs.filter((c) => c.component === 'intent')).toHaveLength(1);
    await h.room.end();
  });

  it('falls to the model when the hosted verdict is unsure', async () => {
    const h = await harness({ grader: new SpyGrader(async () => decision('correct', 0.55)) });
    await answer(h, 'a list of numbers');
    expect(h.events.some((e) => e.name === 'room.grade_unsure')).toBe(true);
    expect(grades(h)).toEqual([{ verdict: 'partial', via: 'model', confidence: null }]);
    expect(h.model.gradeCalls).toBe(1);
    await until(() => spokenFeedback(h).length > 0);
    expect(spokenFeedback(h)[0]).toBe('The model wrote this sentence.');
    await h.room.end();
  });

  it('falls to the model when the hosted grader fails, and records the failure without ending the check', async () => {
    const h = await harness({
      grader: new SpyGrader(async () => {
        throw new Error('DECISION_TIMEOUT: no answer in 600 ms');
      }),
    });
    await answer(h, 'a list of numbers');
    expect(grades(h)).toEqual([{ verdict: 'partial', via: 'model', confidence: null }]);
    expect(h.errors).toEqual([{ area: 'room.grade', stage: 'intent' }]);
    expect(h.samples.filter((s) => s.stage === 'intent').map((s) => s.ok)).toEqual([false]);
    await h.room.end();
  });

  it('lets the model write the feedback in a language the expert has no line for', async () => {
    const grader = new SpyGrader(async () => decision('correct', 0.99));
    const h = await harness({ grader, language: 'sw' });
    await answer(h, 'orodha ya nambari');
    // The grader was still asked — its verdict is free and fast — but the
    // words are the model's, so the verdict is the model's too.
    expect(grader.seen).toHaveLength(1);
    expect(grades(h)).toEqual([{ verdict: 'partial', via: 'model', confidence: null }]);
    await h.room.end();
  });

  it('grades with the model alone when no grader is configured — exactly as before', async () => {
    const h = await harness({});
    await answer(h, 'a list of numbers');
    expect(grades(h)).toEqual([{ verdict: 'partial', via: 'model', confidence: null }]);
    expect(h.model.gradeCalls).toBe(1);
    expect(h.samples.filter((s) => s.stage === 'intent')).toHaveLength(0);
    await h.room.end();
  });
});
