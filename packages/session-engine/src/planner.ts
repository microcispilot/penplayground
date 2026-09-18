import type { Expert, LessonPlan, LessonSegmentPlan, SelectionBand } from '@pen/contracts';
import type { LanguageModel } from '@pen/llm';
import { planPrompt } from './prompts.js';
import { PlanOutput, PlanSegmentOutput } from './schemas.js';

export interface PlanRequest {
  expert: Expert;
  topic: string;
  band: SelectionBand;
  unitTitles: string[];
  targetMinutes: number;
  cacheKey: string;
  /**
   * BCP-47 language of the session. The plan is read by the learner — the card
   * title, the promise, the segment names on the recap — so it is written in
   * their language, not in the language the material happens to be in.
   */
  language: string;
}

/**
 * The part of a plan the opening needs: the session's name, its promise, and
 * the first segment. The model writes them before it writes the rest of the
 * outline, and each of them is final when it lands — so the expert can start
 * composing segment 1 seconds before the outline is finished, and nothing it
 * says can be contradicted by the plan that arrives after it.
 */
export interface PlanOpening {
  title: string;
  promise: string;
  /**
   * Segment 1 as the final plan will carry it. Only `seconds` can still move:
   * the final plan scales every segment so the session adds up to the target
   * length, and that factor is not known until the last segment is written.
   */
  segment: LessonSegmentPlan;
}

export interface PlanStream {
  /** The title, the promise and segment 1, as soon as the model has written them. */
  opening: Promise<PlanOpening>;
  /** The whole plan, validated and scaled to the target length. */
  plan: Promise<LessonPlan>;
}

/**
 * Turns a topic + available material into a LessonPlan (one structured output,
 * validated), and hands over the opening the moment the model has written it.
 *
 * One request, one price, one plan: the only difference from waiting for the
 * whole object is that the caller can start on the first segment before the
 * last one exists (ADR-0019).
 */
export function streamPlan(
  model: LanguageModel,
  req: PlanRequest,
  signal?: AbortSignal,
): PlanStream {
  const gate = deferred<PlanOpening>();
  let title: string | null = null;
  let promise: string | null = null;
  let firstSegment: LessonSegmentPlan | null = null;
  const offer = (): void => {
    if (title === null || promise === null || firstSegment === null) return;
    gate.resolve({
      title: clampTitle(title),
      promise: clampPromise(promise),
      segment: firstSegment,
    });
  };

  const plan = (async (): Promise<LessonPlan> => {
    try {
      const { value } = await model.complete({
        messages: planPrompt(req),
        schema: PlanOutput,
        schemaName: 'lesson_plan',
        cacheKey: req.cacheKey,
        maxOutputTokens: 1200,
        purpose: 'plan',
        partial: {
          // Schema order is title, promise, segments: strict structured output
          // writes them in that order, so segment 1 completes the opening.
          paths: ['$.title', '$.promise', '$.segments.*'],
          onValue: (key, raw) => {
            if (key === 'title' && typeof raw === 'string') title = raw;
            else if (key === 'promise' && typeof raw === 'string') promise = raw;
            else if (key === 0 && firstSegment === null) {
              const parsed = PlanSegmentOutput.safeParse(raw);
              // A malformed first segment is not worth guessing at: the plan's
              // own validation will say so, and the opening waits for it.
              if (parsed.success) firstSegment = toSegment(parsed.data, 0, 1);
            }
            offer();
          },
        },
        ...(signal ? { signal } : {}),
      });
      const full = toLessonPlan(value, req.band, req.targetMinutes);
      // A plan whose opening never parsed still teaches; the caller just gets
      // no head start (settling is a no-op once the opening has been offered).
      gate.reject(new Error('PLAN_OPENING_MISSING'));
      return full;
    } catch (error) {
      gate.reject(error);
      throw error;
    }
  })();

  return { opening: gate.promise, plan };
}

/** A promise with its settlers, settled at most once; later calls are ignored. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let settle: ((value: T) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // The caller may never await it (the plan failed first); an unhandled
  // rejection here would be the process's problem, not the session's.
  promise.catch(() => undefined);
  let done = false;
  const once =
    <A>(fn: ((arg: A) => void) | undefined) =>
    (arg: A) => {
      if (done || !fn) return;
      done = true;
      fn(arg);
    };
  return { promise, resolve: once<T>(settle), reject: once<unknown>(fail) };
}

export function toLessonPlan(
  out: PlanOutput,
  band: SelectionBand,
  targetMinutes: number,
): LessonPlan {
  const raw = out.segments.slice(0, 24);
  if (raw.length === 0) throw new Error('PLAN_EMPTY');
  const totalMin = raw.reduce((n, s) => n + Math.max(0.5, s.minutes), 0) || targetMinutes;
  const scale = targetMinutes / totalMin;
  const segments = raw.map((s, index) => toSegment(s, index, scale));
  return {
    title: clampTitle(out.title),
    promise: clampPromise(out.promise),
    band,
    segments,
    seconds: segments.reduce((n, s) => n + s.seconds, 0),
  };
}

/** One planned segment, scaled so the session adds up to the target length. */
function toSegment(s: PlanSegmentOutput, index: number, scale: number): LessonSegmentPlan {
  return {
    index,
    title: s.title.slice(0, 80),
    goal: s.goal.slice(0, 240),
    seconds: Math.max(45, Math.round(Math.max(0.5, s.minutes) * 60 * scale)),
    hasCheck: s.hasCheck,
  };
}

const clampTitle = (s: string): string => s.slice(0, 120);
const clampPromise = (s: string): string => s.slice(0, 200);
