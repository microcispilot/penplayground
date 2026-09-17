import type { LessonPlan, ModelSessionMeta } from '@pen/contracts';
import { FakeLanguageModel, type LanguageModel, type Usage } from '@pen/llm';
import { describe, expect, it, vi } from 'vitest';
import { META_PURPOSE, type SessionMetaInput, SessionMetaJobs } from '../src/meta.js';
import { metaMessages } from '../src/prompts.js';
import type { RoomObserver } from '../src/transport.js';
import { expert } from './fixtures.js';

const plan: LessonPlan = {
  title: 'How Transformers work in LLMs',
  promise: 'Learn to read an attention diagram and explain why every piece is there.',
  band: 'beginner',
  segments: [
    { index: 0, title: 'Tokens become vectors', goal: 'g', seconds: 60, hasCheck: false },
    { index: 1, title: 'Attention: query, key, value', goal: 'g', seconds: 90, hasCheck: true },
  ],
  seconds: 150,
};

const input = (sessionId = 's_0001'): SessionMetaInput => ({
  sessionId,
  expert,
  band: 'beginner',
  topic: 'How Transformers work in LLMs',
  plan,
  language: 'en-US',
  cacheKey: 'pen:ada-okonkwo:beginner',
});

const scripted: ModelSessionMeta = {
  description: 'See how tokens become vectors and how attention scores queries against keys.',
  keywords: ['transformers', 'attention', 'tokens', 'softmax'],
  category: 'computing-data',
  thumbnail: {
    elements: [
      { kind: 'label', text: 'Attention', x: 0, y: 0, w: 6, size: 'lg', ink: 'accent' },
      { kind: 'box', x: 0, y: 2, w: 2, h: 1, text: 'the', ink: 'ink' },
      { kind: 'box', x: 3, y: 2, w: 2, h: 1, text: 'cat', ink: 'ink' },
      { kind: 'arrow', x1: 2, y1: 2.5, x2: 3, y2: 2.5, text: '', ink: 'accent' },
      // Out of grid on purpose: the job clamps, it does not reject.
      { kind: 'bars', x: 8, y: 2, w: 9, h: 9, values: [20, 80, 40], ink: 'ink' },
    ],
  },
};

const fake = () => new FakeLanguageModel([], [{ purpose: META_PURPOSE, value: scripted }]);

const usage = (): Usage => ({
  model: 'fake',
  inputTokens: 500,
  cachedTokens: 400,
  outputTokens: 200,
  usd: 0.0003,
  firstTokenMs: null,
  totalMs: 5,
});

/** A model whose completions can be failed or held open per call. */
class ControlledModel implements LanguageModel {
  readonly id = 'controlled';
  calls = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly plan: Array<'ok' | 'fail' | 'hold'>) {}
  streamEvents(): never {
    throw new Error('not used');
  }
  async complete<T>(request: {
    schema: { parse(v: unknown): T };
  }): Promise<{ value: T; usage: Usage }> {
    const step = this.plan[this.calls] ?? 'ok';
    this.calls += 1;
    if (step === 'fail') throw new Error('ECONNRESET');
    if (step === 'hold') await new Promise<void>((r) => this.waiters.push(r));
    return { value: request.schema.parse(scripted), usage: usage() };
  }
  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  get held(): number {
    return this.waiters.length;
  }
}

describe('metaMessages', () => {
  it('opens with the same persona and level prefix as the plan prompt', () => {
    const m = metaMessages(input());
    const system = m[0]?.content ?? '';
    expect(system.startsWith('YOU ARE Ada Okonkwo, Deep Learning Expert.')).toBe(true);
    expect(system).toContain('LEARNER LEVEL: beginner');
    expect(system).toContain('12 × 7 grid');
    expect(m[1]?.content).toContain('SESSION: "How Transformers work in LLMs"');
    expect(m[1]?.content).toContain('Session language: en-US');
  });
});

