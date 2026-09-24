import { z } from 'zod';
import { AdEventName, AdFormat, AdSlot } from './ads.js';
import { Cue } from './cues.js';
import { CheckId, ParticipantId, SayId, SessionId } from './ids.js';
import { Pace } from './pace.js';
import { Reaction } from './reactions.js';
import { PreparationProgress, RoomState } from './session.js';
import { InteractionName, InteractionProps } from './telemetry.js';

/**
 * Room WebSocket protocol. Text frames are JSON messages below; binary frames
 * carry audio (see `audio-frame.ts`). The bearer token travels only in the
 * first `auth` message, never in the URL.
 */

// ── client → server ──────────────────────────────────────────────────────────
export const ClientAuth = z.object({ kind: z.literal('auth'), token: z.string().min(1) });
export const ClientJoin = z.object({
  kind: z.literal('join'),
  sessionId: SessionId,
  /** Display name for guests without an account. */
  name: z.string().min(1).max(60).optional(),
});
export const ClientControl = z.object({
  kind: z.literal('control'),
  /** `discuss` is the host pausing the class to talk among themselves (ADR-0037); `resume` ends it. */
  action: z.enum(['pause', 'resume', 'end', 'next_segment', 'discuss']),
});
/** A guest raises or lowers their hand (ADR-0037). The host never needs to. */
export const ClientHand = z.object({ kind: z.literal('hand'), raised: z.boolean() });
/** Host only: take a guest out of the room. Their seat closes with `REMOVED` and they cannot rejoin. */
export const ClientRemoveParticipant = z.object({
  kind: z.literal('remove_participant'),
  participantId: ParticipantId,
});
/** Local barge-in already happened; tell the room exactly where the lesson stopped. */
export const ClientInterrupt = z.object({
  kind: z.literal('interrupt'),
  atSeq: z.number().int().nonnegative(),
  sayId: SayId.nullable(),
  offsetMs: z.number().int().nonnegative(),
});
export const ClientUtteranceStart = z.object({
  kind: z.literal('utterance_start'),
  utteranceId: z.string(),
});
export const ClientUtteranceEnd = z.object({
  kind: z.literal('utterance_end'),
  utteranceId: z.string(),
});
/** Browser-side STT delivers text instead of audio. */
export const ClientTranscript = z.object({
  kind: z.literal('transcript'),
  utteranceId: z.string(),
  text: z.string().max(4000),
  final: z.boolean(),
});
export const ClientCheckAnswer = z.object({
  kind: z.literal('check_answer'),
  checkId: CheckId,
  text: z.string().max(1000),
});
/**
 * Conductor progress from the host: `seq` is the cue just completed (a say
 * finished playing, a check reached, a board op done). Drives TTS lookahead,
 * segment lookahead and the authoritative lesson clock.
 */
export const ClientProgress = z.object({
  kind: z.literal('progress'),
  seq: z.number().int().nonnegative(),
  clockMs: z.number().int().nonnegative(),
});
/** The host's conductor finished the current turn/ad and resumed the lesson. */
export const ClientResumed = z.object({ kind: z.literal('resumed') });
/** Host only: set the room's teaching pace (broadcast to everyone via `state`; refused with NOT_HOST otherwise). */
export const ClientSetPace = z.object({ kind: z.literal('set_pace'), pace: Pace });
/**
 * A client interaction or something the client showed (ADR-0011). The server
 * stamps the time and the participant; props are codes and numbers only.
 */
export const ClientReport = z.object({
  kind: z.literal('report'),
  event: InteractionName,
  props: InteractionProps.default({}),
});
/**
 * One step of an ad's lifecycle as the host's player saw it (ADR-0014). Unlike a
 * `report`, the room validates it (host only, once per step, for an ad it sent) before it
 * lands in the ledger as an `interaction` — and, for a completed ad, as the estimated
 * revenue cost line — so a client cannot inflate the ad tally or the revenue.
 */
