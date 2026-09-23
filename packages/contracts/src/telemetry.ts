import { z } from 'zod';
import { ExpertId, ParticipantId, SessionId } from './ids.js';

/**
 * Session telemetry (ADR-0011): every stage of a session is timed, every
 * provider call is priced, every learner interaction and every screen
 * transition is recorded, and every captured error keeps its Sentry
 * reference. All four are ledger entries too, so a saved session carries its
 * own telemetry; the same records stream to PostHog. Content never appears
 * here: codes, counts and timings only.
 */

// ── stages ───────────────────────────────────────────────────────────────────
export const StageName = z.enum([
  'intake', // topic language + title (API, before the room exists)
  'resolve', // registry lookup
  'context', // Onten query for a segment or a question
  'prepare', // topic miss: sources gathered until the interactive promise
  'llm', // one model call (plan, lesson segment, turn, intent, grade, recap, outline)
  'intent', // one hosted intent classification (the decisions model in front of the `llm` fallback)
  'image', // one image generation (the session thumbnail)
  'tts', // one synthesised sentence
  'stt', // one utterance: client endpoint → provider final
  'board', // one board op rendered by the host's conductor (client-reported)
  'turn', // learner's final transcript → first audible chunk of the reply
  'ad', // one ad card, shown → skipped/ended (client-reported)
  'join', // a participant took a seat (marker, ms = 0)
  'leave', // a participant left (marker, ms = 0)
]);
export type StageName = z.infer<typeof StageName>;

/** Meta values are codes and numbers, never content; strings stay short so nothing sentence-like fits. */
export const MetaValue = z.union([z.string().max(64), z.number(), z.boolean()]);
export const Meta = z.record(z.string().min(1).max(40), MetaValue);
export type Meta = z.infer<typeof Meta>;

export const StageSample = z.object({
  stage: StageName,
  /** Start of the stage, ms since the session started. */
  t: z.number().int().nonnegative(),
  /** Duration, ms. */
  ms: z.number().nonnegative(),
  ok: z.boolean(),
  /**
   * e.g. thread, sayId, take, firstTokenMs, firstChunkMs, model, provider, purpose.
   * Generation-capable stages carry `reused` (served from earlier work) and
   * `savedUsd` (what generating fresh would have cost).
   */
  meta: Meta,
});
export type StageSample = z.infer<typeof StageSample>;

// ── costs ────────────────────────────────────────────────────────────────────
/**
 * What produced a line. `ads` is the one credit: an estimated revenue line per completed
 * ad (ADR-0014) whose `usd` is what was earned — reported as `cost.revenueUsd`, never
 * added to `cost.totalUsd`.
 */
export const CostComponent = z.enum([
  'llm',
  'intent',
  'image',
  'tts',
  'stt',
  'search',
  'onten',
  'ads',
]);
export type CostComponent = z.infer<typeof CostComponent>;

export const CostUnit = z.enum([
  'tokens_in', // uncached input tokens
  'tokens_cached', // cached input tokens
  'tokens_out',
  'bytes', // UTF-8 bytes synthesised
  'seconds', // audio seconds recognised
  'requests',
]);
export type CostUnit = z.infer<typeof CostUnit>;

export const CostLine = z.object({
  component: CostComponent,
  unit: CostUnit,
  units: z.number().nonnegative(),
  usd: z.number().nonnegative(),
  /** e.g. model, provider, purpose. */
  meta: Meta,
});
export type CostLine = z.infer<typeof CostLine>;

// ── interactions ─────────────────────────────────────────────────────────────
/**
 * What a participant did and what they were shown, as the client saw it.
 * `latency.*` props carry client-measured numbers (ms).
 */
