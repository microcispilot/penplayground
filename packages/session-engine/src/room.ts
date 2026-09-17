import type {
  CheckEvent,
  ClientMessage,
  Cue,
  Expert,
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
} from '@pen/contracts';
import { hasEntitlement, MAX_PARTICIPANTS } from '@pen/contracts';
import type { LanguageModel } from '@pen/llm';
import type { LessonMemo, MockContextRuntime, Onten, TopicResolution } from '@pen/onten';
import type { SpeechSynthesizer } from '@pen/voice';
import { nanoid } from 'nanoid';
import { acknowledgement, bridgeBack, classifyLocally } from './brain.js';
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
  }): Promise<{ packId: string; provisional: boolean; background: Promise<unknown> }>;
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
  onten: Onten;
  runtime: MockContextRuntime;
  memo: LessonMemo;
  model: LanguageModel;
  synthesizer: SpeechSynthesizer;
  /** Engine voice for this expert (resolved from the catalog voice id). */
  voice: string;
  sampleRate: 24000 | 44100 | 48000;
  transport: RoomTransport;
  observer?: RoomObserver;
  acquirer: KnowledgeAcquirer | null;
  ledger?: LedgerSink;
  targetMinutes?: number;
  ads?: { everySegments: number; durationMs: number; skippableAfterMs: number } | null;
  now?: () => number;
}

interface Turn {
  id: string;
  participantId: ParticipantId;
  question: string;
  sayIds: Set<string>;
  completed: Set<string>;
  done: boolean;
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
  private pendingCheck: { check: CheckEvent; question: string } | null = null;
  private hostProgressSeq = -1;
  private firstSeqOfSegment: number[] = [];
  private lastSeqOfSegment: number[] = [];
  private turn: Turn | null = null;
  private turnCounter = 0;
  private readonly abort = new AbortController();
  private lessonComplete = false;
  private resolution: TopicResolution | null = null;
  private memoHit: { id: string; cuesBySegment: LessonEvent[][] } | null = null;
  private packId: string | null = null;
  private pausedBeforeTurn: LiveMode = 'teaching';
  private adsShown = 0;
  private clockMs = 0;
  private lastFloorUtterance = new Map<string, string>();

