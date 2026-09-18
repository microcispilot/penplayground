import type {
  AdEventName,
  AdSlot,
  CheckEvent,
  ClientMessage,
  ClientReport,
  Cue,
  Expert,
  GapKind,
  LedgerEntry,
  LessonEvent,
  LessonPlan,
  LiveMode,
  NoteEvent,
  Participant,
  ParticipantId,
  PlanCode,
  PreparationProgress,
  QueryInput,
  RoomState,
  SayEvent,
  SelectionBand,
  ServerErrorCode,
  StageName,
  TelemetryPort,
} from '@pen/contracts';
import {
  clampPace,
  freshEstimateUsd,
  hasEntitlement,
  MAX_PARTICIPANTS,
  PACE_DEFAULT,
  PLAN_LIMITS,
  prepareFreshEstimateUsd,
  slowerPreset,
} from '@pen/contracts';
import type { LanguageModel } from '@pen/llm';
import { withTelemetry } from '@pen/llm';
import type { LessonMemo, MockContextRuntime, Onten, TopicResolution } from '@pen/onten';
import type { SpeechSynthesizer } from '@pen/voice';
import { nanoid } from 'nanoid';
import { acknowledgement, bridgeBack, classifyLocally } from './brain.js';
import { type Metrics, NullMetrics } from './metrics.js';
import { planLesson } from './planner.js';
import {
  answerMessages,
  gradeMessages,
  intentMessages,
  lessonSystemPrompt,
  recapMessages,
  segmentMessages,
} from './prompts.js';
import { GradeOutput, IntentOutput, RecapOutput } from './schemas.js';
import { SayPipeline } from './speech.js';
import { type RoomObserver, type RoomTransport, SILENT_OBSERVER } from './transport.js';

/** Client reports accepted per participant per session (a 20-minute session produces a few hundred). */
export const MAX_REPORTS_PER_PARTICIPANT = 5000;
/** Prompt-cache key shared by every call of a session (and the background meta call): persona + level prefix. */
export function roomCacheKey(expertId: string, band: SelectionBand): string {
  return `pen:${expertId}:${band}`;
}

/** Topic-miss acquisition seam: the knowledge package implements it; tests use a stub. */
export interface KnowledgeAcquirer {
  /**
   * Find, fetch and stream sources for a topic into Onten's progressive
   * compiler. Resolves the pack id once the interactive promise is satisfied;
   * keeps compiling in the background. Progress is reported for the Preparing
   * screen.
   */
  prepare(args: {
    resolution: TopicResolution;
    onProgress: (progress: PreparationProgress) => void;
    signal: AbortSignal;
    /** Search requests and outline calls are priced into this session (ADR-0011). */
    telemetry?: TelemetryPort;
  }): Promise<{ packId: string; provisional: boolean; background: Promise<unknown> }>;
}

/** An ad lifecycle step as the host's player reported it, attributed to its slot (ADR-0014). */
export interface AdOutcome {
  sessionId: string;
  adId: string;
  slot: AdSlot;
  event: AdEventName;
  atMs: number;
  code: string | null;
}

/** Free-plan ad policy for one room; null on paid plans or when no demand is configured. */
export interface AdPolicy {
  /** One ad every N segments (a preparation ad consumes the first slot). */
  everySegments: number;
  /** Hard ceiling per ad; the conductor resumes the lesson here. */
  durationMs: number;
  skippableAfterMs: number;
  /** VAST/VMAP tag handed to every ad of this room; the network is swappable here alone. */
  tagUrl: string;
  /**
   * Estimated revenue per completed ad (eCPM / 1000), written to the session ledger as an
   * `ads` cost line (ADR-0011) so Insights and PostHog see it beside the spend; 0 = no line.
   */
  revenuePerCompletionUsd?: number;
  /** Ad outcomes, once each, for revenue estimates and analytics. */
  onEvent?: (outcome: AdOutcome) => void;
}

export interface LedgerSink {
  append(sessionId: string, entry: LedgerEntry): void;
  /** Persist audio bytes and return a reference for the ledger. */
  storeAudio(
    sessionId: string,
    sayId: string,
    take: number,
    chunkId: number,
    pcm: Uint8Array,
  ): string;
}

export interface SessionRoomDeps {
  sessionId: string;
  topic: string;
  host: { id: ParticipantId; name: string; plan: PlanCode };
  expert: Expert;
  band: SelectionBand;
  language: string;
  locale: string;
  /** Already-resolved topic (the API resolves before creating the room); resolved here when absent. */
  resolution?: TopicResolution;
  onten: Onten;
  runtime: MockContextRuntime;
  memo: LessonMemo;
  model: LanguageModel;
  synthesizer: SpeechSynthesizer;
  /** Engine voice for this expert (resolved from the catalog voice id). */
  voice: string;
  /** The persona's voice for a communication language; falls back to `voice`. */
  voiceFor?: (language: string) => string;
  /** Detects the language of a learner utterance (BCP-47) or null when unsure. */
  languageOf?: (text: string) => Promise<string | null> | string | null;
  sampleRate: 24000 | 44100 | 48000;
  transport: RoomTransport;
  observer?: RoomObserver;
  acquirer: KnowledgeAcquirer | null;
  ledger?: LedgerSink;
  targetMinutes?: number;
  ads?: AdPolicy | null;
  /** Initial teaching pace (the host's remembered preference arrives as `set_pace` right after join). */
  pace?: number;
  /** The API has a media server for human-to-human audio; the host's plan still decides. */
  participantAudio?: boolean;
  now?: () => number;
  /** Stage timings, costs, interactions and errors for this session (ADR-0011); NullMetrics when absent. */
  metrics?: Metrics;
  /** Search provider name, for pricing what a pack hit saved (defaults to Tavily's price). */
  searchProvider?: string;
}

/** Longest the closing beat of a sentence waits for the cue after it before defaulting to a plain sentence gap. */
const GAP_DECISION_WAIT_MS = 300;

interface Turn {
  id: string;
  participantId: ParticipantId;
  question: string;
  sayIds: Set<string>;
  completed: Set<string>;
  done: boolean;
  /** When the learner's final words arrived; the `turn` stage runs from here to the first audible chunk. */
  startedAt: number;
  firstAudioAt: number | null;
  kind: 'question' | 'clarify' | 'check';
}

/**
 * The classroom brain. Owns the session state machine, the lesson generation
 * loop, the turn loop, TTS dispatch, host/guest authority and the recording
 * ledger. Everything the clients see leaves through `transport`.
 */
