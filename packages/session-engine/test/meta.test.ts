import type {
  CostLine,
  KeyOwner,
  LessonPlan,
  ModelSessionMeta,
  StageSample,
  ThumbnailQuality,
} from '@pen/contracts';
import { imagePriceUsd, META_MAX_SUBJECT_CHARS, THUMBNAIL_SIZE } from '@pen/contracts';
import {
  FakeImageModel,
  FakeLanguageModel,
  type GeneratedImage,
  type ImageModel,
  type ImageRequest,
  type LanguageModel,
  type Usage,
} from '@pen/llm';
import { describe, expect, it, vi } from 'vitest';
import {
  META_PURPOSE,
  type SessionMetaInput,
  SessionMetaJobs,
  type SessionMetaJobsOptions,
  THUMBNAIL_PURPOSE,
  type ThumbnailImageCacheKey,
  type ThumbnailImageCachePort,
} from '../src/meta.js';
import { metaMessages, thumbnailImagePrompt } from '../src/prompts.js';
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

const input = (sessionId = 's_0001', over: Partial<SessionMetaInput> = {}): SessionMetaInput => ({
  sessionId,
  expert,
  band: 'beginner',
  topic: 'How Transformers work in LLMs',
  plan,
  language: 'en-US',
  billTo: 'free',
  cacheKey: 'pen:ada-okonkwo:beginner',
  ...over,
});

const scripted: ModelSessionMeta = {
  description: 'See how tokens become vectors and how attention scores queries against keys.',
  keywords: ['transformers', 'attention', 'tokens', 'transformers', '  '],
  category: 'computing-data',
  subject: 'a brass clock escapement, gears meshing, side light',
  headline: 'HOW ATTENTION WORKS',
};

const fake = (over: Partial<ModelSessionMeta> = {}) =>
  new FakeLanguageModel([], [{ purpose: META_PURPOSE, value: { ...scripted, ...over } }]);

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

/** An image model that records every call and can be made to fail. */
class CountingImageModel implements ImageModel {
  readonly id = 'counting';
  readonly requests: ImageRequest[] = [];
  constructor(private readonly plan: Array<'ok' | 'fail'> = []) {}
  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const step = this.plan[this.requests.length] ?? 'ok';
    this.requests.push(request);
    if (step === 'fail') throw new Error('IMAGE_NO_OUTPUT: 0 images returned');
    return {
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47, this.requests.length]),
      usage: {
        model: 'gpt-image-1',
        inputTokens: 52,
        imageInputTokens: 0,
        cachedTokens: 0,
        outputTokens: 400,
        usd: imagePriceUsd('gpt-image-1', 52, 0, 400),
        firstTokenMs: null,
        totalMs: 11_000,
      },
    };
  }
  get calls(): number {
    return this.requests.length;
  }
}

class MemoryImageCache implements ThumbnailImageCachePort {
  private readonly entries = new Map<
    string,
    { png: Buffer; usd: number; model: string; quality: ThumbnailQuality; titleDigest: string }
  >();
  async get(key: ThumbnailImageCacheKey) {
    const hit = this.entries.get(key.scope);
    if (!hit || hit.titleDigest !== key.titleDigest) return null;
    return { png: hit.png, usd: hit.usd, model: hit.model, quality: hit.quality };
  }
  async put(
    key: ThumbnailImageCacheKey,
    value: { png: Buffer; usd: number; model: string; quality: ThumbnailQuality },
  ) {
    this.entries.set(key.scope, { ...value, titleDigest: key.titleDigest });
  }
  get size(): number {
    return this.entries.size;
  }
}

/** The options every test needs, with a working image model and no cache. */
function options(over: Partial<SessionMetaJobsOptions> = {}): SessionMetaJobsOptions {
  return {
    modelFor: () => fake(),
    imageFor: () => new FakeImageModel(),
    quality: () => 'low',
    onResult: vi.fn(),
    retryDelayMs: 0,
    ...over,
  };
}