  constructor(deps: SessionRoomDeps) {
    this.d = deps;
    this.sessionId = deps.sessionId;
    this.observer = deps.observer ?? SILENT_OBSERVER;
    this.now = deps.now ?? (() => Date.now());
    this.system = lessonSystemPrompt(deps.expert, deps.band, deps.language);
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
      plan: null,
      segment: 0,
      clockMs: 0,
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
      onComplete: (sayId) => this.onSayComplete(sayId),
      onFailure: (sayId, error) => this.onSayFailure(sayId, error),
    });
    this.ledger({ kind: 'join', t: this.now(), participantId: host.id, name: host.name });
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
      void this.generateLoop().catch((error) => this.observer.error('room.generate_loop', error));
    } catch (error) {
      this.observer.error('room.start', error, { sessionId: this.sessionId });
      this.failSession(
        'KNOWLEDGE_UNAVAILABLE',
        "I couldn't get this session ready. Let's try again in a moment.",
      );
    }
  }

  join(participant: {
    id: ParticipantId;
    name: string;
  }): { ok: true; participant: Participant } | { ok: false; code: ServerErrorCode } {
    const existing = this.participants.get(participant.id);
    if (existing) return { ok: true, participant: existing };
    if (this.participants.size >= MAX_PARTICIPANTS) return { ok: false, code: 'ROOM_FULL' };
    if (!hasEntitlement(this.d.host.plan, 'rooms'))
      return { ok: false, code: 'ENTITLEMENT_REQUIRED' };
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
        void this.gradeCheck(p, message.checkId, message.text);
        break;
      case 'progress':
        this.progress(p, message.seq, message.clockMs);
        break;
      case 'resumed':
        this.resumed(p);
        break;
      case 'utterance_start':
        p.micOn = true;
        break;
      case 'utterance_end':
        p.micOn = false;
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
        const { value } = await this.d.model.complete({
          messages: recapMessages({
            system: this.system,
            plan: this.plan,
            spoken: this.spoken,
            questions: this.questions,
          }),
          schema: RecapOutput,
          schemaName: 'recap',
          cacheKey: this.cacheKey(),
          maxOutputTokens: 400,
          purpose: 'recap',
        });
        recap = value.points.slice(0, 6).map((s) => s.slice(0, 120));
      } catch (error) {
        this.observer.error('room.recap', error);
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
    const resolution = await this.d.onten.registry.resolveTopic({
      text: this.d.topic,
      language: this.d.language,
      locale: this.d.locale,
      band: this.d.band,
    });
    this.resolution = resolution;
    this.observer.event('room.resolve', {
      match: resolution.match,
      score: resolution.score,
      ckid: resolution.canonicalKnowledgeId,
    });
    if (resolution.match === 'hit' || (resolution.match === 'partial' && resolution.packId)) {
      this.packId = resolution.packId;
      if (resolution.lessonMemoId) {
        const memo = await this.d.memo.find(resolution.canonicalKnowledgeId, this.d.band);
        if (memo && memo.expertId === this.d.expert.id) {
          this.memoHit = { id: memo.id, cuesBySegment: memo.cuesBySegment as LessonEvent[][] };
          this.plan = memo.plan as LessonPlan;
          await this.d.memo.touch(memo.id);
        }
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
      const prepared = await this.d.acquirer.prepare({
        resolution,
        onProgress: (p) => this.setPreparation(p),
        signal: this.abort.signal,
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
        (error) => this.observer.error('room.background_compile', error),
      );
    }
    if (!this.packId) throw new Error('PACK_MISSING');
    await this.d.runtime.configure({
      hostId: 'pen',
      policy: this.d.onten.policy,
      packIds: [this.packId],
    });
  }

  private async makePlan(): Promise<void> {
    if (this.plan) {
      this.state = { ...this.state, plan: this.plan };
      return;
    }
    const pack = this.packId ? await this.d.onten.registry.getPack(this.packId) : null;
    const unitTitles = pack ? [...new Set(pack.units.map((u) => u.title))] : [];
    this.setPreparation({
      stage: 'outlining',
      fraction: 0.9,
      status: `${this.d.expert.displayName} is planning the session…`,
      sourcesFound: pack?.sources.length ?? 0,
      sourcesFetched: pack?.sources.length ?? 0,
    });
    this.plan = await planLesson(
      this.d.model,
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
    if (this.memoHit === null && this.plan && this.packId) {
      const pack = await this.d.onten.registry.getPack(this.packId);
      if (pack?.qualified) {
        const cuesBySegment = plan.segments.map((s) => this.segmentEvents.get(s.index) ?? []);
        await this.d.memo.put({
          canonicalKnowledgeId: pack.canonicalKnowledgeId,
          band: this.d.band,
          packId: pack.packId,
          packRevision: pack.packRevision,
          expertId: this.d.expert.id,
          plan: this.plan,
          cuesBySegment,
        });
      }
    }
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
      });
      const stream = this.d.model.streamEvents({
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
        this.observer.error('room.generate', error, { segment: index });
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
    }
    this.segmentEvents.set(index, events);
    this.lastSeqOfSegment[index] = this.seq - 1;
    if (
      this.d.ads &&
      !hasEntitlement(this.d.host.plan, 'no_ads') &&
      index > 0 &&
      index % this.d.ads.everySegments === 0 &&
      index < plan.segments.length - 1
    ) {
      this.adsShown += 1;
      this.d.transport.broadcast({
        kind: 'ad',
        adId: `ad-${this.sessionId}-${this.adsShown}`,
        afterSeq: this.seq - 1,
        skippableAfterMs: this.d.ads.skippableAfterMs,
        durationMs: this.d.ads.durationMs,
      });
    }
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
        this.pipeline.enqueue(event, thread, 0);
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
    this.d.transport.broadcast({ kind: 'cue', cue });
    this.ledger({ kind: 'cue', t: cue.at, cue });
    return cue;
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
    const result = await this.d.runtime.query(input);
    this.observer.event('onten.query', {
      status: result.context.status,
      spans: result.context.evidenceSpans.length,
      assemblyMs: result.metrics.assemblyNs / 1e6,
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
      this.hostProgressSeq = seq;
      this.clockMs = clockMs;
      const cue = this.cues[seq];
      if (cue?.thread === 'lesson' && cue.event.type === 'say') this.pipeline.markHeard();
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
      this.d.transport.broadcast({ kind: 'say_take', sayId: id, take });
      this.pipeline.enqueue(entry.say, 'lesson', take);
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
    void this.decide(p, text);
  }

  /** perceive → decide → act. */
  private async decide(p: Participant, text: string): Promise<void> {
    const pendingCheck =
      this.pendingCheck !== null &&
      (this.pausedBeforeTurn === 'checking' || this.state.mode === 'checking');
    let intent = classifyLocally(text, { pendingCheck });
    if (!intent) {
      try {
        const { value } = await this.d.model.complete({
          messages: intentMessages({ text, mode: this.state.mode, pendingCheck }),
          schema: IntentOutput,
          schemaName: 'intent',
          cacheKey: `${this.cacheKey()}:intent`,
          maxOutputTokens: 40,
          purpose: 'intent',
        });
        intent = value;
      } catch (error) {
        this.observer.error('room.intent', error);
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
      case 'next':
      case 'slower':
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
    };
    this.turn = turn;
    this.questions.push(question);
    this.setMode('thinking', p.id);
    // Instant acknowledgement: audible within the TTS first-chunk time, while the answer is composed.
    const ack: SayEvent = {
      type: 'say',
      id: 's0',
      text: acknowledgement(kind, this.turnCounter),
      tone: 'warm',
    };
    this.emitTurnEvent(turn, ack);
    const segment = this.plan.segments[this.state.segment] ?? this.plan.segments[0];
    if (!segment) return;
    try {
      const context = await this.contextFor(
        question,
        kind === 'clarify' ? 'clarify:v1' : 'answer:v1',
      );
      const recent = this.spoken.slice(-4);
      const stream = this.d.model.streamEvents({
        messages: answerMessages({
          system: this.system,
          plan: this.plan,
          segment,
          question,
          askedBy: p.name,
          recentSpeech: recent,
          modelContext: context.modelContext,
          status: context.status,
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
      this.observer.error('room.answer', error, { turn: turnId });
      if (this.turn === turn)
        this.emitTurnEvent(turn, {
          type: 'say',
          id: 's98',
          text: `I lost my connection for a second — ${bridgeBack(this.turnCounter).toLowerCase()}`,
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
      this.pipeline.enqueue(event, turn.id, 0);
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
    this.observer.error('room.say_failed', error, { sayId });
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
    };
    this.turn = turn;
    this.pendingCheck = null;
    this.pausedBeforeTurn = 'teaching';
    this.setMode('thinking', p.id);
    let verdict: 'correct' | 'partial' | 'incorrect' | 'ungraded' = 'ungraded';
    let feedback = entry.check.explain;
    try {
      const { value } = await this.d.model.complete({
        messages: gradeMessages({
          system: this.system,
          question: entry.question,
          expected: entry.check.expected,
          options: entry.check.options,
          answer: answerText,
          explain: entry.check.explain,
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
      this.observer.error('room.grade', error);
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

  private cacheKey(): string {
    return `pen:${this.d.expert.id}:${this.d.band}:${this.d.language}`;
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