export class SessionRoom {
  readonly sessionId: string;
  private readonly d: SessionRoomDeps;
  private readonly observer: RoomObserver;
  private readonly now: () => number;
  /** Public so the API can add what it measures itself (STT finals). */
  readonly metrics: Metrics;
  private readonly model: LanguageModel;
  private state: RoomState;
  private readonly participants = new Map<ParticipantId, Participant>();
  private readonly cues: Cue[] = [];
  private seq = 0;
  private plan: LessonPlan | null = null;
  private readonly system: string;
  private readonly pipeline: SayPipeline;
  private readonly lessonSays = new Map<string, { say: SayEvent; seq: number; segment: number }>();
  private readonly lessonOrder: string[] = [];
  private readonly segmentEvents = new Map<number, LessonEvent[]>();
  private readonly spoken: string[] = [];
  private readonly questions: string[] = [];
  private readonly takes = new Map<string, number>();
  private readonly checks = new Map<string, { check: CheckEvent; question: string; seq: number }>();
  /** Says that ask a check-in / carry a board title: they get the longer beat after them. */
  private readonly checkAskers = new Set<string>();
  private readonly titleSays = new Set<string>();
  private readonly seqOfSay = new Map<string, number>();
  /** Sentences whose closing beat waits for the cue after them (see `gapAfter`). */
  private cueWaiters: Array<() => void> = [];
  private pendingCheck: { check: CheckEvent; question: string } | null = null;
  private hostProgressSeq = -1;
  private firstSeqOfSegment: number[] = [];
  private lastSeqOfSegment: number[] = [];
  private turn: Turn | null = null;
  private turnCounter = 0;
  private readonly abort = new AbortController();
  private lessonComplete = false;
  private resolution: TopicResolution | null = null;
  private memoHit: { id: string; cuesBySegment: LessonEvent[][]; segmentUsd: number[] } | null =
    null;
  private packId: string | null = null;
  private packRevision: string | null = null;
  private packQualified = false;
  /** Segments this session generated (index → cues + what the call cost), memoised as they land. */
  private memoPending: Promise<void> = Promise.resolve();
  /** The last lesson-segment model call's cost, read back from the metrics stream. */
  private lastLessonUsd = 0;
  private pausedBeforeTurn: LiveMode = 'teaching';
  private adsShown = 0;
  /** Ads this room broadcast, with the lifecycle steps already accepted for each (host-reported, once). */
  private readonly adsSent = new Map<string, { slot: AdSlot; seen: Set<AdEventName> }>();
  private clockMs = 0;
  private lastFloorUtterance = new Map<string, string>();
  /** Communication language: follows the learner turn by turn (RoomState.language). */
  private language: string;
  /** Arrival of the learner's last final transcript / typed answer; consumed by the next turn. */
  private turnStartedAt: number | null = null;
  /** Reports accepted per participant; a runaway client cannot grow the ledger without bound. */
  private readonly reportCounts = new Map<ParticipantId, number>();

  constructor(deps: SessionRoomDeps) {
    this.d = deps;
    this.sessionId = deps.sessionId;
    this.observer = deps.observer ?? SILENT_OBSERVER;
    this.now = deps.now ?? (() => Date.now());
    this.metrics = deps.metrics ?? new NullMetrics();
    const metered = withTelemetry(deps.model, this.metrics);
    // Remember what the plan call cost so the memo can report exactly what a reuse saves.
    this.model = {
      id: metered.id,
      streamEvents: (r) => metered.streamEvents(r),
      complete: async (r) => {
        const result = await metered.complete(r);
        if (r.purpose === 'plan') this.lastLessonUsd = result.usage.usd;
        return result;
      },
    };
    this.system = lessonSystemPrompt(deps.expert, deps.band);
    this.language = deps.language;
    const host: Participant = {
      id: deps.host.id,
      name: deps.host.name,
      role: 'host',
      hue: hueFor(deps.host.id),
      micOn: false,
      joinedAt: this.now(),
    };
    this.participants.set(host.id, host);
    this.state = {
      sessionId: deps.sessionId,
      topic: deps.topic,
      language: deps.language,
      expertId: deps.expert.id,
      phase: 'preparing',
      mode: 'teaching',
      floor: null,
      hostId: host.id,
      participants: [host],
      participantAudio: Boolean(deps.participantAudio) && hasEntitlement(deps.host.plan, 'rooms'),
      plan: null,
      segment: 0,
      clockMs: 0,
      pace: clampPace(deps.pace ?? PACE_DEFAULT),
      preparation: {
        stage: 'resolving',
        fraction: 0.02,
        status: 'Finding the right material…',
        sourcesFound: 0,
        sourcesFetched: 0,
      },
      evidenceTier: 'reviewed_pack_source',
      startedAt: this.now(),
      recap: null,
      resume: null,
    };
    this.pipeline = new SayPipeline({
      synthesizer: deps.synthesizer,
      voice: deps.voice,
      sampleRate: deps.sampleRate,
      transport: {
        broadcast: (m) => deps.transport.broadcast(m),
        send: (p, m) => deps.transport.send(p, m),
        broadcastAudio: (header, pcm) => {
          deps.transport.broadcastAudio(header, pcm);
          if (deps.ledger) {
            const audioRef = deps.ledger.storeAudio(
              deps.sessionId,
              header.sayId,
              header.take,
              header.audioChunkId,
              pcm,
            );
            deps.ledger.append(deps.sessionId, { kind: 'audio', t: this.now(), header, audioRef });
          }
        },
      },
      observer: this.observer,
      pace: () => this.state.pace,
      // Only the taught lesson is shared material (ADR-0017). A question, the
      // answer to it, a check-in verdict or an honest line about a failure
      // belongs to the learner who prompted it: spoken fresh, never stored,
      // never handed to another room. The session's own ledger still records
      // all of it, which is where observability looks.
      lessonFor: (say, thread) =>
        thread === 'lesson' && this.resolution
          ? {
              canonicalId: this.resolution.canonicalKnowledgeId,
              band: this.d.band,
              expertId: this.d.expert.id,
              sayId: say.id,
            }
          : null,
      gapAfter: (say) => this.gapAfter(say),
      telemetry: this.metrics,
      onComplete: (sayId) => this.onSayComplete(sayId),
      onFailure: (sayId, error) => this.onSayFailure(sayId, error),
      onFirstChunk: (sayId, thread) => this.onFirstChunk(sayId, thread),
    });
    this.ledger({ kind: 'join', t: this.now(), participantId: host.id, name: host.name });
    this.metrics.sample({
      stage: 'join',
      ms: 0,
      ok: true,
      meta: {
        role: 'host',
        participants: 1,
        plan: deps.host.plan,
        expertId: deps.expert.id,
        language: deps.language,
      },
    });
  }

  // ── public surface ─────────────────────────────────────────────────────────

  getState(): RoomState {
    return this.state;
  }

  backlog(): Cue[] {
    return this.cues;
  }

  /** Begin: resolve the topic, prepare if needed, plan, then teach. Never throws; failures are spoken and reported. */
  async start(): Promise<void> {
    try {
      await this.resolveAndPrepare();
      if (this.abort.signal.aborted) return;
      await this.makePlan();
      if (this.abort.signal.aborted) return;
      this.state = { ...this.state, phase: 'live', mode: 'teaching', preparation: null };
      this.broadcastState();
      void this.generateLoop().catch((error) => this.fail('room.generate_loop', error, null));
    } catch (error) {
      this.fail('room.start', error, 'prepare');
      this.failSession(
        'KNOWLEDGE_UNAVAILABLE',
        "I couldn't get this session ready. Let's try again in a moment.",
      );
    }
  }

  /** Seats in this room, host included: the host's plan decides (PLAN_LIMITS). */
  get seats(): number {
    return Math.min(MAX_PARTICIPANTS, PLAN_LIMITS[this.d.host.plan].maxParticipants);
  }

  join(participant: {
    id: ParticipantId;
    name: string;
  }): { ok: true; participant: Participant } | { ok: false; code: ServerErrorCode } {
    const existing = this.participants.get(participant.id);
    if (existing) return { ok: true, participant: existing };
    // Entitlement first: on a solo plan the honest answer is "rooms are a
    // Professional feature", not "this room is full" — one seat is not a crowd.
    if (!hasEntitlement(this.d.host.plan, 'rooms'))
      return { ok: false, code: 'ENTITLEMENT_REQUIRED' };
    if (this.participants.size >= this.seats) return { ok: false, code: 'ROOM_FULL' };
    const p: Participant = {
      id: participant.id,
      name: participant.name,
      role: 'guest',
      hue: hueFor(participant.id),
      micOn: false,
      joinedAt: this.now(),
    };
    this.participants.set(p.id, p);
    this.ledger({ kind: 'join', t: this.now(), participantId: p.id, name: p.name });
    this.metrics.sample({
      stage: 'join',
      ms: 0,
      ok: true,
      meta: { role: 'guest', participants: this.participants.size },
    });
    this.syncParticipants();
    return { ok: true, participant: p };
  }