describe('metaMessages', () => {
  it('opens with the same persona and level prefix as the plan prompt, and asks only for copy', () => {
    const m = metaMessages(input());
    const system = m[0]?.content ?? '';
    expect(system.startsWith('YOU ARE Ada Okonkwo, Deep Learning Expert.')).toBe(true);
    expect(system).toContain('LEARNER LEVEL: beginner');
    expect(system).toContain('description');
    expect(system).toContain('keywords');
    // The sketch vocabulary is gone: nothing here can ask for a drawing any
    // more. (Two words are named for the opposite reason — a whiteboard, in
    // ADR-0022's list of surfaces the photographic subject must NOT be, and
    // the thumbnail the headline is printed on — so the guard is the drawing
    // ops themselves, which nothing may mention.)
    for (const word of ['grid', 'sketch', 'arrow', 'highlight'])
      expect(system.toLowerCase()).not.toContain(word);
    expect(system).toContain('- headline:');
    expect(m[1]?.content).toContain('SESSION: "How Transformers work in LLMs"');
    expect(m[1]?.content).toContain('Session language: en-US');
  });

  /**
   * ADR-0022. The field rides on the call that was already being made, so the
   * picture still costs exactly one generation and the copy exactly one
   * completion. What the prompt must carry is the *reason*: a camera cannot
   * point at an abstraction, and given one it letters a diagram instead.
   */
  it('asks for a photographable subject, and says why a camera needs one', () => {
    const system = metaMessages(input())[0]?.content ?? '';
    expect(system).toContain('- subject:');
    expect(system.toLowerCase()).toContain('camera cannot point at an abstraction');
    expect(system).toContain('noun phrase');
    // English regardless of the session language: the image prompt is English.
    expect(system).toContain('Write the subject in English');
    // Measured: two of five probe generations came back with rendered
    // characters — "$1.99" on price tags, pseudo-writing on task cards — and
    // both times the model had named a surface made to be read. The text
    // model is where that is refused; the image prompt still names nothing.
    for (const surface of ['price tag', 'whiteboard', 'sign', 'packaging', 'screen', 'sticky note'])
      expect(system).toContain(surface);
    expect(system).toContain('surface made to be read');
    // Still exactly two messages — one call, not two.
    expect(metaMessages(input())).toHaveLength(2);
  });
});

describe('thumbnailImagePrompt', () => {
  it('is the owner’s three lines, with the session title quoted into the first', () => {
    expect(thumbnailImagePrompt('Reading an ECG strip')).toBe(
      'Design a realistic thumbnail for a YouTube video titled "Reading an ECG strip".\n' +
        'Not crowded: one clear subject, plenty of empty space, no text.\n' +
        'Hyper realistic photography, natural light, shallow depth of field.',
    );
  });

  it('adds the subject as one line and leaves the owner’s three untouched', () => {
    expect(
      thumbnailImagePrompt('Reading an ECG strip', 'a nurse’s hands smoothing a paper ECG trace'),
    ).toBe(
      'Design a realistic thumbnail for a YouTube video titled "Reading an ECG strip".\n' +
        'Photograph this: a nurse’s hands smoothing a paper ECG trace.\n' +
        'Not crowded: one clear subject, plenty of empty space, no text.\n' +
        'Hyper realistic photography, natural light, shallow depth of field.',
    );
  });

  it('falls back to the title-only prompt when there is no subject', () => {
    const titleOnly = thumbnailImagePrompt('Reading an ECG strip');
    for (const missing of ['', undefined]) {
      expect(thumbnailImagePrompt('Reading an ECG strip', missing)).toBe(titleOnly);
      expect(thumbnailImagePrompt('Reading an ECG strip', missing).split('\n')).toHaveLength(3);
    }
  });

  /**
   * The owner's ask: "make sure the images that are generated has some titles
   * or text on them, not just a pure image of a place."
   */
  it('hands the model the exact words rather than letting it choose any', () => {
    const prompt = thumbnailImagePrompt(
      'Reading an ECG strip',
      'a nurse’s hands smoothing a paper ECG trace',
      'RATE, RHYTHM, INTERVALS',
    );
    expect(prompt).toContain('spelled exactly as written');
    // The title is context, not a second candidate string to set.
    expect(prompt).not.toContain('titled "Reading an ECG strip"');
    expect(prompt).toContain('RATE, RHYTHM, INTERVALS');
    // And it asks for somewhere to put them before it asks for them.
    const lines = prompt.split('\n');
    expect(lines.findIndex((l) => l.includes('empty space to the other'))).toBeLessThan(
      lines.findIndex((l) => l.includes('RATE, RHYTHM, INTERVALS')),
    );
  });

  it('stops telling the model there is no text once there is', () => {
    const withText = thumbnailImagePrompt('Reading an ECG strip', 'a paper trace', 'THREE LEADS');
    expect(withText).not.toContain('no text');
    // …and still says it when there is none, which is ADR-0021's prompt.
    expect(thumbnailImagePrompt('Reading an ECG strip', 'a paper trace')).toContain('no text');
  });

  it('is ADR-0021’s prompt exactly when the headline is empty', () => {
    const titleOnly = thumbnailImagePrompt('Reading an ECG strip');
    for (const none of ['', undefined])
      expect(thumbnailImagePrompt('Reading an ECG strip', '', none)).toBe(titleOnly);
  });

  /**
   * The two negative fixes that were tried against the real endpoint and
   * failed (ADR-0022): the second one made the lettering worse, because
   * naming a thing to an image model summons it. Nothing here may name one.
   */
  it('names nothing it does not want photographed', () => {
    const prompt = thumbnailImagePrompt('How Transformers work in LLMs', 'a brass escapement');
    for (const summoned of ['paper', 'whiteboard', 'screen', 'printout', 'diagram', 'chart'])
      expect(prompt.toLowerCase()).not.toContain(summoned);
  });
});

