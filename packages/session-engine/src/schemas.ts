import { z } from 'zod';

/** Model-facing structured-output schemas (strict: every field required). */
export const PlanOutput = z.object({
  title: z.string(),
  promise: z.string(),
  segments: z.array(
    z.object({
      title: z.string(),
      goal: z.string(),
      minutes: z.number(),
      hasCheck: z.boolean(),
    }),
  ),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const GradeOutput = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  /** ≤ 30 words, spoken. */
  feedback: z.string(),
});
export type GradeOutput = z.infer<typeof GradeOutput>;

export const RecapOutput = z.object({
  points: z.array(z.string()),
});
export type RecapOutput = z.infer<typeof RecapOutput>;

export const IntentOutput = z.object({
  intent: z.enum(['question', 'clarify', 'backchannel', 'command', 'answer', 'off_topic']),
  command: z.enum(['none', 'pause', 'resume', 'repeat', 'next', 'slower', 'end']),
});
export type IntentOutput = z.infer<typeof IntentOutput>;