export const InteractionName = z.enum([
  // what the learner did
  'question_typed',
  'question_spoken',
  /**
   * A question the prepared material had nothing on (Onten answered
   * `missing`): the expert redirected in one breath, no model was called,
   * and the words are in the host's own recording for anyone asking why.
   */
  'question_out_of_scope',
  /** A guest was told the room is being recorded, as Zoom tells a caller. */
  'recording_notice_shown',
  // the floor in a room (ADR-0037)
  'hand_raised',
  'hand_lowered',
  /** The expert called on the first hand in the queue. */
  'hand_called',
  /** Called on, and lowered the hand before saying anything. */
  'hand_withdrawn',
  /** Called on, and said nothing for the wait. */
  'hand_unanswered',
  'discussion_started',
  'discussion_ended',
  'participant_removed',
  'check_answered',
  'interrupt',
  'pause',
  'resume',
  'ad_skipped',
  'ad_clicked',
  'captions_on',
  'captions_off',
  'mic_on',
  'mic_off',
  // The device cannot listen: no microphone, permission refused, no recognizer.
  // A condition of the learner's machine, recorded so it is visible, never an error.
  'speech_unavailable',
  'fullscreen',
  /** A participant reacted without taking the floor (`reactions.ts`). */
  'reaction_sent',
  /** A chat line between participants. Counted, never read: the expert does not see chat. */
  'chat_sent',
  /** The session panel (AI human, the call, the conversation) folded away or came back. */
  'panel_collapsed',
  'panel_opened',
  'pace_changed',
  'leave',
  'end',
  'download_requested',
  /** A saved lesson started again as a fresh session of the learner's own (ADR-0035). */
  'quick_start',
  'replay_started',
  'replay_seeked',
  // what was shown
  'screen_shown',
  'phase_shown',
  'note_shown',
  'check_shown',
  'ad_shown',
  'ad_ended',
  // the ad player's lifecycle (ADR-0014), host-validated by the room before it lands
  'ad_requested',
  'ad_loaded',
  'ad_started',
  'ad_first_quartile',
  'ad_midpoint',
  'ad_third_quartile',
  'ad_completed',
  'ad_error',
  'recap_shown',
  'first_audio',
  'answer_started',
  'board_done',
  'error_shown',
  // the room's own controls, as the learner reached for them
  /** The host muted one guest's voice to the room, or everyone's. */
  'participant_muted',
  /** The learner pressed "Enable sound" after the browser held the audio back. */
  'sound_enabled',
  /** The socket dropped and the client is reconnecting on its own. */
  'connection_lost',
  /** The learner asked to reconnect after the automatic attempts gave up. */
  'reconnect_requested',
]);
export type InteractionName = z.infer<typeof InteractionName>;

// ── actions outside a room ───────────────────────────────────────────────────
/**
 * What a visitor decided anywhere that is not a live session: every CTA on
 * Home, the catalogue, a saved page, Pricing, the sign-in dialog, Settings
 * and the account page (ADR-0038). Interactions above are a *session's*
 * record and travel to its ledger; these are the *visit's* and travel to
 * PostHog only, with the same rule — codes, ids, counts and booleans, never
 * a word the visitor typed. The list is closed so a new button cannot invent
 * a name nobody will find in a dashboard.
 *
 * The one deliberate overlap is `screen_shown`, which stays an interaction
 * because a room and a replay are screens too.
 */
export const ActionName = z.enum([
  // deciding to learn
  /** Start on Home or the not-found page; `source`, `withExpert`, `spoken` (typed by voice). */
  'start_clicked',
  /** The server said no: `code` is the API error (ENTITLEMENT_REQUIRED, CAPACITY, PREPARATION_REQUIRED, RATE_LIMITED…). */
  'start_refused',
  /** "Say it instead" on Home; `available` says whether the device could listen. */
  'say_it_clicked',
  'expert_chosen',
  'expert_cleared',
  'topic_chosen',
  'session_opened',
  'join_clicked',
  'watch_recording_clicked',
  // what the page put in the way
  /** The allowance or capacity line appeared on Home; `reason`. */
  'limit_shown',
  /** The "needs preparing" line appeared on Home; `ready` is how many lessons it offered. */
  'unprepared_shown',
  'upgrade_clicked',
  // money
  'billing_interval_changed',
  'plan_selected',
  'checkout_failed',
  'manage_subscription_clicked',
  // identity
  'sign_in_opened',
  /** A step of the email flow was submitted; `mode`. */
  'sign_in_submitted',
  'sign_in_failed',
  'signed_in',
  'signed_out',
  'name_changed',
  'account_delete_opened',
  'account_deleted',
  // keeping and sharing
  'liked',
  'unliked',
  'saved',
  'unsaved',
  'share_clicked',
  'share_page_opened',
  'visibility_changed',
  'session_deleted',
  'download_variant_changed',
  'download_failed',
  'session_tab_shown',
  // replay controls that are not the session's own record
  'replay_rate_changed',
  'replay_back_clicked',
  'replay_refused',
  // the shell
  'theme_changed',
  'board_chosen',
  'ink_chosen',
  'sidebar_toggled',
  'menu_opened',
  'nav_clicked',
  'home_clicked',
  // privacy
  'privacy_opened',
  'analytics_toggled',
  'data_download_clicked',
  // recovering
  'retry_clicked',
]);
export type ActionName = z.infer<typeof ActionName>;

/** Interaction props are bounded so the ledger and PostHog never carry a sentence. */
export const InteractionProps = z
  .record(z.string().min(1).max(40), MetaValue)
  .refine((props) => Object.keys(props).length <= 16, { message: 'too many props' });
export type InteractionProps = z.infer<typeof InteractionProps>;

export const InteractionEvent = z.object({
  /** ms since the session started (stamped by the server). */
  t: z.number().int().nonnegative(),
  participantId: ParticipantId,
  event: InteractionName,
  props: InteractionProps,
});
export type InteractionEvent = z.infer<typeof InteractionEvent>;