describe('SessionMetaJobs', () => {
  it('writes the card copy and generates exactly one picture, and hands both over', async () => {
    const onResult = vi.fn();
    const onUsage = vi.fn();
    const image = new CountingImageModel();
    const jobs = new SessionMetaJobs(
      options({ onResult, onUsage, imageFor: () => image, modelFor: () => fake() }),
    );
    expect(jobs.enqueue(input())).toBe(true);
    // Never blocks the caller: the job runs after enqueue returns.
    expect(onResult).not.toHaveBeenCalled();
    await jobs.idle();
    expect(onResult).toHaveBeenCalledTimes(1);
    const [, result] = onResult.mock.calls[0] ?? [];
    expect(result.attempts).toBe(1);
    expect(result.meta.description).toBe(scripted.description);
    // Normalised: the duplicate and the blank are gone.
    expect(result.meta.keywords).toEqual(['transformers', 'attention', 'tokens']);
    expect(result.meta.category).toBe('computing-data');
    // ONE generation per session, at the one size we ever ask for.
    expect(image.calls).toBe(1);
    expect(image.requests[0]?.size).toEqual(THUMBNAIL_SIZE);
    expect(image.requests[0]?.quality).toBe('low');
    expect(image.requests[0]?.prompt).toBe(
      thumbnailImagePrompt(plan.title, scripted.subject, scripted.headline),
    );
    expect(result.image.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.image.reused).toBe(false);
    expect(onUsage.mock.calls.map(([, u]) => u.purpose).sort()).toEqual([
      META_PURPOSE,
      THUMBNAIL_PURPOSE,
    ]);
  });

  /**
   * ADR-0022: the picture is built around the thing the copy call named, and
   * survives every way that field can fail to arrive. The fallback is not a
   * degraded mode — it is exactly the prompt ADR-0021 shipped.
   */
  describe('the subject the camera points at', () => {
    const promptFor = async (over: Partial<SessionMetaJobsOptions> = {}) => {
      const image = new CountingImageModel();
      const jobs = new SessionMetaJobs(options({ imageFor: () => image, ...over }));
      jobs.enqueue(input());
      await jobs.idle();
      return { prompt: image.requests[0]?.prompt ?? '', image };
    };

    it('builds the generation around the subject the copy call named', async () => {
      const { prompt } = await promptFor();
      expect(prompt).toContain('Photograph this: a brass clock escapement, gears meshing');
      // With a headline, the title is unquoted context — see thumbnailImagePrompt.
      expect(prompt).toContain('about How Transformers work in LLMs');
      expect(prompt).toContain(scripted.headline);
      expect(prompt).toBe(thumbnailImagePrompt(plan.title, scripted.subject, scripted.headline));
    });

    it('is still one call to each endpoint: the field rides on the copy call', async () => {
      const model = new ControlledModel(['ok']);
      const { image } = await promptFor({ modelFor: () => model });
      expect(model.calls).toBe(1);
      expect(image.calls).toBe(1);
    });

    for (const [why, subject] of [
      ['the model left it empty', ''],
      ['the model sent only whitespace', '   \n  '],
      ['the model sent nothing a lens could find', '— "" …'],
    ] as const)
      it(`falls back to the title-only prompt when ${why}`, async () => {
        const { prompt, image } = await promptFor({ modelFor: () => fake({ subject }) });
        expect(prompt).toBe(thumbnailImagePrompt(plan.title, '', scripted.headline));
        // No subject, so no `Photograph this:` line — but the headline the
        // same call produced still reaches the picture, which is the point of
        // the two fields being independent.
        expect(prompt).not.toContain('Photograph this:');
        expect(prompt).toContain(scripted.headline);
        // A missing field costs a worse picture, never the picture.
        expect(image.calls).toBe(1);
      });

    it('falls back to the title-only prompt when the copy call fails outright', async () => {
      const image = new CountingImageModel();
      const onFailure = vi.fn();
      const jobs = new SessionMetaJobs(
        options({
          modelFor: () => new ControlledModel(['fail', 'fail']),
          imageFor: () => image,
          onFailure,
        }),
      );
      jobs.enqueue(input());
      await jobs.idle();
      expect(onFailure).toHaveBeenCalledTimes(1);
      // The copy is gone; the picture is not, and it was still paid for once.
      expect(image.calls).toBe(1);
      // The call that carries both fields is the one that failed, so this is
      // ADR-0021's prompt exactly: no subject, no headline, three lines.
      expect(image.requests[0]?.prompt).toBe(thumbnailImagePrompt(plan.title));
      expect(image.requests[0]?.prompt.split('\n')).toHaveLength(3);
    });

    it('cuts a scene-length subject back to a subject before it reaches the prompt', async () => {
      const scene = `${'a weathered brass sextant on a chart table '.repeat(6)}at dawn`;
      const { prompt } = await promptFor({ modelFor: () => fake({ subject: scene }) });
      const line = prompt.split('\n')[1] ?? '';
      expect(line.startsWith('Photograph this: a weathered brass sextant')).toBe(true);
      expect(line.length).toBeLessThanOrEqual('Photograph this: .'.length + META_MAX_SUBJECT_CHARS);
      expect(prompt.split('\n')).toHaveLength(6);
    });

    /**
     * The cache lookup happens before the copy is awaited, so a lesson whose
     * picture already exists never pays the copy call's latency for a field
     * it is not going to use.
     */
    it('does not wait for the copy call when the picture comes off the cache', async () => {
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const scoped = (id: string) => input(id, { canonicalId: 'en.how-transformers-work' });
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => image, imageCache, concurrency: 1 }),
      );
      jobs.enqueue(scoped('s_first'));
      await jobs.idle();
      // The copy call now never resolves; the picture must arrive anyway.
      const held = new ControlledModel(['hold']);
      const results: Array<{ image: { reused: boolean } | null }> = [];
      const second = new SessionMetaJobs(
        options({
          modelFor: () => held,
          imageFor: () => image,
          imageCache,
          concurrency: 1,
          onResult: (_i, r) => void results.push(r),
        }),
      );
      second.enqueue(scoped('s_second'));
      await vi.waitFor(() => expect(held.held).toBe(1));
      // One generation for both sessions, and the second one is not blocked on the copy.
      expect(image.calls).toBe(1);
      held.release();
      await second.idle();
      expect(results[0]?.image?.reused).toBe(true);
    });

    it('reports whether the camera was given a subject, and what waiting for it cost', async () => {
      const events: Array<{ name: string; data: Record<string, unknown> }> = [];
      const observer: RoomObserver = {
        event: (name, data) => void events.push({ name, data }),
        error: () => undefined,
      };
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => new CountingImageModel(), observer }),
      );
      jobs.enqueue(input());
      await jobs.idle();
      const done = events.find((e) => e.name === 'session_thumbnail.done');
      expect(done?.data.subject).toBe(true);
      expect(done?.data.copyWaitMs).toEqual(expect.any(Number));

      events.length = 0;
      const blind = new SessionMetaJobs(
        options({
          modelFor: () => fake({ subject: '' }),
          imageFor: () => new CountingImageModel(),
          observer,
        }),
      );
      blind.enqueue(input('s_blind'));
      await blind.idle();
      expect(events.find((e) => e.name === 'session_thumbnail.done')?.data.subject).toBe(false);
    });
  });

  it('honours the quality setting on the generation it asks for', async () => {
    const image = new CountingImageModel();
    const jobs = new SessionMetaJobs(options({ quality: () => 'medium', imageFor: () => image }));
    jobs.enqueue(input());
    await jobs.idle();
    expect(image.requests[0]?.quality).toBe('medium');
  });

  /**
   * Change #2: every call a background job makes bills to the HOST'S plan key,
   * the one the lesson ran on. A free learner's card must never be drawn on a
   * paying tier's budget, and `platform` is only ever asked for by work that
   * belongs to no learner at all.
   */
  describe('bills to the key the job says it belongs to', () => {
    const asked = (billTo: KeyOwner) => {
      const owners: { text: KeyOwner[]; image: KeyOwner[] } = { text: [], image: [] };
      const image = new CountingImageModel();
      const jobs = new SessionMetaJobs(
        options({
          modelFor: (owner) => {
            owners.text.push(owner);
            return fake();
          },
          imageFor: (owner) => {
            owners.image.push(owner);
            return image;
          },
        }),
      );
      jobs.enqueue(input(`s_${billTo}`, { billTo }));
      return jobs.idle().then(() => owners);
    };

    for (const plan of ['free', 'standard', 'professional'] as const) {
      it(`a ${plan} host's card copy and picture both ask for the ${plan} key`, async () => {
        const owners = await asked(plan);
        expect(owners.text).toEqual([plan]);
        expect(owners.image).toEqual([plan]);
      });
    }

    it('a platform job (the backfill) asks for the platform key and no plan key', async () => {
      const owners = await asked('platform');
      expect(owners.text).toEqual(['platform']);
      expect(owners.image).toEqual(['platform']);
    });

    it('never falls back from one plan key to another', async () => {
      const seen: KeyOwner[] = [];
      const jobs = new SessionMetaJobs(
        options({
          modelFor: (owner) => {
            seen.push(owner);
            return fake();
          },
          imageFor: (owner) => {
            seen.push(owner);
            return new FakeImageModel();
          },
        }),
      );
      jobs.enqueue(input('s_a', { billTo: 'professional' }));
      jobs.enqueue(input('s_b', { billTo: 'free' }));
      await jobs.idle();
      expect(seen.filter((o) => o === 'professional')).toHaveLength(2);
      expect(seen.filter((o) => o === 'free')).toHaveLength(2);
      expect(seen).not.toContain('platform');
      expect(seen).not.toContain('standard');
    });
  });

  it('records both calls on the session telemetry port: one llm sample, one image sample, cost lines for each', async () => {
    const samples: StageSample[] = [];
    const costs: CostLine[] = [];
    const telemetry = {
      sample: (s: StageSample) => void samples.push(s),
      cost: (line: CostLine) => void costs.push(line),
      error: () => undefined,
    };
    const jobs = new SessionMetaJobs(
      options({
        modelFor: () => new ControlledModel(['ok']),
        imageFor: () => new CountingImageModel(),
      }),
    );
    jobs.enqueue({ ...input(), telemetry });
    await jobs.idle();
    expect(samples.map((s) => s.stage).sort()).toEqual(['image', 'llm']);
    expect(samples.find((s) => s.stage === 'llm')).toMatchObject({
      ok: true,
      meta: {
        purpose: META_PURPOSE,
        model: 'fake',
        tokensIn: 500,
        tokensCached: 400,
        tokensOut: 200,
      },
    });
    expect(samples.find((s) => s.stage === 'image')).toMatchObject({
      ok: true,
      meta: {
        purpose: THUMBNAIL_PURPOSE,
        model: 'gpt-image-1',
        quality: 'low',
        size: '1536x1024',
        tokensOut: 400,
        reused: false,
      },
    });
    // The picture's price is in the session ledger like any other provider call.
    expect(costs.map((c) => [c.component, c.unit, c.units])).toEqual([
      ['llm', 'tokens_in', 100],
      ['llm', 'tokens_cached', 400],
      ['llm', 'tokens_out', 200],
      ['image', 'tokens_in', 52],
      ['image', 'tokens_out', 400],
    ]);
    const imageUsd = costs.filter((c) => c.component === 'image').reduce((n, c) => n + c.usd, 0);
    expect(imageUsd).toBeCloseTo(imagePriceUsd('gpt-image-1', 52, 0, 400), 9);
    for (const c of costs)
      expect(c.meta).toMatchObject({ reused: false, purpose: expect.any(String) });
  });

  /**
   * Change #1's reuse requirement: a topic taught before must show its
   * picture again rather than pay for it again, and must say what that saved.
   */
  describe('reuse', () => {
    const withScope = (sessionId: string) =>
      input(sessionId, { canonicalId: 'en.how-transformers-work' });

    it('buys one picture when two sessions on a topic start at the same moment', async () => {
      // The cache only saves the *second* session once the first has finished
      // and written it. Two learners starting the same topic seconds apart
      // both missed, both commissioned a photograph, and at ~$0.016 each that
      // is the most expensive thing in a session bought twice. Measured on
      // production before this: two sessions on one topic, `imageReused:
      // false` on both, the second costing $0.017 against the first's $0.005.
      //
      // Concurrency 2 is the point of the test — with 1 they are serialised
      // and the cache alone would pass it.
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const results: unknown[] = [];
      const jobs = new SessionMetaJobs(
        options({
          imageFor: () => image,
          imageCache,
          concurrency: 2,
          onResult: (_i, r) => void results.push(r),
        }),
      );
      jobs.enqueue(withScope('s_together_a'));
      jobs.enqueue(withScope('s_together_b'));
      await jobs.idle();

      expect(image.calls, 'one photograph, not two').toBe(1);
      expect(imageCache.size).toBe(1);
      const reused = (results as Array<{ image: { reused: boolean; savedUsd: number } }>).map(
        (r) => r.image.reused,
      );
      // One bought it; the other took it and says what that saved.
      expect(reused.filter(Boolean)).toHaveLength(1);
      const waiter = (results as Array<{ image: { reused: boolean; savedUsd: number } }>).find(
        (r) => r.image.reused,
      );
      expect(waiter?.image.savedUsd).toBeGreaterThan(0);
    });

    it('still buys one when a third session arrives while the first two are running', async () => {
      // The claim has an owner. Two generators can both reach the claim — one
      // read the map a tick before the other wrote it — and if the first to
      // finish deletes whatever is under the key rather than its own entry,
      // the second's claim vanishes and a third session sees a free key and
      // buys the picture again. Found in review of the first version of this.
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => image, imageCache, concurrency: 3 }),
      );
      jobs.enqueue(withScope('s_three_a'));
      jobs.enqueue(withScope('s_three_b'));
      jobs.enqueue(withScope('s_three_c'));
      await jobs.idle();
      expect(image.calls, 'one photograph for three simultaneous sessions').toBe(1);
      expect(imageCache.size).toBe(1);
    });

    it('generates once for a scope and reuses the bytes for every session after', async () => {
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const results: unknown[] = [];
      const jobs = new SessionMetaJobs(
        options({
          imageFor: () => image,
          imageCache,
          concurrency: 1,
          onResult: (_i, r) => void results.push(r),
        }),
      );
      jobs.enqueue(withScope('s_first'));
      await jobs.idle();
      jobs.enqueue(withScope('s_second'));
      jobs.enqueue(withScope('s_third'));
      await jobs.idle();
      // One generation for three sessions.
      expect(image.calls).toBe(1);
      expect(imageCache.size).toBe(1);
      const [first, second, third] = results as Array<{
        image: { reused: boolean; png: Buffer; savedUsd: number; usage: unknown };
        savedUsd: number;
      }>;
      expect(first?.image.reused).toBe(false);
      expect(first?.image.savedUsd).toBe(0);
      for (const later of [second, third]) {
        expect(later?.image.reused).toBe(true);
        expect(later?.image.usage).toBeNull();
        // The same bytes, so the same picture — every size is derived from them.
        expect(later?.image.png).toEqual(first?.image.png);
        // Exactly what the original generation cost, not an estimate.
        expect(later?.image.savedUsd).toBeCloseTo(imagePriceUsd('gpt-image-1', 52, 0, 400), 9);
        expect(later?.savedUsd).toBeGreaterThanOrEqual(later?.image.savedUsd ?? 0);
      }
    });

    it('reports a reused picture as an image sample with savedUsd and no cost lines', async () => {
      const samples: StageSample[] = [];
      const costs: CostLine[] = [];
      const telemetry = {
        sample: (s: StageSample) => void samples.push(s),
        cost: (l: CostLine) => void costs.push(l),
        error: () => undefined,
      };
      const imageCache = new MemoryImageCache();
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => new CountingImageModel(), imageCache, concurrency: 1 }),
      );
      jobs.enqueue(withScope('s_one'));
      await jobs.idle();
      samples.length = 0;
      costs.length = 0;
      jobs.enqueue({ ...withScope('s_two'), telemetry });
      await jobs.idle();
      const sample = samples.find((s) => s.stage === 'image');
      expect(sample?.meta.reused).toBe(true);
      expect(sample?.meta.savedUsd).toBeCloseTo(imagePriceUsd('gpt-image-1', 52, 0, 400), 9);
      // Nothing was bought, so nothing is charged.
      expect(costs.filter((c) => c.component === 'image')).toEqual([]);
    });

    it('generates again when the title changed, because the title is the whole prompt', async () => {
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => image, imageCache, concurrency: 1 }),
      );
      jobs.enqueue(withScope('s_a'));
      await jobs.idle();
      jobs.enqueue({
        ...withScope('s_b'),
        plan: { ...plan, title: 'Attention, from scratch' },
      });
      await jobs.idle();
      expect(image.calls).toBe(2);
      expect(image.requests[1]?.prompt).toContain('Attention, from scratch');
    });

    it('does not reuse across scopes: a different lesson gets its own picture', async () => {
      const image = new CountingImageModel();
      const imageCache = new MemoryImageCache();
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => image, imageCache, concurrency: 1 }),
      );
      jobs.enqueue(withScope('s_a'));
      await jobs.idle();
      jobs.enqueue(input('s_b', { canonicalId: 'en.kalman-filters' }));
      await jobs.idle();
      expect(image.calls).toBe(2);
    });

    it('pays every time when the session never resolved to a canonical topic', async () => {
      const image = new CountingImageModel();
      const jobs = new SessionMetaJobs(
        options({ imageFor: () => image, imageCache: new MemoryImageCache(), concurrency: 1 }),
      );
      jobs.enqueue(input('s_a'));
      await jobs.idle();
      jobs.enqueue(input('s_b'));
      await jobs.idle();
      expect(image.calls).toBe(2);
    });
  });

  it('retries the copy once on failure and succeeds on the second attempt', async () => {
    const model = new ControlledModel(['fail', 'ok']);
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const events: string[] = [];
    const observer: RoomObserver = {
      event: (name) => void events.push(name),
      error: (area) => void events.push(`error:${area}`),
    };
    const jobs = new SessionMetaJobs(
      options({ modelFor: () => model, onResult, onFailure, sleep, observer, retryDelayMs: 7 }),
    );
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[1].attempts).toBe(2);
    expect(onFailure).not.toHaveBeenCalled();
    expect(events).toContain('session_meta.retry');
    expect(events).toContain('session_meta.done');
  });

  it('gives up on the copy after two failures, reports once and calls onFailure', async () => {
    const model = new ControlledModel(['fail', 'fail']);
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const errors: string[] = [];
    const observer: RoomObserver = {
      event: () => undefined,
      error: (area) => void errors.push(area),
    };
    const jobs = new SessionMetaJobs(
      options({ modelFor: () => model, onResult, onFailure, observer }),
    );
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(2);
    expect(onResult).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[2]).toBe(2);
    expect(errors).toEqual(['session_meta.failed']);
  });

  it('keeps the copy when the picture fails twice, and hands over no image', async () => {
    const image = new CountingImageModel(['fail', 'fail']);
    const onResult = vi.fn();
    const errors: string[] = [];
    const jobs = new SessionMetaJobs(
      options({
        imageFor: () => image,
        onResult,
        observer: { event: () => undefined, error: (area) => void errors.push(area) },
      }),
    );
    jobs.enqueue(input());
    await jobs.idle();
    expect(image.calls).toBe(2);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[1].image).toBeNull();
    expect(onResult.mock.calls[0]?.[1].meta.description).toBe(scripted.description);
    expect(errors).toEqual(['session_thumbnail.failed']);
  });

  it('keeps a picture it paid for even when the copy fails, so the next session gets it free', async () => {
    const image = new CountingImageModel();
    const imageCache = new MemoryImageCache();
    const jobs = new SessionMetaJobs(
      options({
        modelFor: () => new ControlledModel(['fail', 'fail']),
        imageFor: () => image,
        imageCache,
      }),
    );
    jobs.enqueue(input('s_lost', { canonicalId: 'en.how-transformers-work' }));
    await jobs.idle();
    expect(imageCache.size).toBe(1);
  });

  it('treats an invalid completion as a failure worth one retry', async () => {
    const broken = new FakeLanguageModel([], [{ purpose: META_PURPOSE, value: { nope: true } }]);
    const onFailure = vi.fn();
    const jobs = new SessionMetaJobs(options({ modelFor: () => broken, onFailure }));
    jobs.enqueue(input());
    await jobs.idle();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency at two and drains the rest in order', async () => {
    const model = new ControlledModel(['hold', 'hold', 'hold', 'hold']);
    const done: string[] = [];
    const jobs = new SessionMetaJobs(
      options({ modelFor: () => model, onResult: (i) => void done.push(i.sessionId) }),
    );
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
    const jobs = new SessionMetaJobs(options({ modelFor: () => model }));
    expect(jobs.enqueue(input('x'))).toBe(true);
    expect(jobs.enqueue(input('x'))).toBe(false);
    model.release();
    await jobs.idle();
    expect(model.calls).toBe(1);
    expect(jobs.enqueue(input('x'))).toBe(true);
  });

  it('reports a consumer failure without retrying either call', async () => {
    const model = new ControlledModel(['ok']);
    const image = new CountingImageModel();
    const errors: string[] = [];
    const jobs = new SessionMetaJobs(
      options({
        modelFor: () => model,
        imageFor: () => image,
        onResult: () => {
          throw new Error('disk full');
        },
        observer: { event: () => undefined, error: (area) => void errors.push(area) },
      }),
    );
    jobs.enqueue(input());
    await jobs.idle();
    expect(model.calls).toBe(1);
    expect(image.calls).toBe(1);
    expect(errors).toEqual(['session_meta.consume']);
  });

  it('close() drops queued work and refuses new jobs', async () => {
    const model = new ControlledModel(['hold', 'ok']);
    const jobs = new SessionMetaJobs(options({ modelFor: () => model, concurrency: 1 }));
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