  leave(participantId: ParticipantId): void {
    if (!this.participants.has(participantId)) return;
    if (participantId === this.state.hostId) {
      // The host keeps their seat; the room waits for them (host-only pause semantics).
      if (this.state.phase === 'live' && this.state.mode === 'teaching') this.setMode('paused');
      return;
    }
    this.participants.delete(participantId);
    this.ledger({ kind: 'leave', t: this.now(), participantId });
    this.metrics.sample({
      stage: 'leave',
      ms: 0,
      ok: true,
      meta: { role: 'guest', participants: this.participants.size },
    });
    if (this.state.floor === participantId) this.endTurnEarly();
    this.syncParticipants();
  }

  handle(participantId: ParticipantId, message: ClientMessage): void {
    const p = this.participants.get(participantId);
    if (!p) return;
    switch (message.kind) {
      case 'control':
        this.control(p, message.action);
        break;
      case 'interrupt':
        this.interrupt(p, message);
        break;
      case 'transcript':
        this.transcript(p, message.utteranceId, message.text, message.final);
        break;
      case 'check_answer':
        this.turnStartedAt = this.now();
        void this.gradeCheck(p, message.checkId, message.text);
        break;
      case 'report':
        this.report(p, message.event, message.props);
        break;
      case 'progress':
        this.progress(p, message.seq, message.clockMs);
        break;
      case 'resumed':
        this.resumed(p);
        break;
      case 'set_pace':
        this.setPace(p, message.pace);
        break;
      case 'utterance_start':
        p.micOn = true;
        break;
      case 'utterance_end':
        p.micOn = false;
        break;
      case 'ad_event':
        this.adEvent(p, message);
        break;
      default:
        break;
    }
  }

  /** Audio from a participant's mic (when STT runs server-side); the API routes STT output back through `transcript`. */
  async end(): Promise<void> {
    if (this.state.phase === 'ended') return;
    this.abort.abort();
    this.pipeline.close();
    let recap: string[] = [];
    if (this.plan && this.spoken.length > 0) {
      try {
        const { value } = await this.model.complete({
          messages: recapMessages({
            system: this.system,
            plan: this.plan,
            spoken: this.spoken,
            questions: this.questions,
            language: this.language,
          }),
          schema: RecapOutput,
          schemaName: 'recap',
          cacheKey: this.cacheKey(),
          maxOutputTokens: 400,
          purpose: 'recap',
        });
        recap = value.points.slice(0, 6).map((s) => s.slice(0, 120));
      } catch (error) {
        this.fail('room.recap', error, 'llm');
        recap = this.plan.segments.slice(0, 6).map((s) => s.goal);
      }
    }
    this.state = { ...this.state, phase: 'ended', mode: 'complete', floor: null, recap };
    this.broadcastState();
    this.observer.event('room.ended', {
      sessionId: this.sessionId,
      cues: this.cues.length,
      questions: this.questions.length,
      segments: this.state.segment,
    });
  }

  // ── preparation & planning ─────────────────────────────────────────────────

  private async resolveAndPrepare(): Promise<void> {
    let resolution = this.d.resolution ?? null;
    if (!resolution) {
      const timer = this.metrics.start('resolve');
      try {
        resolution = await this.d.onten.registry.resolveTopic({
          text: this.d.topic,
          // Packs are keyed by language, never by region.
          language: this.d.language.split('-')[0] ?? this.d.language,
          locale: this.d.locale,
          band: this.d.band,
        });
        const hit =
          resolution.match === 'hit' ||
          (resolution.match === 'partial' && resolution.packId !== null);
        timer.end(true, {
          canonicalId: resolution.canonicalKnowledgeId,
          match: resolution.match,
          score: resolution.score,
          reused: hit,
          savedUsd: hit
            ? prepareFreshEstimateUsd(this.d.model.id, this.d.searchProvider ?? 'tavily')
            : 0,
        });
      } catch (error) {
        timer.end(false);
        throw error;
      }
    }
    this.resolution = resolution;
    this.observer.event('room.resolve', {
      match: resolution.match,
      score: resolution.score,
      ckid: resolution.canonicalKnowledgeId,
    });
    const packHit =
      resolution.match === 'hit' || (resolution.match === 'partial' && resolution.packId !== null);
    if (this.d.resolution) {
      // The API resolved (and timed) the topic; the room records what the hit saved.
      this.metrics.sample({
        stage: 'resolve',
        ms: 0,
        ok: true,
        meta: {
          canonicalId: resolution.canonicalKnowledgeId,
          match: resolution.match,
          score: resolution.score,
          reused: packHit,
          savedUsd: packHit
            ? prepareFreshEstimateUsd(this.d.model.id, this.d.searchProvider ?? 'tavily')
            : 0,
          viaApi: true,
        },
      });
    }
    if (packHit && resolution.packId) {
      this.packId = resolution.packId;
      // The persona's own memo for this scope and band: the plan and every segment it holds are reused.
      const memo = await this.d.memo.find(
        resolution.canonicalKnowledgeId,
        this.d.band,
        this.d.expert.id,
      );
      if (memo) {
        this.memoHit = {
          id: memo.id,
          cuesBySegment: memo.cuesBySegment as LessonEvent[][],
          segmentUsd: memo.costUsd.segments,
        };
        this.plan = memo.plan as LessonPlan;
        await this.d.memo.touch(memo.id);
        this.metrics.sample({
          stage: 'llm',
          ms: 0,
          ok: true,
          meta: {
            purpose: 'plan',
            model: this.d.model.id,
            firstTokenMs: -1,
            reused: true,
            memo: true,
            savedUsd:
              memo.costUsd.plan > 0 ? memo.costUsd.plan : freshEstimateUsd('plan', this.d.model.id),
            segmentsMemoised: memo.cuesBySegment.filter((c) => c.length > 0).length,
          },
        });
      }
      this.setPreparation({
        stage: 'ready',
        fraction: 1,
        status: 'Ready',
        sourcesFound: 0,
        sourcesFetched: 0,
      });
    } else {
      if (!this.d.acquirer) throw new Error('KNOWLEDGE_ACQUIRER_MISSING');
      // A topic miss means the learner waits while sources are gathered: on the free plan that wait
      // carries one ad card, and it is taken out of the session's ad budget (never an extra ad).
      if (this.d.ads && !hasEntitlement(this.d.host.plan, 'no_ads')) {
        this.adsShown += 1;
        this.broadcastAd(`ad-${this.sessionId}-prep`, -1, 'preparation');
      }
      const preparing = this.metrics.start('prepare', { match: resolution.match });
      let prepared: Awaited<ReturnType<KnowledgeAcquirer['prepare']>>;
      try {
        prepared = await this.d.acquirer.prepare({
          resolution,
          onProgress: (p) => this.setPreparation(p),
          signal: this.abort.signal,
          telemetry: this.metrics,
        });
      } catch (error) {
        preparing.end(false);
        throw error;
      }
      preparing.end(true, {
        provisional: prepared.provisional,
        sourcesFetched: this.state.preparation?.sourcesFetched ?? 0,
      });
      this.packId = prepared.packId;
      if (prepared.provisional)
        this.state = { ...this.state, evidenceTier: 'unverified_live_source' };
      void prepared.background.then(
        async () => {
          if (this.abort.signal.aborted) return;
          await this.d.runtime.refreshPacks();
          this.state = { ...this.state, evidenceTier: 'reviewed_pack_source' };
          this.setPreparation(null);
          this.broadcastState();
        },
        (error) => this.fail('room.background_compile', error, 'prepare'),
      );
    }
    if (!this.packId) throw new Error('PACK_MISSING');
    await this.d.runtime.configure({
      hostId: 'pen',
      policy: this.d.onten.policy,
      packIds: [this.packId],
    });
  }