export const ClientAdEvent = z.object({
  kind: z.literal('ad_event'),
  adId: z.string().min(1).max(80),
  event: AdEventName,
  /** Milliseconds into the ad when the event happened. */
  atMs: z.number().int().nonnegative(),
  /** IMA error code (ad_error) or the reason that ended the ad. */
  code: z.string().max(40).optional(),
});
/**
 * A reaction from a participant (`reactions.ts`): expression without taking
 * the floor. The room rate-limits it, refuses it while an ad is up, and
 * broadcasts it; nothing else in the session reads it.
 */
export const ClientReaction = z.object({
  kind: z.literal('reaction'),
  emoji: Reaction,
});
/**
 * The longest chat line. Chat is an aside between the people in the room, not
 * a document: past a couple of sentences it stops being one and starts being
 * something that belongs on the board.
 */
export const CHAT_MAX_CHARS = 500;
/**
 * The fastest one participant may send chat. Generous — a person typing
 * quickly sends a line every second or two — and low enough that a script
 * cannot turn the room's broadcast into a firehose. Enforced in the room and
 * silent there, like the reaction rule it is modelled on: typing fast is not
 * an error anybody should be told about.
 */
export const CHAT_MIN_INTERVAL_MS = 400;
/**
 * A chat line from one participant to the others.
 *
 * **The expert never sees this.** That is the whole design, and it is the
 * same design as `ClientReaction` directly above: the room rate-limits it,
 * refuses it while an ad is up, and broadcasts it — and nothing else in the
 * session reads it. It takes no floor, interrupts no lesson, reaches no
 * model, and costs nothing.
 *
 * A real expert teaching a room does not read the side conversation, and
 * would not stop teaching because somebody typed. Asking *them* something is
 * speaking: `ClientTranscript`, the same way a person would interrupt a
 * person.
 */
