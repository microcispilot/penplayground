import { z } from 'zod';
import { ExpertId, ParticipantId, SayId, SessionId } from './ids.js';
import { Pace } from './pace.js';

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
  'discussing', // the host paused the class to talk among themselves; the expert waits and hears nobody (ADR-0037)
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
  /**
   * Participants can hear each other over the media server (LiveKit): the host's plan
   * carries `rooms` and the server has a media server configured. Absent = false, so
   * older ledgers and replays validate unchanged.
   */
  participantAudio: z.boolean().optional(),
  /**
   * The room's furniture, decided by the host's plan and platform when the
   * room was built (ADR-0036): whether the chat, the reactions and the CC
   * control exist here at all. Every client draws from this rather than from
   * its own answer, so a guest on a phone sees the same room as the host.
   * Absent = all on, so older ledgers and replays validate unchanged.
   */
  features: z
    .object({ chat: z.boolean(), reactions: z.boolean(), captions: z.boolean() })
    .optional(),
  /**
   * Guests waiting to be called on, in the order they raised their hands
   * (ADR-0037). The expert takes the first at the next good place to stop.
   * Absent on older ledgers.
   */
  hands: z.array(z.object({ participantId: ParticipantId, at: z.number().int() })).optional(),
  /**
   * The guest the expert has just called on and is waiting to hear from:
   * they hold the floor without having spoken yet. Null otherwise.
   */
  invited: ParticipantId.nullable().optional(),
  plan: LessonPlan.nullable(),
  /** Index of the segment currently being taught. */
  segment: z.number().int().nonnegative(),
  /** Lesson clock in ms (audio-clock derived, excludes pauses). */
  clockMs: z.number().int().nonnegative(),
  /**
   * Teaching pace set by the host (1 = a patient teacher; see pace.ts). Scales
   * the voice, the pauses and the board together; takes effect from the next
   * sentence synthesised.
   */
  pace: Pace,
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

/**
 * What somebody who opens a room's link is shown before they take a seat
 * (ADR-0058): whose room it is, what is being taught, who is already in it,
 * and whether this caller may come in. The server decides `access` from the
 * caller's plan and the room's seats, so a client never reasons about plans.
 */
export const RoomInviteReason = z.enum([
  /** The caller is the host. */
  'host',
  /** Joining a room needs a paid plan (`join_rooms`). */
  'subscription_required',
  'room_full',
  /** The session has ended, or is not live yet. */
  'ended',
]);
export type RoomInviteReason = z.infer<typeof RoomInviteReason>;

export const RoomInvitePerson = z.object({
  name: z.string().min(1).max(60),
  /** Deterministic avatar colour index, the same one the roster draws. */
  hue: z.number().int().min(0).max(359),
});
export type RoomInvitePerson = z.infer<typeof RoomInvitePerson>;

export const RoomInvite = z.object({
  sessionId: SessionId,
  topic: z.string().max(200),
  title: z.string().max(200),
  expertId: ExpertId,
  host: RoomInvitePerson,
  /** Everyone seated but the host, in the order they arrived. */
  guests: z.array(RoomInvitePerson).max(MAX_PARTICIPANTS),
  seats: z.object({
    taken: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }),
  phase: SessionPhase,
  startedAt: z.number().int(),
  access: z.object({
    canJoin: z.boolean(),
    reason: RoomInviteReason.nullable(),
  }),
});
export type RoomInvite = z.infer<typeof RoomInvite>;

/**
 * "Sam, Ana and 5 others are learning together": the host first, then the
 * guests as they arrived, two names at most and the rest counted. One name
 * is a host waiting for company, and says so.
 */
export function describeCompany(names: readonly string[]): string {
  const [first, second, ...rest] = names;
  if (!first) return 'The room is open';
  if (!second) return `${first} is waiting for you`;
  if (rest.length === 0) return `${first} and ${second} are learning together`;
  if (rest.length === 1) return `${first}, ${second} and ${rest[0]} are learning together`;
  return `${first}, ${second} and ${rest.length} others are learning together`;
}