  private planUsd = 0;

  private async makePlan(): Promise<void> {
    const pack = this.packId ? await this.d.onten.registry.getPack(this.packId) : null;
    this.packRevision = pack?.packRevision ?? null;
    this.packQualified = pack?.qualified ?? false;
    if (this.plan) {
      this.state = { ...this.state, plan: this.plan };
      return;
    }
    const unitTitles = pack ? [...new Set(pack.units.map((u) => u.title))] : [];
    this.setPreparation({
      stage: 'outlining',
      fraction: 0.9,
      status: `${this.d.expert.displayName} is planning the session…`,
      sourcesFound: pack?.sources.length ?? 0,
      sourcesFetched: pack?.sources.length ?? 0,
    });
    this.plan = await planLesson(
      this.model,
      {
        expert: this.d.expert,
        topic: this.resolution?.title ?? this.d.topic,
        band: this.d.band,
        unitTitles,
        targetMinutes: this.d.targetMinutes ?? 14,
        cacheKey: this.cacheKey(),
      },
      this.abort.signal,
    );
    this.planUsd = this.lastLessonUsd;
    this.state = { ...this.state, plan: this.plan };
  }

  // ── lesson generation loop ─────────────────────────────────────────────────

  private async generateLoop(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    for (let i = 0; i < plan.segments.length; i++) {
      if (this.abort.signal.aborted) return;
      // Segment lookahead: never run more than one segment ahead of what the host is hearing.
      if (i > 0) await this.waitForHostProgress(this.firstSeqOfSegment[i - 1] ?? 0);
      if (this.abort.signal.aborted) return;
      await this.generateSegment(i);
    }
    this.lessonComplete = true;
    await this.memoPending;
  }

  /**
   * Memoise a segment the moment it is generated (qualified packs only), so a
   * session that ends early still leaves its segments for the next learner of
   * this topic, band and persona. Writes are serialised; failures are reported,
   * never surfaced to the learner.
   */
  private memoise(index: number, events: LessonEvent[], usd: number): void {
    if (!this.packQualified || !this.packId || !this.plan || events.length === 0) return;
    const plan = this.plan;
    const packId = this.packId;
    const packRevision = this.packRevision ?? '';
    const ckid = this.resolution?.canonicalKnowledgeId ?? this.d.topic;
    this.memoPending = this.memoPending
      .then(async () => {
        if (this.memoHit) {
          await this.d.memo.extend(this.memoHit.id, [{ index, cues: events, usd }]);
          this.memoHit.cuesBySegment[index] = events;
          return;
        }
        const entry = await this.d.memo.put({
          canonicalKnowledgeId: ckid,
          band: this.d.band,
          packId,
          packRevision,
          expertId: this.d.expert.id,
          plan,
          cuesBySegment: plan.segments.map((s) => (s.index === index ? events : [])),
          costUsd: {
            plan: this.planUsd,
            segments: plan.segments.map((s) => (s.index === index ? usd : 0)),
          },
        });
        this.memoHit = {
          id: entry.id,
          cuesBySegment: entry.cuesBySegment as LessonEvent[][],
          segmentUsd: entry.costUsd.segments,
        };
        this.observer.event('room.memo_created', {
          segment: index,
          segments: plan.segments.length,
        });
      })
      .catch((error) => this.fail('room.memo', error, null, { segment: index }));
  }