// ── errors ───────────────────────────────────────────────────────────────────
export const ErrorEvent = z.object({
  /** ms since the session started. */
  t: z.number().int().nonnegative(),
  /** Stable code or area ("room.answer", "PEN_STT_TIMEOUT", "TTS_UPSTREAM_502"). */
  code: z.string().min(1).max(80),
  stage: StageName.nullable(),
  /** Sentry event id, or null when Sentry was not configured. */
  ref: z.string().max(64).nullable(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

// ── the computed summary ─────────────────────────────────────────────────────
export const Percentiles = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  /** Sample count. */
  n: z.number().int().nonnegative(),
});
export type Percentiles = z.infer<typeof Percentiles>;

export const CostByComponent = z.object({
  usd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  units: z.partialRecord(CostUnit, z.number().nonnegative()),
});
export type CostByComponent = z.infer<typeof CostByComponent>;

/**
 * How much of this session was served from work done before (ADR-0011,
 * "zero redundant generation"): the registry pack instead of a preparation,
 * the lesson memo instead of model calls, a speculative Onten assembly
 * instead of a query, the intake cache instead of a translation.
 */
export const ReuseSummary = z.object({
  /** The topic resolved to an existing qualified pack (no preparation). */
  packHit: z.boolean(),
  /** Lesson segments served from the memo vs generated by the model. */
  memoSegmentsReused: z.number().int().nonnegative(),
  memoSegmentsGenerated: z.number().int().nonnegative(),
  /** Onten queries answered by a speculative assembly on the partial transcript. */
  contextSpeculationHits: z.number().int().nonnegative(),
  intakeCacheHit: z.boolean(),
  /** Sentences played from the synthesis cache vs bought from the engine (ADR-0017). */
  ttsSentencesReused: z.number().int().nonnegative(),
  ttsSentencesGenerated: z.number().int().nonnegative(),
  /** What the reused work would have cost to generate fresh (same price tables). */
  savedUsd: z.number().nonnegative(),
  /** cost.totalUsd + savedUsd: the session with zero reuse. */
  freshEquivalentUsd: z.number().nonnegative(),
});
export type ReuseSummary = z.infer<typeof ReuseSummary>;

export const SessionTelemetry = z.object({
  sessionId: SessionId,
  plan: z.string(),
  expertId: ExpertId,
  language: z.string(),
  /** `${lang}.${slug}` from the Onten registry; null when the session never resolved. */
  canonicalId: z.string().nullable(),
  totals: z.object({
    durationMs: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
    says: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    interrupts: z.number().int().nonnegative(),
    adsShown: z.number().int().nonnegative(),
    adsSkipped: z.number().int().nonnegative(),
    participants: z.number().int().nonnegative(),
  }),
  latency: z.object({
    /** Start click → first audible audio (client-measured; server estimate when the client did not report). */
    timeToFirstAudioMs: z.number().nullable(),
    /** Final transcript → first audible chunk of the reply. */
    questionToFirstAudioMs: Percentiles,
    llmFirstTokenMs: Percentiles,
    ttsFirstChunkMs: Percentiles,
    sttFinalMs: Percentiles,
    /** Speech detected → playback faded (client-measured). */
    bargeInMs: Percentiles,
  }),
  cost: z.object({
    /** Provider spend; never includes the ad credit. */
    totalUsd: z.number().nonnegative(),
    /** Estimated ad revenue (the `ads` lines), labelled as an estimate wherever it is shown. */
    revenueUsd: z.number().nonnegative(),
    byComponent: z.partialRecord(CostComponent, CostByComponent),
    lines: z.array(CostLine),
  }),
  reuse: ReuseSummary,
  stages: z.array(StageSample),
  interactions: z.array(InteractionEvent),
  errors: z.array(ErrorEvent),
});
export type SessionTelemetry = z.infer<typeof SessionTelemetry>;

// ── the port instrumented modules write to ───────────────────────────────────
export interface SampleInput {
  stage: StageName;
  ms: number;
  ok: boolean;
  meta?: Meta;
  /** Wall-clock start (ms epoch). Defaults to now − ms. */
  startedAt?: number;
}

export interface ErrorInput {
  code: string;
  stage: StageName | null;
  ref: string | null;
}

/**
 * Where stage timings, cost lines and errors go. The session engine's
 * `SessionMetrics` implements it (ledger + sinks); modules that run per
 * session but live elsewhere (TTS pipeline, STT router, knowledge builder,
 * model wrapper) receive it as a dependency and never know about the ledger.
 */
export interface TelemetryPort {
  sample(input: SampleInput): void;
  cost(line: CostLine): void;
  error(input: ErrorInput): void;
}

export const NULL_TELEMETRY: TelemetryPort = {
  sample: () => undefined,
  cost: () => undefined,
  error: () => undefined,
};