describe('SessionMetaJobs', () => {
  it('makes one completion, clamps the sketch and hands over a validated SessionMeta', async () => {
    const onResult = vi.fn();
    const onUsage = vi.fn();
    const jobs = new SessionMetaJobs({ model: fake(), onResult, onUsage, retryDelayMs: 0 });
    expect(jobs.enqueue(input())).toBe(true);
    // Never blocks the caller: the job runs after enqueue returns.
    expect(onResult).not.toHaveBeenCalled();
    await jobs.idle();
    expect(onResult).toHaveBeenCalledTimes(1);
    const [, result] = onResult.mock.calls[0] ?? [];
    expect(result.attempts).toBe(1);
    expect(result.meta.description).toBe(scripted.description);
    expect(result.meta.keywords).toEqual(['transformers', 'attention', 'tokens', 'softmax']);
    expect(result.meta.category).toBe('computing-data');
    const bars = result.meta.thumbnail.elements.find((e: { kind: string }) => e.kind === 'bars');
    expect(bars).toMatchObject({ x: 8, y: 2, w: 4, h: 5, values: [0.25, 1, 0.5] });
    expect(onUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: META_PURPOSE }),
    );
  });

  it('retries once on failure and succeeds on the second attempt', async () => {
    const model = new ControlledModel(['fail', 'ok']);
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const events: string[] = [];
    const observer: RoomObserver = {
      event: (name) => void events.push(name),
      error: (area) => void events.push(`error:${area}`),
    };
    const jobs = new SessionMetaJobs({
      model,
      onResult,
      onFailure,
      sleep,
      observer,
      retryDelayMs: 7,
    });
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[1].attempts).toBe(2);
    expect(onFailure).not.toHaveBeenCalled();
    expect(events).toEqual(['session_meta.queued', 'session_meta.retry', 'session_meta.done']);
  });

  it('gives up after two failures, reports once and calls onFailure', async () => {
    const model = new ControlledModel(['fail', 'fail']);
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const errors: string[] = [];
    const observer: RoomObserver = {
      event: () => undefined,
      error: (area) => void errors.push(area),
    };
    const jobs = new SessionMetaJobs({ model, onResult, onFailure, observer, retryDelayMs: 0 });
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(2);
    expect(onResult).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[2]).toBe(2);
    expect(errors).toEqual(['session_meta.failed']);
  });

  it('treats an invalid completion as a failure worth one retry', async () => {
    const broken = new FakeLanguageModel([], [{ purpose: META_PURPOSE, value: { nope: true } }]);
    const onFailure = vi.fn();
    const jobs = new SessionMetaJobs({
      model: broken,
      onResult: vi.fn(),
      onFailure,
      retryDelayMs: 0,
    });
    jobs.enqueue(input());
    await jobs.idle();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency at two and drains the rest in order', async () => {
    const model = new ControlledModel(['hold', 'hold', 'hold', 'hold']);
    const done: string[] = [];
    const jobs = new SessionMetaJobs({
      model,
      onResult: (i) => void done.push(i.sessionId),
      retryDelayMs: 0,
    });
    for (const id of ['a', 'b', 'c', 'd']) jobs.enqueue(input(id));
    await new Promise((r) => setTimeout(r, 0));
    expect(jobs.active).toBe(2);
    expect(jobs.pending).toBe(2);
    expect(model.held).toBe(2);
    model.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toEqual(['a', 'b']);
    expect(jobs.active).toBe(2);
    model.release();
    await jobs.idle();
    expect(done).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores a duplicate session while it is queued or running', async () => {
    const model = new ControlledModel(['hold']);
    const jobs = new SessionMetaJobs({ model, onResult: vi.fn(), retryDelayMs: 0 });
    expect(jobs.enqueue(input('x'))).toBe(true);
    expect(jobs.enqueue(input('x'))).toBe(false);
    model.release();
    await jobs.idle();
    expect(model.calls).toBe(1);
    expect(jobs.enqueue(input('x'))).toBe(true);
  });

  it('reports a consumer failure without retrying the model call', async () => {
    const model = new ControlledModel(['ok']);
    const errors: string[] = [];
    const jobs = new SessionMetaJobs({
      model,
      onResult: () => {
        throw new Error('disk full');
      },
      observer: { event: () => undefined, error: (area) => void errors.push(area) },
      retryDelayMs: 0,
    });
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(1);
    expect(errors).toEqual(['session_meta.consume']);
  });

  it('close() drops queued work and refuses new jobs', async () => {
    const model = new ControlledModel(['hold', 'ok']);
    const jobs = new SessionMetaJobs({ model, onResult: vi.fn(), concurrency: 1, retryDelayMs: 0 });
    jobs.enqueue(input('a'));
    jobs.enqueue(input('b'));
    jobs.close();
    expect(jobs.pending).toBe(0);
    expect(jobs.enqueue(input('c'))).toBe(false);
    model.release();
    await jobs.idle();
    expect(model.calls).toBe(1);
  });
});
