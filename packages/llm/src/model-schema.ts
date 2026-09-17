import { z } from 'zod';

/**
 * The model-facing schema (strict structured outputs: every field required,
 * no length constraints, `additionalProperties: false`). Elements are
 * re-validated against the richer `LessonEvent` contract after parsing.
 */
const SayId = z.string().regex(/^s\d+$/);
const BoardId = z.string().regex(/^b\d+$/);
const CheckId = z.string().regex(/^c\d+$/);

export const ModelSay = z.object({
  type: z.literal('say'),
  id: SayId,
  text: z.string(),
  tone: z.enum(['neutral', 'warm', 'curious', 'serious', 'playful', 'encouraging']),
});
export const ModelBoard = z.object({
  type: z.literal('board'),
  id: BoardId,
  anchor: z.string().regex(/^(now|s\d+|after:s\d+)$/),
  op: z.enum([
    'title',
    'write',
    'code',
    'markdown',
    'sketch',
    'highlight',
    'arrow',
    'erase',
    'newpage',
  ]),
  text: z.string(),
  lang: z.string(),
  ref: z.string(),
  ref2: z.string(),
  place: z.enum(['flow', 'newline', 'column', 'beside', 'below', 'center']),
  emphasis: z.enum(['ink', 'accent', 'warn', 'muted']),
});
export const ModelCheck = z.object({
  type: z.literal('check'),
  id: CheckId,
  askedBy: SayId,
  options: z.array(z.string()),
  expected: z.string(),
  explain: z.string(),
});
export const ModelNote = z.object({
  type: z.literal('note'),
  language: z.string(),
  question: z.string(),
  headline: z.string(),
  detail: z.string(),
});
export const ModelDone = z.object({ type: z.literal('done') });

export const ModelEvent = z.discriminatedUnion('type', [
  ModelSay,
  ModelBoard,
  ModelCheck,
  ModelNote,
  ModelDone,
]);
export const ModelEnvelope = z.object({ events: z.array(ModelEvent) });
export type ModelEnvelope = z.infer<typeof ModelEnvelope>;
