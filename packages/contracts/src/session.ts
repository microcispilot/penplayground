import { z } from 'zod';
import { ExpertId, ParticipantId, SayId, SessionId } from './ids.js';

export const SessionPhase = z.enum(['preparing', 'live', 'ended']);
export type SessionPhase = z.infer<typeof SessionPhase>;

/**
 * Mode inside the live phase. The room is always in exactly one mode; every
 * client shows it (the "Paused — you have the floor" family of hints).
 */
export const LiveMode = z.enum([
  'teaching', // expert speaking/writing the lesson
  'paused', // host paused
  'listening', // a participant has the floor
  'thinking', // transcript received, context assembled, first sentence pending (≤ 800 ms budget)
  'answering', // expert answering a question; lesson resume point held
  'checking', // expert asked a check-in and is waiting for an answer
  'complete', // lesson finished; room still open for questions
]);
export type LiveMode = z.infer<typeof LiveMode>;

export const Role = z.enum(['host', 'guest', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Participant = z.object({
  id: ParticipantId,
  name: z.string().min(1).max(60),
  role: Role,
  /** Deterministic avatar colour index. */
  hue: z.number().int().min(0).max(359),
  micOn: z.boolean(),
  joinedAt: z.number().int(),
});
export type Participant = z.infer<typeof Participant>;

export const SelectionBand = z.enum(['beginner', 'intermediate', 'advanced']);
export type SelectionBand = z.infer<typeof SelectionBand>;

export const LessonSegmentPlan = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().max(80),
  goal: z.string().max(240),
  /** Planned duration in seconds; the UI says "about 14 minutes". */
  seconds: z.number().int().positive(),
  hasCheck: z.boolean(),
});
export type LessonSegmentPlan = z.infer<typeof LessonSegmentPlan>;

export const LessonPlan = z.object({
  title: z.string().max(120),
  /** One-line promise shown on cards: "Learn to read an attention diagram…". */
  promise: z.string().max(200),
  band: SelectionBand,
  segments: z.array(LessonSegmentPlan).min(1).max(24),
  /** Total planned seconds. */
  seconds: z.number().int().positive(),
});
export type LessonPlan = z.infer<typeof LessonPlan>;

export const PreparationStage = z.enum([
  'resolving', // registry lookup
  'outlining', // curriculum + queries
  'discovering', // finding sources
  'fetching', // pulling documents
  'compiling', // Onten provisional pack
  'ready', // interactive promise resolved
  'qualified', // background pack ready
  'failed',
]);
export type PreparationStage = z.infer<typeof PreparationStage>;

export const PreparationProgress = z.object({
  stage: PreparationStage,
  /** 0–1 for the bar; monotonic. */
  fraction: z.number().min(0).max(1),
  /** Honest status line: "Reading the Swift language guide…". */
  status: z.string().max(120),
  sourcesFound: z.number().int().nonnegative(),
  sourcesFetched: z.number().int().nonnegative(),
});
export type PreparationProgress = z.infer<typeof PreparationProgress>;

export const RoomState = z.object({
  sessionId: SessionId,
  topic: z.string().max(200),
  /** BCP-47 language of the session (spoken, written, recognised). */
  language: z.string().min(2).max(12),
  expertId: ExpertId,
  phase: SessionPhase,
  mode: LiveMode,
  /** Who has the floor while listening/answering; null otherwise. */
  floor: ParticipantId.nullable(),
  hostId: ParticipantId,
  participants: z.array(Participant).max(12),
  plan: LessonPlan.nullable(),
  /** Index of the segment currently being taught. */
  segment: z.number().int().nonnegative(),
  /** Lesson clock in ms (audio-clock derived, excludes pauses). */
  clockMs: z.number().int().nonnegative(),
  preparation: PreparationProgress.nullable(),
  /** Knowledge trust for the current material. */
  evidenceTier: z.enum([
    'reviewed_pack_source',
    'authoritative_live_fact',
    'unverified_live_source',
  ]),
  startedAt: z.number().int(),
  /** Set when the session ends. */
  recap: z.array(z.string()).nullable(),
  /** Cue seq + say the lesson will continue from after the current turn/pause; null while teaching. */
  resume: z
    .object({
      seq: z.number().int().nonnegative(),
      sayId: SayId.nullable(),
      offsetMs: z.number().int().nonnegative(),
      take: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type RoomState = z.infer<typeof RoomState>;

export const MAX_PARTICIPANTS = 12;
