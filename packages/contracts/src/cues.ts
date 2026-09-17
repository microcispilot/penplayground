import { z } from 'zod';
import { BoardId, CheckId, SayId } from './ids.js';

/**
 * Cues are the atomic units of a live lesson. The language model emits the
 * `LessonEvent` subset (strict JSON schema, every field required, nullable where
 * optional); the server wraps them into `Cue`s with sequence numbers and
 * timing, and broadcasts them to every participant. Every client renders the
 * same cue the same way (ADR-0002).
 */

/** How a board op relates to speech. `with:` paces the op to the sentence; `after:` starts when it ends. */
export const Anchor = z
  .string()
  .regex(/^(?:now|(?:after:)?(?:[A-Za-z][A-Za-z0-9]{0,7}\.)?s\d{1,4}[a-z]?)$/);
export type Anchor = z.infer<typeof Anchor>;

export const Tone = z.enum(['neutral', 'warm', 'curious', 'serious', 'playful', 'encouraging']);
export type Tone = z.infer<typeof Tone>;

export const SayEvent = z.object({
  type: z.literal('say'),
  id: SayId,
  /** One spoken sentence or short clause, ≤ ~25 words. */
  text: z.string().min(1).max(400),
  tone: Tone,
});
export type SayEvent = z.infer<typeof SayEvent>;

export const BoardOp = z.enum([
  'title', // handwritten title line
  'write', // handwritten text (a phrase, a formula, a bullet)
  'code', // code block, typewriter reveal; `lang` set
  'markdown', // small markdown block (lists, tables); typewriter reveal
  'sketch', // diagram in the sketch DSL (see docs/BOARD-DSL.md)
  'highlight', // circle/underline an existing board item (`ref`)
  'arrow', // arrow from `ref` to `ref2` with optional label in `text`
  'erase', // remove an item (`ref`) or everything ('all' in `ref`)
  'newpage', // fresh paper; previous page kept in the timeline
]);
export type BoardOp = z.infer<typeof BoardOp>;

/** Where new content lands; the model never computes pixels. */
export const Placement = z.enum(['flow', 'newline', 'column', 'beside', 'below', 'center']);
export type Placement = z.infer<typeof Placement>;

export const Emphasis = z.enum(['ink', 'accent', 'warn', 'muted']);
export type Emphasis = z.infer<typeof Emphasis>;

export const BoardEvent = z.object({
  type: z.literal('board'),
  id: BoardId,
  anchor: Anchor,
  op: BoardOp,
  /** Text, code, markdown or sketch source. Empty string when the op needs none. */
  text: z.string().max(4000),
  /** Language for `code` (e.g. "swift"); empty otherwise. */
  lang: z.string().max(32),
  /** Target for highlight/arrow/erase/beside/below; empty otherwise. */
  ref: z.string().max(16),
  /** Second target for arrows; empty otherwise. */
  ref2: z.string().max(16),
  place: Placement,
  emphasis: Emphasis,
});
export type BoardEvent = z.infer<typeof BoardEvent>;

export const CheckEvent = z.object({
  type: z.literal('check'),
  id: CheckId,
  /** The say id that asks the question aloud. */
  askedBy: SayId,
  /** 0–4 options; empty means free answer. */
  options: z.array(z.string().max(160)).max(4),
  /** Reference answer used for grading, never shown before the learner answers. */
  expected: z.string().max(400),
  /** One sentence of explanation spoken after grading. */
  explain: z.string().max(400),
});
export type CheckEvent = z.infer<typeof CheckEvent>;

export const NoteEvent = z.object({
  type: z.literal('note'),
  /** The learner's question, as understood. */
  question: z.string().max(200),
  /** 2–6 words. */
  headline: z.string().max(60),
  /** ≤ 20 words. */
  detail: z.string().max(160),
});
export type NoteEvent = z.infer<typeof NoteEvent>;

export const DoneEvent = z.object({ type: z.literal('done') });
export type DoneEvent = z.infer<typeof DoneEvent>;

export const LessonEvent = z.discriminatedUnion('type', [
  SayEvent,
  BoardEvent,
  CheckEvent,
  NoteEvent,
  DoneEvent,
]);
export type LessonEvent = z.infer<typeof LessonEvent>;

/** The strict-schema root the model is asked to produce. */
export const LessonEventEnvelope = z.object({ events: z.array(LessonEvent) });
export type LessonEventEnvelope = z.infer<typeof LessonEventEnvelope>;

/** Server-side wrapper broadcast to the room. */
export const Cue = z.object({
  seq: z.number().int().nonnegative(),
  /** Which lesson segment this cue belongs to (progress dots). */
  segment: z.number().int().nonnegative(),
  /** Which conversational thread: 'lesson' or a turn id ('t12') for answers. */
  thread: z.string().max(16),
  /** Server wall-clock at emission, ms since epoch. */
  at: z.number().int(),
  event: LessonEvent,
});
export type Cue = z.infer<typeof Cue>;
