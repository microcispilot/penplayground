import type { LessonPlan } from '@pen/contracts';
import {
  type CompletionRequest,
  type EventStream,
  type EventStreamRequest,
  FakeLanguageModel,
  type FakeScript,
  type LanguageModel,
  type Usage,
} from '@pen/llm';
import type { Onten } from '@pen/onten';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import { MemoryLessonMemo } from '../src/lesson-memo.js';
import { type PlanRequest, streamPlan } from '../src/planner.js';
import { SessionRoom } from '../src/room.js';
import {
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  segmentScript,
  until,
} from './fixtures.js';

const PLAN = planCompletion(3).value;

const planRequest = (): PlanRequest => ({
  expert,
  topic: 'How Transformers work in LLMs',
  band: 'beginner',
  unitTitles: ['Tokens'],
  targetMinutes: 14,
  cacheKey: 'pen:ada-okonkwo:beginner',
  language: 'en-US',
});

/**
 * A model that writes the plan the way a provider does — the title, then the
 * promise, then one segment at a time — and holds the finished object until the
 * test releases it. Lesson calls are the ordinary scripted ones.
 */
class HeldPlanModel implements LanguageModel {
  readonly id = 'held';
  private readonly inner: FakeLanguageModel;
  /** Purposes seen, in order, so a test can see what ran while the plan was held. */
  readonly calls: string[] = [];
  private release: () => void = () => undefined;
  private readonly held: Promise<void>;
  /** Resolves once the plan's opening values have been handed over. */
  readonly offered: Promise<void>;
  private markOffered: () => void = () => undefined;

  constructor(scripts: FakeScript[] = []) {
    this.inner = new FakeLanguageModel(scripts, []);
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.offered = new Promise<void>((resolve) => {
      this.markOffered = resolve;
    });
  }

  releasePlan(): void {
    this.release();
  }

  streamEvents(request: EventStreamRequest): EventStream {
    this.calls.push(request.purpose);
    return this.inner.streamEvents(request);
  }

  async complete<T>(request: CompletionRequest<T>): Promise<{ value: T; usage: Usage }> {
    this.calls.push(request.purpose);
    if (request.purpose !== 'plan') throw new Error(`no completion for "${request.purpose}"`);
    const partial = request.partial;
    if (partial) {
      partial.onValue('title', PLAN.title);
      partial.onValue('promise', PLAN.promise);
      PLAN.segments.forEach((segment, index) => {
        partial.onValue(index, segment);
      });
    }
    this.markOffered();
    await this.held;
    return {
      value: request.schema.parse(PLAN),
      usage: {
        model: 'held',
        inputTokens: 400,
        cachedTokens: 0,
        outputTokens: 300,
        usd: 0,
        firstTokenMs: 10,
        totalMs: 20,
      },
    };
  }
}

function room(onten: Onten, id: string, model: LanguageModel, transport: MemoryTransport) {
  return new SessionRoom({
    sessionId: id,
    topic: 'How Transformers work in LLMs',
    host: { id: 'host-1234', name: 'Sam', plan: 'free' },
    expert,
    band: 'beginner',
    language: 'en',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo: new MemoryLessonMemo(),
    model,
    synthesizer: new SilentSynthesizer(),
    voice: 'voice-en',
    sampleRate: 44100,
    transport,
    acquirer: null,
    targetMinutes: 3,
  });
}

describe('streamPlan', () => {
  it('hands over the title, the promise and segment 1 before the plan is finished', async () => {
    const model = new HeldPlanModel();
    const planning = streamPlan(model, planRequest());
    const opening = await planning.opening;
    let planned: LessonPlan | null = null;
    void planning.plan.then((p) => {
      planned = p;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(planned).toBeNull();
    expect(opening.title).toBe(PLAN.title);
    expect(opening.promise).toBe(PLAN.promise);
    expect(opening.segment.index).toBe(0);
    expect(opening.segment.title).toBe('Part 1');
    expect(opening.segment.goal).toBe('Goal 1');
    expect(opening.segment.hasCheck).toBe(false);

    model.releasePlan();
    const plan = await planning.plan;
    // Everything the opening promised is what the final plan carries; only the
    // length can still move, because it is scaled across the whole session.
    const first = plan.segments[0];
    expect(first).toBeDefined();
    expect({ ...first, seconds: 0 }).toEqual({ ...opening.segment, seconds: 0 });
    expect(plan.title).toBe(opening.title);
    expect(plan.promise).toBe(opening.promise);
  });

  it('rejects the opening, not the plan, when there is no first segment to start on', async () => {
    const model = new FakeLanguageModel(
      [],
      [{ purpose: 'plan', value: { ...PLAN, segments: [] } }],
    );
    const planning = streamPlan(model, planRequest());
    await expect(planning.opening).rejects.toThrow();
    await expect(planning.plan).rejects.toThrow('PLAN_EMPTY');
  });
});

describe('the lesson is composed while the outline is still being written', () => {
  it('sends segment 1 before the plan lands, and broadcasts nothing until it has', async () => {
    const { onten } = await preparedPack();
    const model = new HeldPlanModel([segmentScript(1), segmentScript(2), segmentScript(3)]);
    const transport = new MemoryTransport();
    const live = room(onten, 'head-start', model, transport);
    const started = live.start();

    // The plan is still being written, and segment 1 is already at the provider.
    await model.offered;
    await until(() => model.calls.includes('lesson'));
    expect(live.getState().phase).toBe('preparing');
    expect(transport.cues()).toEqual([]);
    expect(transport.audio).toEqual([]);

    model.releasePlan();
    await started;
    // The room goes live with the whole plan, exactly as it always did.
    const first = transport.states().find((s) => s.phase === 'live');
    expect(first?.plan?.segments).toHaveLength(3);
    await until(() => transport.cues().length > 0);
    expect(transport.cues()[0]?.segment).toBe(0);
    // One lesson call for segment 1, not two: the head start is the call.
    expect(model.calls.filter((c) => c === 'lesson').length).toBeLessThanOrEqual(2);
    await live.end();
  });

  it('resolves `firstAudio` only once the learner can hear the expert', async () => {
    const { onten } = await preparedPack();
    const model = new HeldPlanModel([segmentScript(1), segmentScript(2), segmentScript(3)]);
    const transport = new MemoryTransport();
    const live = room(onten, 'first-audio', model, transport);
    let audible = false;
    void live.firstAudio.then(() => {
      audible = true;
    });
    const started = live.start();
    await model.offered;
    await new Promise((r) => setTimeout(r, 20));
    expect(audible).toBe(false);
    model.releasePlan();
    await started;
    await live.firstAudio;
    expect(transport.audio.length).toBeGreaterThan(0);
    await live.end();
  });
});
