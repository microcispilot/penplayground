import { z } from 'zod';
import { Cue } from './cues.js';
import { CheckId, ParticipantId, SayId, SessionId } from './ids.js';
import { PreparationProgress, RoomState } from './session.js';

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
  action: z.enum(['pause', 'resume', 'end', 'next_segment']),
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
export const ClientMessage = z.discriminatedUnion('kind', [
  ClientAuth,
  ClientJoin,
  ClientControl,
  ClientInterrupt,
  ClientUtteranceStart,
  ClientUtteranceEnd,
  ClientTranscript,
  ClientCheckAnswer,
  ClientProgress,
  ClientResumed,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

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
  /** Free plan only: a skippable card between segments. */
  adId: z.string(),
  /** Inserted after this cue seq. */
  afterSeq: z.number().int().nonnegative(),
  skippableAfterMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});
/** All cues of a turn (answer or check feedback) have been emitted; once their audio has played, the host sends `resumed`. */
export const ServerTurnDone = z.object({
  kind: z.literal('turn_done'),
  thread: z.string().max(16),
});
/** Tells conductors which take of a say to expect (older audio is discarded). */
export const ServerSayTake = z.object({
  kind: z.literal('say_take'),
  sayId: SayId,
  take: z.number().int().nonnegative(),
});
export const ServerError = z.object({
  kind: z.literal('error'),
  code: z.enum([
    'UNAUTHORIZED',
    'SESSION_NOT_FOUND',
    'ROOM_FULL',
    'NOT_HOST',
    'ENTITLEMENT_REQUIRED',
    'RATE_LIMITED',
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
  ServerError,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerErrorCode = z.infer<typeof ServerError>['code'];