export const ClientChat = z.object({
  kind: z.literal('chat'),
  text: z.string().trim().min(1).max(CHAT_MAX_CHARS),
});
export const ClientMessage = z.discriminatedUnion('kind', [
  ClientAuth,
  ClientJoin,
  ClientControl,
  ClientInterrupt,
  ClientUtteranceStart,
  ClientUtteranceEnd,
  ClientTranscript,
  ClientChat,
  ClientCheckAnswer,
  ClientProgress,
  ClientResumed,
  ClientSetPace,
  ClientReport,
  ClientAdEvent,
  ClientReaction,
  ClientHand,
  ClientRemoveParticipant,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientReport = z.infer<typeof ClientReport>;

// ── server → client ──────────────────────────────────────────────────────────
export const ServerReady = z.object({
  kind: z.literal('ready'),
  participantId: ParticipantId,
  state: RoomState,
  /** Cues emitted before this client joined, for catch-up. */
  backlog: z.array(Cue),
});
export const ServerCue = z.object({ kind: z.literal('cue'), cue: Cue });
export const ServerState = z.object({ kind: z.literal('state'), state: RoomState });
export const ServerPrep = z.object({ kind: z.literal('prep'), progress: PreparationProgress });
export const ServerCaption = z.object({
  kind: z.literal('caption'),
  participantId: ParticipantId,
  text: z.string(),
  final: z.boolean(),
});
/** Audio for `sayId` has fully streamed; total duration known. */
export const ServerSayComplete = z.object({
  kind: z.literal('say_complete'),
  sayId: SayId,
  durationMs: z.number().int().nonnegative(),
});
/** Grading outcome of a check-in. */
export const ServerCheckResult = z.object({
  kind: z.literal('check_result'),
  checkId: CheckId,
  participantId: ParticipantId,
  verdict: z.enum(['correct', 'partial', 'incorrect', 'ungraded']),
});
export const ServerAd = z.object({
  kind: z.literal('ad'),
  /** Free plan only: a skippable video ad between segments (ADR-0014). */
  adId: z.string(),
  /** Inserted after this cue seq; -1 = now, while the session is being prepared (topic miss). */
  afterSeq: z.number().int().min(-1),
  /** The learner can skip from here on, whatever the creative's own skip offset says. */
  skippableAfterMs: z.number().int().nonnegative(),
  /** Hard ceiling: the conductor resumes the lesson here even if the creative has not ended. */
  durationMs: z.number().int().positive(),
  format: AdFormat,
  /** VAST/VMAP tag the player requests through the IMA SDK; server-chosen so the network is swappable. */
  tagUrl: z.string().url(),
  slot: AdSlot,
});
/**
 * Somebody said something to the room. Stamped and echoed by the room —
 * including back to its sender — so every client shows one order.
 *
 * `name` travels with the line rather than being looked up client-side: a
 * participant can leave, and what they said stays said.
 */
export const ServerChat = z.object({
  kind: z.literal('chat'),
  participantId: ParticipantId,
  name: z.string().min(1).max(80),
  text: z.string().min(1).max(CHAT_MAX_CHARS),
  /** Server wall clock, ms since epoch. */
  at: z.number().int(),
});
/** Somebody reacted. Stamped by the room so every client shows it at the same moment. */
export const ServerReaction = z.object({
  kind: z.literal('reaction'),
  participantId: ParticipantId,
  emoji: Reaction,
  /** Server wall clock, ms since epoch. */
  at: z.number().int(),
});
/** All cues of a turn (answer or check feedback) have been emitted; once their audio has played, the host sends `resumed`. */
export const ServerTurnDone = z.object({
  kind: z.literal('turn_done'),
  thread: z.string().max(16),
});
/**
 * Tells conductors which take of a say to expect (older audio is discarded).
 *
 * `reason` says what the client has to do about audio it has *already* banked
 * for that sentence:
 *
 * - `resume` (the default) — the room is re-speaking after a pause, a barge-in
 *   or an answer, and the client dropped its bank when that began. Nothing to
 *   undo; the newer take simply plays.
 * - `pace` — the lesson is still running and the learner is mid-sentence
 *   (ADR-0010). The sentences behind the one at the speaker were re-cut at a
 *   new speed, so the client holds the newer audio until that sentence ends
 *   and swaps the bank in the gap.
 */
export const ServerSayTake = z.object({
  kind: z.literal('say_take'),
  sayId: SayId,
  take: z.number().int().nonnegative(),
  reason: z.enum(['resume', 'pace']).optional(),
});
/**
 * The room asking the client to show the way forward, calmly, beside what the
 * expert just said (ADR-0040): the learner asked a question on a plan that
 * does not include answers. What the client draws is its own; the room only
 * says why.
 */
export const ServerNudge = z.object({
  kind: z.literal('nudge'),
  reason: z.enum(['questions']),
});
export const ServerError = z.object({
  kind: z.literal('error'),
  code: z.enum([
    'UNAUTHORIZED',
    'SESSION_NOT_FOUND',
    'ROOM_FULL',
    /** The host took this participant out of the room (ADR-0037). */
    'REMOVED',
    'NOT_HOST',
    'ENTITLEMENT_REQUIRED',
    'RATE_LIMITED',
    /** The frame did not match the protocol; repeated ones close the socket. */
    'BAD_MESSAGE',
    /** The day's spend cap is holding new sessions back (ADR-0016). */
    'CAPACITY',
    'STT_UNAVAILABLE',
    'TTS_UNAVAILABLE',
    'LLM_UNAVAILABLE',
    'KNOWLEDGE_UNAVAILABLE',
    'INTERNAL',
  ]),
  message: z.string(),
  /** True when the expert has already spoken an honest line about it. */
  spoken: z.boolean(),
});
export const ServerMessage = z.discriminatedUnion('kind', [
  ServerReady,
  ServerCue,
  ServerState,
  ServerPrep,
  ServerCaption,
  ServerSayComplete,
  ServerCheckResult,
  ServerAd,
  ServerSayTake,
  ServerTurnDone,
  ServerReaction,
  ServerChat,
  ServerNudge,
  ServerError,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerErrorCode = z.infer<typeof ServerError>['code'];