  private async generateSegment(index: number): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const segment = plan.segments[index];
    if (!segment) return;
    this.firstSeqOfSegment[index] = this.seq;
    const events: LessonEvent[] = [];
    const emit = (event: LessonEvent) => {
      events.push(event);
      this.emitLessonEvent(event, index);
    };
    const memo = this.memoHit?.cuesBySegment[index];
    if (memo && memo.length > 0) {
      for (const ev of memo) emit(ev);
      const recorded = this.memoHit?.segmentUsd[index] ?? 0;
      this.metrics.sample({
        stage: 'llm',
        ms: 0,
        ok: true,
        meta: {
          purpose: 'lesson',
          model: this.d.model.id,
          firstTokenMs: -1,
          reused: true,
          memo: true,
          segment: index,
          events: memo.length,
          savedUsd: recorded > 0 ? recorded : freshEstimateUsd('lessonSegment', this.d.model.id),
        },
      });
    } else {
      const context = await this.contextFor(
        `${segment.title}. ${segment.goal}`,
        'lesson-segment:v1',
      );
      const messages = segmentMessages({
        system: this.system,
        plan,
        segment,
        previousTitles: plan.segments.slice(0, index).map((s) => s.title),
        modelContext: context.modelContext,
        evidenceTier: this.state.evidenceTier,
        language: this.language,
      });
      const stream = this.model.streamEvents({
        messages,
        cacheKey: this.cacheKey(),
        maxOutputTokens: 2200,
        purpose: 'lesson',
        signal: this.abort.signal,
      });
      let count = 0;
      try {
        for await (const event of stream) {
          if (event.type === 'done') continue;
          emit(event);
          count++;
        }
      } catch (error) {
        this.fail('room.generate', error, 'llm', { segment: index });
        if (count === 0) {
          this.failSession(
            'LLM_UNAVAILABLE',
            'I lost my train of thought for a second — give me a moment and ask me anything meanwhile.',
          );
          return;
        }
      }
      const usage = await stream.usage;
      this.observer.event('room.segment_generated', {
        segment: index,
        events: count,
        firstTokenMs: usage.firstTokenMs,
        usd: usage.usd,
      });
      if (count > 0) this.memoise(index, events, usage.usd);
    }
    this.segmentEvents.set(index, events);
    this.lastSeqOfSegment[index] = this.seq - 1;
    // Ad budget: one card every N segments. A card shown during preparation consumes the first slot.
    const every = this.d.ads?.everySegments ?? 0;
    const adSlot =
      every > 0 && index > 0 && index % every === 0 && index < plan.segments.length - 1;
    const slotIndex = every > 0 ? index / every : 0;
    if (
      this.d.ads &&
      !hasEntitlement(this.d.host.plan, 'no_ads') &&
      adSlot &&
      this.adsShown < slotIndex
    ) {
      this.adsShown += 1;
      this.broadcastAd(`ad-${this.sessionId}-${this.adsShown}`, this.seq - 1, 'boundary');
    }
  }

  /** Every ad is a video against the room's tag; the id is what the host reports outcomes against. */
  private broadcastAd(adId: string, afterSeq: number, slot: AdSlot): void {
    const ads = this.d.ads;
    if (!ads) return;
    this.adsSent.set(adId, { slot, seen: new Set() });
    this.d.transport.broadcast({
      kind: 'ad',
      adId,
      afterSeq,
      skippableAfterMs: ads.skippableAfterMs,
      durationMs: ads.durationMs,
      format: 'video',
      tagUrl: ads.tagUrl,
      slot,
    });
    this.observer.event('room.ad', { adId, slot, afterSeq });
  }

  /**
   * The host's player reports each lifecycle step once; anything else (a guest, an id the room
   * never sent, a repeat) is dropped so revenue estimates cannot be inflated from a client.
   */
  private adEvent(p: Participant, m: Extract<ClientMessage, { kind: 'ad_event' }>): void {
    if (p.role !== 'host') return;
    const sent = this.adsSent.get(m.adId);
    if (!sent || sent.seen.has(m.event)) return;
    sent.seen.add(m.event);
    const outcome: AdOutcome = {
      sessionId: this.sessionId,
      adId: m.adId,
      slot: sent.slot,
      event: m.event,
      atMs: m.atMs,
      code: m.code ?? null,
    };
    this.observer.event('room.ad_event', { ...outcome, code: outcome.code ?? undefined });
    // Validated, it is an interaction like any other (ADR-0011): ledger, Insights, PostHog.
    this.metrics.interaction(p.id, m.event, {
      adId: m.adId,
      slot: sent.slot,
      atMs: m.atMs,
      ...(m.code ? { code: m.code } : {}),
    });
    const revenue = this.d.ads?.revenuePerCompletionUsd ?? 0;
    if (m.event === 'ad_completed' && revenue > 0)
      this.metrics.cost({
        component: 'ads',
        unit: 'requests',
        units: 1,
        usd: revenue,
        meta: { purpose: 'ad_revenue', estimate: true, adId: m.adId, slot: sent.slot },
      });
    this.d.ads?.onEvent?.(outcome);
  }

  private emitLessonEvent(raw: LessonEvent, segment: number): void {
    const thread = 'lesson';
    const cue = this.pushCue(raw, segment, thread);
    const event = cue.event;
    if (event.type === 'say') {
      this.lessonSays.set(event.id, { say: event, seq: cue.seq, segment });
      this.lessonOrder.push(event.id);
      this.spoken.push(event.text);
      if (this.state.mode === 'teaching' || this.state.mode === 'complete')
        this.pipeline.enqueue(event, thread, 0, this.voiceForCurrentLanguage());
    } else if (event.type === 'check') {
      const asking = this.lessonSays.get(event.askedBy);
      this.checks.set(event.id, { check: event, question: asking?.say.text ?? '', seq: cue.seq });
    }
  }

  /** Assign a seq, qualify model ids with the thread (L2.s1 / t3.s1), broadcast and record. */
  private pushCue(raw: LessonEvent, segment: number, thread: string): Cue {
    const prefix = thread === 'lesson' ? `L${segment}` : thread;
    const cue: Cue = {
      seq: this.seq++,
      segment,
      thread,
      at: this.now(),
      event: qualifyIds(raw, prefix),
    };
    this.cues.push(cue);
    const ev = cue.event;
    if (ev.type === 'say') this.seqOfSay.set(ev.id, cue.seq);
    if (ev.type === 'check') this.checkAskers.add(ev.askedBy);
    if (ev.type === 'board' && ev.op === 'title' && ev.anchor !== 'now')
      this.titleSays.add(ev.anchor.startsWith('after:') ? ev.anchor.slice(6) : ev.anchor);
    this.d.transport.broadcast({ kind: 'cue', cue });
    this.ledger({ kind: 'cue', t: cue.at, cue });
    for (const wake of this.cueWaiters.splice(0)) wake();
    return cue;
  }

  /**
   * The beat after a sentence: longer when it asked a question or introduced a
   * title (ADR-0010). The check/title cue is emitted after the sentence it
   * belongs to, so when nothing has followed the sentence yet the decision
   * waits for the next cue (bounded); the speech is already streaming, only
   * the silence at the tail is held.
   */
  private async gapAfter(say: SayEvent): Promise<GapKind> {
    const seq = this.seqOfSay.get(say.id);
    if (seq !== undefined && seq >= this.seq - 1 && !this.abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, GAP_DECISION_WAIT_MS);
        this.cueWaiters.push(done);
      });
    }
    if (this.checkAskers.has(say.id)) return 'check';
    if (this.titleSays.has(say.id)) return 'title';
    return 'sentence';
  }

  /**
   * Host-only. The new pace reaches every participant through `state`, goes to
   * the ledger so replay knows it, and applies from the next sentence the
   * pipeline synthesises: the sentence in flight (and up to `lookahead`
   * sentences already banked on the clients) finish at their own speed.
   */
  private setPace(p: Participant, requested: number): void {
    if (p.role !== 'host') {
      this.d.transport.send(p.id, {
        kind: 'error',
        code: 'NOT_HOST',
        message: 'Only the host sets the pace.',
        spoken: false,
      });
      return;
    }
    const pace = clampPace(requested);
    if (Math.abs(pace - this.state.pace) < 1e-6) return;
    this.state = { ...this.state, pace };
    this.ledger({ kind: 'pace', t: this.now(), pace, participantId: p.id });
    this.observer.event('room.pace', { sessionId: this.sessionId, pace });
    this.broadcastState();
    // The state (and so the pipeline's `pace()`) is already the new one: everything
    // re-synthesised from here is at the speed the host just asked for.
    this.retakeForPace();
  }

  /**
   * A pace change is heard now, not in two sentences' time (tasks/todo.md).
   *
   * The sentence the learner is hearing keeps its own speed — re-cutting it
   * would restart it mid-word, which is the "pause that restarts the sentence"
   * the launch review flags. Everything behind it, whether still queued here or
   * already banked on the clients, is re-synthesised at the new pace under a
   * fresh take. Clients learn the new take before its audio arrives, so the
   * conductor knows the audio it is holding is stale and swaps it at the next
   * sentence boundary (`ServerSayTake`).
   */
  private retakeForPace(): void {
    if (this.state.phase !== 'live') return;
    if (this.state.mode !== 'teaching' && this.state.mode !== 'complete') return;
    const unheard: Array<{ id: string; say: SayEvent }> = [];
    for (const id of this.lessonOrder) {
      const entry = this.lessonSays.get(id);
      if (entry && entry.seq > this.hostProgressSeq) unheard.push({ id, say: entry.say });
    }
    // unheard[0] is the sentence at the speaker (or the very next one to start).
    const retake = unheard.slice(1);
    if (retake.length === 0) return;
    const ids = new Set(retake.map((r) => r.id));
    this.pipeline.retake((sayId) => ids.has(sayId));
    for (const { id, say } of retake) {
      const take = (this.takes.get(id) ?? 0) + 1;
      this.takes.set(id, take);
      this.d.transport.broadcast({ kind: 'say_take', sayId: id, take, reason: 'pace' });
      this.pipeline.enqueue(say, 'lesson', take, this.voiceForCurrentLanguage());
    }
    this.observer.event('room.pace_retake', {
      sessionId: this.sessionId,
      sentences: retake.length,
      pace: this.state.pace,
    });
  }

  private async contextFor(
    text: string,
    contentInstructions: string,
  ): Promise<{ modelContext: string; status: string }> {
    const input: QueryInput = {
      text,
      revision: `final-${this.seq}`,
      topic: this.resolution?.canonicalKnowledgeId ?? this.d.topic,
      principal: {
        principalId: this.d.host.id,
        revision: '1',
        validUntil: this.now() + 3_600_000,
        groups: [this.d.band],
        assurance: 'session',
      },
      facts: [],
      at: this.now(),
      requiresComplete: false,
      consequential: false,
      tokenBudget: null,
      contentInstructions,
    };
    const timer = this.metrics.start('context', { purpose: contentInstructions });
    let result: Awaited<ReturnType<MockContextRuntime['query']>>;
    try {
      result = await this.d.runtime.query(input);
    } catch (error) {
      timer.end(false);
      throw error;
    }
    const assemblyMs = result.metrics.assemblyNs / 1e6;
    timer.end(true, {
      status: result.context.status,
      spans: result.context.evidenceSpans.length,
      assemblyMs,
      speculationHit: result.metrics.speculationHit,
      reused: result.metrics.speculationHit,
      savedUsd: 0,
    });
    // Onten is amortised across learners (mock today): the request is counted, the price is nil.
    this.metrics.cost({ component: 'onten', unit: 'requests', units: 1, usd: 0, meta: {} });
    this.observer.event('onten.query', {
      status: result.context.status,
      spans: result.context.evidenceSpans.length,
      assemblyMs,
      speculationHit: result.metrics.speculationHit,
    });
    return { modelContext: result.context.modelContext, status: result.context.status };
  }

  private waitForHostProgress(seq: number): Promise<void> {
    if (this.hostProgressSeq >= seq || this.participants.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.abort.signal.aborted || this.hostProgressSeq >= seq) {
          clearInterval(timer);
          resolve();
        }
      };
      const timer = setInterval(check, 100);
      // Safety: never stall generation forever if progress reports stop (e.g. host tab in background).
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 120_000);
    });
  }

  // ── progress, pause, resume ────────────────────────────────────────────────

  private progress(p: Participant, seq: number, clockMs: number): void {
    if (p.role !== 'host') return;
    if (seq > this.hostProgressSeq) {
      const previous = this.hostProgressSeq;
      this.hostProgressSeq = seq;
      this.clockMs = clockMs;
      const cue = this.cues[seq];
      // Every lesson sentence up to this cue has been heard, even when a report was skipped
      // (progress is monotonic on the client); the lookahead must never lag behind the room.
      for (let s = previous + 1; s <= seq; s += 1) {
        const heard = this.cues[s];
        if (heard?.thread === 'lesson' && heard.event.type === 'say') this.pipeline.markHeard();
      }
      const segment = this.lastSeqOfSegment.findIndex((last) => last >= seq);
      const seg = segment === -1 ? this.state.segment : segment;
      if (seg !== this.state.segment) {
        this.state = { ...this.state, segment: seg, clockMs };
        this.broadcastState();
      } else {
        this.state = { ...this.state, clockMs };
      }
      if (cue?.event.type === 'check' && this.state.mode === 'teaching') {
        const c = this.checks.get(cue.event.id);
        if (c) {
          this.pendingCheck = { check: c.check, question: c.question };
          this.setMode('checking');
        }
      }
      if (this.lessonComplete && seq >= this.seq - 1 && this.state.mode === 'teaching')
        this.setMode('complete');
    }
  }

  private control(p: Participant, action: 'pause' | 'resume' | 'end' | 'next_segment'): void {
    if (p.role !== 'host') {
      this.d.transport.send(p.id, {
        kind: 'error',
        code: 'NOT_HOST',
        message: 'Only the host can do that.',
        spoken: false,
      });
      return;
    }
    switch (action) {
      case 'pause':
        if (this.state.mode === 'teaching' || this.state.mode === 'complete') {
          this.pipeline.cancel();
          this.setMode('paused');
        }
        return;
      case 'resume':
        if (this.state.mode === 'paused') this.resumeLesson();
        return;
      case 'end':
        void this.end();
        return;
      case 'next_segment':
        return;
    }
  }

  private resumed(p: Participant): void {
    if (p.role !== 'host') return;
    if (this.state.mode === 'answering' && this.turn?.done) this.finishTurn();
  }

  /** Re-arm TTS for the lesson from the resume point (the interrupted sentence is spoken again from its start). */
  private resumeLesson(): void {
    const from = this.state.resume;
    this.setMode('teaching');
    const startIndex = from?.sayId
      ? Math.max(0, this.lessonOrder.indexOf(from.sayId))
      : this.lessonOrder.findIndex(
          (id) => (this.lessonSays.get(id)?.seq ?? 0) > this.hostProgressSeq,
        );
    const ids = startIndex < 0 ? [] : this.lessonOrder.slice(startIndex);
    for (const id of ids) {
      const entry = this.lessonSays.get(id);
      if (!entry) continue;
      const take = (this.takes.get(id) ?? 0) + 1;
      this.takes.set(id, take);
      this.d.transport.broadcast({ kind: 'say_take', sayId: id, take, reason: 'resume' });
      this.pipeline.enqueue(entry.say, 'lesson', take, this.voiceForCurrentLanguage());
    }
    this.state = { ...this.state, resume: null };
    this.broadcastState();
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  private interrupt(
    p: Participant,
    at: { atSeq: number; sayId: string | null; offsetMs: number },
  ): void {
    if (this.state.phase !== 'live') return;
    if (
      this.state.mode === 'listening' ||
      this.state.mode === 'thinking' ||
      this.state.mode === 'answering'
    ) {
      // Someone else has the floor; a second voice is queued by the client UI, not the room.
      if (this.state.floor !== p.id)
        this.d.transport.send(p.id, {
          kind: 'error',
          code: 'RATE_LIMITED',
          message: `${this.participants.get(this.state.floor ?? '')?.name ?? 'Someone'} has the floor.`,
          spoken: false,
        });
      return;
    }
    this.pausedBeforeTurn =
      this.state.mode === 'checking'
        ? 'checking'
        : this.state.mode === 'paused'
          ? 'paused'
          : 'teaching';
    this.pipeline.cancel();
    this.ledger({
      kind: 'interrupt',
      t: this.now(),
      participantId: p.id,
      atSeq: at.atSeq,
      offsetMs: at.offsetMs,
    });
    const take = at.sayId ? (this.takes.get(at.sayId) ?? 0) : 0;
    this.state = {
      ...this.state,
      resume:
        this.pausedBeforeTurn === 'paused'
          ? this.state.resume
          : { seq: at.atSeq, sayId: at.sayId, offsetMs: at.offsetMs, take },
    };
    this.setMode('listening', p.id);
  }

  private transcript(p: Participant, utteranceId: string, text: string, final: boolean): void {
    if (this.state.floor !== p.id) {
      const openFloor =
        this.state.mode === 'teaching' ||
        this.state.mode === 'checking' ||
        this.state.mode === 'complete';
      if (final && openFloor) {
        // Speech arrived without a prior interrupt (e.g. browser STT with no local VAD). Treat it as one now.
        this.interrupt(p, { atSeq: Math.max(0, this.hostProgressSeq), sayId: null, offsetMs: 0 });
      } else return;
    }
    this.d.transport.broadcast({ kind: 'caption', participantId: p.id, text, final });
    if (!final) {
      // Speculative assembly on the partial revision (CTX-ASSEMBLY-SPEC-01).
      if (text.length > 12 && this.lastFloorUtterance.get(utteranceId) !== text) {
        this.lastFloorUtterance.set(utteranceId, text);
        void this.d.runtime
          .speculate(this.queryInputFor(text, `partial-${utteranceId}`))
          .catch(() => undefined);
      }
      return;
    }
    this.lastFloorUtterance.delete(utteranceId);
    this.ledger({ kind: 'caption', t: this.now(), participantId: p.id, text });
    this.turnStartedAt = this.now();
    // Detection is ~0.05 ms; awaiting it keeps the acknowledgement in the right language.
    void this.followLanguage(text).then(() => this.decide(p, text));
  }

  /** perceive → decide → act. */
  private async decide(p: Participant, text: string): Promise<void> {
    const pendingCheck =
      this.pendingCheck !== null &&
      (this.pausedBeforeTurn === 'checking' || this.state.mode === 'checking');
    let intent = classifyLocally(text, { pendingCheck });
    if (!intent) {
      try {
        const { value } = await this.model.complete({
          messages: intentMessages({ text, mode: this.state.mode, pendingCheck }),
          schema: IntentOutput,
          schemaName: 'intent',
          cacheKey: `${this.cacheKey()}:intent`,
          maxOutputTokens: 40,
          purpose: 'intent',
        });
        intent = value;
      } catch (error) {
        this.fail('room.intent', error, 'llm');
        intent = { intent: 'question', command: 'none' };
      }
    }
    this.observer.event('room.intent', {
      intent: intent.intent,
      command: intent.command,
      chars: text.length,
    });
    switch (intent.intent) {
      case 'backchannel':
        return this.releaseFloor();
      case 'command':
        return this.command(p, intent.command);
      case 'answer':
        if (this.pendingCheck) return this.gradeCheck(p, this.pendingCheck.check.id, text);
        return this.answer(p, text, 'question');
      case 'clarify':
        return this.answer(p, text, 'clarify');
      case 'off_topic':
      case 'question':
        return this.answer(p, text, 'question');
    }
  }

  private command(p: Participant, command: IntentOutput['command']): void {
    const isHost = p.role === 'host';
    switch (command) {
      case 'pause':
        if (isHost) {
          this.state = { ...this.state, floor: null };
          this.setMode('paused');
          return;
        }
        break;
      case 'resume':
        if (isHost) {
          this.releaseFloor();
          return;
        }
        break;
      case 'end':
        if (isHost) {
          void this.end();
          return;
        }
        break;
      case 'repeat': {
        const from = this.state.resume;
        const idx = from?.sayId ? this.lessonOrder.indexOf(from.sayId) : -1;
        const prev = idx > 0 ? this.lessonSays.get(this.lessonOrder[idx - 1] ?? '') : null;
        if (prev)
          this.state = {
            ...this.state,
            resume: {
              seq: prev.seq,
              sayId: prev.say.id,
              offsetMs: 0,
              take: this.takes.get(prev.say.id) ?? 0,
            },
          };
        this.releaseFloor();
        return;
      }
      case 'slower':
        // "Slow down" is a pace request: one preset down, host only (guests hear the host's pace).
        if (isHost) this.setPace(p, slowerPreset(this.state.pace));
        break;
      case 'next':
      case 'none':
        break;
    }
    this.releaseFloor();
  }

  /** Nothing to answer: give the floor back and continue. */
  private releaseFloor(): void {
    this.state = { ...this.state, floor: null };
    if (this.pausedBeforeTurn === 'checking') this.setMode('checking');
    else if (this.pausedBeforeTurn === 'paused') this.setMode('paused');
    else this.resumeLesson();
  }

  private async answer(
    p: Participant,
    question: string,
    kind: 'question' | 'clarify',
  ): Promise<void> {
    if (!this.plan) return;
    const turnId = `t${++this.turnCounter}`;
    const turn: Turn = {
      id: turnId,
      participantId: p.id,
      question,
      sayIds: new Set(),
      completed: new Set(),
      done: false,
      startedAt: this.takeTurnStart(),
      firstAudioAt: null,
      kind,
    };
    this.turn = turn;
    this.questions.push(question);
    this.setMode('thinking', p.id);
    // Instant acknowledgement in the learner's language: audible within the TTS first-chunk
    // time, while the answer is composed. Languages without a table stay silent instead.
    const ackText = acknowledgement(kind, this.turnCounter, this.language);
    if (ackText) {
      const ack: SayEvent = { type: 'say', id: 's0', text: ackText, tone: 'warm' };
      this.emitTurnEvent(turn, ack);
    }
    const segment = this.plan.segments[this.state.segment] ?? this.plan.segments[0];
    if (!segment) return;
    try {
      const context = await this.contextFor(
        question,
        kind === 'clarify' ? 'clarify:v1' : 'answer:v1',
      );
      const recent = this.spoken.slice(-4);
      const stream = this.model.streamEvents({
        messages: answerMessages({
          system: this.system,
          plan: this.plan,
          segment,
          question,
          askedBy: p.name,
          recentSpeech: recent,
          modelContext: context.modelContext,
          status: context.status,
          language: this.language,
        }),
        cacheKey: this.cacheKey(),
        maxOutputTokens: 700,
        purpose: 'turn',
        signal: this.abort.signal,
      });
      this.setMode('answering', p.id);
      let sayCount = 0;
      for await (const event of stream) {
        if (this.turn !== turn) break;
        if (event.type === 'done' || event.type === 'check') continue;
        if (event.type === 'say') sayCount++;
        // The model read the question: its declared language is authoritative for the switch.
        if (event.type === 'note') this.setLanguage(event.language);
        this.emitTurnEvent(turn, event);
      }
      const usage = await stream.usage;
      this.observer.event('room.turn', {
        turn: turnId,
        firstTokenMs: usage.firstTokenMs,
        usd: usage.usd,
        says: sayCount,
        status: context.status,
      });
      if (sayCount === 0)
        this.emitTurnEvent(turn, {
          type: 'say',
          id: 's99',
          text: "I don't have good material for that one here — let's keep going and I'll flag it at the end.",
          tone: 'neutral',
        });
    } catch (error) {
      this.fail('room.answer', error, 'llm', { turn: turnId });
      if (this.turn === turn)
        this.emitTurnEvent(turn, {
          type: 'say',
          id: 's98',
          text: `I lost my connection for a second — ${bridgeBack(this.turnCounter, this.language)}`,
          tone: 'neutral',
        });
    }
    turn.done = true;
    this.d.transport.broadcast({ kind: 'turn_done', thread: turn.id });
    this.maybeFinishTurn(turn);
  }

  private emitTurnEvent(turn: Turn, raw: LessonEvent): void {
    const cue = this.pushCue(raw, this.state.segment, turn.id);
    const event = cue.event;
    if (event.type === 'say') {
      turn.sayIds.add(event.id);
      this.pipeline.enqueue(event, turn.id, 0, this.voiceForCurrentLanguage());
      this.spoken.push(event.text);
    }
  }

  private onSayComplete(sayId: string): void {
    const turn = this.turn;
    if (turn?.sayIds.has(sayId)) {
      turn.completed.add(sayId);
      this.maybeFinishTurn(turn);
    }
  }

  private onSayFailure(sayId: string, error: unknown): void {
    // The pipeline already captured the failure (with its Sentry ref); this is the room's reaction.
    this.observer.event('room.say_failed', {
      sayId,
      code: error instanceof Error ? error.message.split(':')[0] : 'TTS_ERROR',
    });
    this.d.transport.broadcast({
      kind: 'error',
      code: 'TTS_UNAVAILABLE',
      message: 'Voice hiccup — captions continue.',
      spoken: false,
    });
    this.onSayComplete(sayId);
  }

  private maybeFinishTurn(turn: Turn): void {
    if (!turn.done || this.turn !== turn) return;
    if (turn.completed.size < turn.sayIds.size) return;
    // Audio for the answer has fully streamed; the host's conductor tells us when it has finished playing it.
    // If no client reports (e.g. all guests), fall back after a bounded wait.
    const waitMs = 30_000;
    setTimeout(() => {
      if (this.turn === turn) this.finishTurn();
    }, waitMs);
  }

  private finishTurn(): void {
    this.turn = null;
    this.pipeline.resetLookahead();
    this.releaseFloor();
  }

  private endTurnEarly(): void {
    if (this.turn) this.turn.done = true;
    this.finishTurn();
  }

  private async gradeCheck(p: Participant, checkId: string, answerText: string): Promise<void> {
    const entry = this.checks.get(checkId);
    if (!entry) return this.releaseFloor();
    const turnId = `t${++this.turnCounter}`;
    const turn: Turn = {
      id: turnId,
      participantId: p.id,
      question: entry.question,
      sayIds: new Set(),
      completed: new Set(),
      done: false,
      startedAt: this.takeTurnStart(),
      firstAudioAt: null,
      kind: 'check',
    };
    this.turn = turn;
    this.pendingCheck = null;
    this.pausedBeforeTurn = 'teaching';
    this.setMode('thinking', p.id);
    let verdict: 'correct' | 'partial' | 'incorrect' | 'ungraded' = 'ungraded';
    let feedback = entry.check.explain;
    try {
      const { value } = await this.model.complete({
        messages: gradeMessages({
          system: this.system,
          question: entry.question,
          expected: entry.check.expected,
          options: entry.check.options,
          answer: answerText,
          explain: entry.check.explain,
          language: this.language,
        }),
        schema: GradeOutput,
        schemaName: 'grade',
        cacheKey: this.cacheKey(),
        maxOutputTokens: 120,
        purpose: 'grade',
      });
      // Provisional evidence never grades (mayAuthorizeConsequentialDecision=false): feedback is spoken, the verdict is withheld.
      verdict = this.state.evidenceTier === 'unverified_live_source' ? 'ungraded' : value.verdict;
      feedback = value.feedback;
    } catch (error) {
      this.fail('room.grade', error, 'llm');
    }
    this.d.transport.broadcast({ kind: 'check_result', checkId, participantId: p.id, verdict });
    this.setMode('answering', p.id);
    this.emitTurnEvent(turn, {
      type: 'say',
      id: 's1',
      text: feedback,
      tone: verdict === 'correct' ? 'encouraging' : 'warm',
    });
    turn.done = true;
    this.d.transport.broadcast({ kind: 'turn_done', thread: turn.id });
    this.maybeFinishTurn(turn);
  }

  // ── state helpers ──────────────────────────────────────────────────────────

  private setMode(mode: LiveMode, floor: ParticipantId | null = null): void {
    this.state = { ...this.state, mode, floor };
    this.ledger({ kind: 'mode', t: this.now(), mode, floor });
    this.broadcastState();
  }

  private setPreparation(preparation: PreparationProgress | null): void {
    this.state = { ...this.state, preparation };
    if (preparation) this.d.transport.broadcast({ kind: 'prep', progress: preparation });
  }

  private syncParticipants(): void {
    this.state = { ...this.state, participants: [...this.participants.values()] };
    this.broadcastState();
  }

  private broadcastState(): void {
    this.state = { ...this.state, participants: [...this.participants.values()] };
    this.d.transport.broadcast({ kind: 'state', state: this.state });
  }

  private failSession(code: ServerErrorCode, spokenLine: string): void {
    const cue = this.pushCue(
      { type: 'say', id: 's0', text: spokenLine, tone: 'neutral' },
      this.state.segment,
      'system',
    );
    if (cue.event.type === 'say') this.pipeline.enqueue(cue.event, 'system', 0);
    this.d.transport.broadcast({ kind: 'error', code, message: spokenLine, spoken: true });
    if (this.state.phase === 'preparing') {
      this.setPreparation({
        stage: 'failed',
        fraction: 1,
        status: spokenLine,
        sourcesFound: 0,
        sourcesFetched: 0,
      });
    }
  }

  private ledger(entry: LedgerEntry): void {
    this.d.ledger?.append(this.sessionId, entry);
  }

  /** Log + Sentry (content-free) and the ledger `error` entry carrying the Sentry ref. */
  private fail(
    area: string,
    error: unknown,
    stage: StageName | null,
    data: Record<string, unknown> = {},
  ): void {
    const ref = this.observer.error(area, error, { ...data, sessionId: this.sessionId, stage });
    this.metrics.error({ code: area, stage, ref: ref ?? null });
  }

  /** The turn's start: the learner's last final words, or now when the turn began another way. */
  private takeTurnStart(): number {
    const at = this.turnStartedAt ?? this.now();
    this.turnStartedAt = null;
    return at;
  }

  /** First audio of a turn thread: the `turn` stage (learner's last word → first audible chunk). */
  private onFirstChunk(sayId: string, thread: string): void {
    const turn = this.turn;
    if (!turn || thread !== turn.id || turn.firstAudioAt !== null) return;
    turn.firstAudioAt = this.now();
    this.metrics.sample({
      stage: 'turn',
      ms: turn.firstAudioAt - turn.startedAt,
      ok: true,
      startedAt: turn.startedAt,
      meta: {
        thread,
        sayId,
        kind: turn.kind,
        // The acknowledgement (s0) is the first thing heard; the composed answer follows.
        ack: sayId.endsWith('.s0'),
      },
    });
  }

  /**
   * A client interaction or something it showed. Recorded for every
   * participant; the host's board and ad timings become stage samples so the
   * timeline shows what the room actually rendered.
   */
  private report(p: Participant, event: ClientReport['event'], props: ClientReport['props']): void {
    const count = (this.reportCounts.get(p.id) ?? 0) + 1;
    this.reportCounts.set(p.id, count);
    if (count > MAX_REPORTS_PER_PARTICIPANT) return;
    this.metrics.interaction(p.id, event, props);
    const ms = typeof props.ms === 'number' && Number.isFinite(props.ms) ? props.ms : null;
    switch (event) {
      case 'board_done':
        if (p.role === 'host' && ms !== null)
          this.metrics.sample({
            stage: 'board',
            ms,
            ok: props.ok !== false,
            meta: pickMeta(props, ['op', 'chars', 'seq', 'anchored']),
          });
        return;
      case 'ad_skipped':
      case 'ad_ended':
        if (p.role === 'host' && ms !== null)
          this.metrics.sample({
            stage: 'ad',
            ms,
            ok: true,
            meta: { ...pickMeta(props, ['adId']), skipped: event === 'ad_skipped' },
          });
        return;
      case 'error_shown':
        this.metrics.error({
          code: typeof props.code === 'string' && props.code ? props.code : 'CLIENT_ERROR',
          stage: null,
          ref: typeof props.ref === 'string' && props.ref ? props.ref : null,
        });
        return;
      default:
        return;
    }
  }

  /** Switch the communication language when the learner clearly wrote in another one (script change). */
  private async followLanguage(text: string): Promise<void> {
    try {
      const detected = await this.d.languageOf?.(text);
      if (detected) this.setLanguage(detected);
    } catch (error) {
      this.fail('room.language_detect', error, null);
    }
  }

  private setLanguage(tag: string): void {
    const clean = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(tag.trim()) ? tag.trim() : null;
    if (!clean) return;
    const next = clean.split('-')[0]?.toLowerCase() ?? clean;
    const current = this.language.split('-')[0]?.toLowerCase() ?? this.language;
    if (next === current) return;
    this.language = clean;
    this.observer.event('room.language', { language: next });
    this.state = { ...this.state, language: clean };
    this.broadcastState();
  }

  private voiceForCurrentLanguage(): string {
    return this.d.voiceFor?.(this.language) ?? this.d.voice;
  }

  private cacheKey(): string {
    return roomCacheKey(this.d.expert.id, this.d.band);
  }

  private queryInputFor(text: string, revision: string): QueryInput {
    return {
      text,
      revision,
      topic: this.resolution?.canonicalKnowledgeId ?? this.d.topic,
      principal: {
        principalId: this.d.host.id,
        revision: '1',
        validUntil: this.now() + 3_600_000,
        groups: [this.d.band],
        assurance: 'session',
      },
      facts: [],
      at: this.now(),
      requiresComplete: false,
      consequential: false,
      tokenBudget: null,
      contentInstructions: 'answer:v1',
    };
  }
}

function pickMeta(
  props: Record<string, string | number | boolean>,
  keys: string[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    const v = props[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Prefix model-minted ids (s1, b1, c1 and their references) with the thread prefix. */
export function qualifyIds(event: LessonEvent, prefix: string): LessonEvent {
  const q = (id: string) => (id && !id.includes('.') ? `${prefix}.${id}` : id);
  switch (event.type) {
    case 'say':
      return { ...event, id: q(event.id) };
    case 'board':
      return {
        ...event,
        id: q(event.id),
        anchor:
          event.anchor === 'now'
            ? 'now'
            : event.anchor.startsWith('after:')
              ? `after:${q(event.anchor.slice(6))}`
              : q(event.anchor),
        ref: event.ref === 'all' ? 'all' : q(event.ref),
        ref2: q(event.ref2),
      };
    case 'check':
      return { ...event, id: q(event.id), askedBy: q(event.askedBy) };
    default:
      return event;
  }
}

export function hueFor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function newSessionId(): string {
  return nanoid(12);
}

export type { NoteEvent };
