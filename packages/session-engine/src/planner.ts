import type { Expert, LessonPlan, SelectionBand } from '@pen/contracts';
import type { LanguageModel } from '@pen/llm';
import { planPrompt } from './prompts.js';
import { PlanOutput } from './schemas.js';

export interface PlanRequest {
  expert: Expert;
  topic: string;
  band: SelectionBand;
  unitTitles: string[];
  targetMinutes: number;
  cacheKey: string;
}

/** Turns a topic + available material into a LessonPlan (structured output, validated). */
export async function planLesson(
  model: LanguageModel,
  req: PlanRequest,
  signal?: AbortSignal,
): Promise<LessonPlan> {
  const { value } = await model.complete({
    messages: planPrompt(req),
    schema: PlanOutput,
    schemaName: 'lesson_plan',
    cacheKey: req.cacheKey,
    maxOutputTokens: 1200,
    purpose: 'plan',
    ...(signal ? { signal } : {}),
  });
  return toLessonPlan(value, req.band, req.targetMinutes);
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
  const segments = raw.map((s, index) => ({
    index,
    title: s.title.slice(0, 80),
    goal: s.goal.slice(0, 240),
    seconds: Math.max(45, Math.round(Math.max(0.5, s.minutes) * 60 * scale)),
    hasCheck: s.hasCheck,
  }));
  return {
    title: out.title.slice(0, 120),
    promise: out.promise.slice(0, 200),
    band,
    segments,
    seconds: segments.reduce((n, s) => n + s.seconds, 0),
  };
}
