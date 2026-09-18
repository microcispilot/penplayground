import type {
  DownstreamAudioHeader,
  ParticipantId,
  PlanCode,
  SelectionBand,
  ServerMessage,
} from '@pen/contracts';
import { encodeAudioFrame, freshEstimateUsd, llmCostLines, PLAN_LIMITS } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import {
  newSessionId,
  type RoomTransport,
  roomCacheKey,
  SessionMetrics,
  SessionRoom,
} from '@pen/session-engine';
import type { WebSocket } from 'ws';
import { detectSpokenLanguage } from './language.js';
import { observer, scopedObserver } from './observability.js';
import type { Services } from './services.js';
import { computeTelemetry, sessionEndedProperties, stageProperties } from './telemetry.js';

/**
 * Stage samples streamed to PostHog per session. The ledger keeps every
 * sample regardless; this only bounds analytics volume for long sessions.
 */
export const MAX_STAGE_EVENTS_PER_SESSION = 500;

interface Seat {
  participantId: ParticipantId;
  socket: WebSocket;
}

export interface LiveRoom {
  room: SessionRoom;
  seats: Map<WebSocket, Seat>;
  record: SessionRecord;
  createdAt: number;
  plan: PlanCode;
  metrics: SessionMetrics;
  /** Stage events already sent to PostHog for this session. */
  readonly stageEvents: number;
}

/**
 * Registry of live rooms and the WebSocket transport that fans cues, state and
 * audio frames out to their seats. One process today; a Redis-backed registry
 * is the horizontal-scaling adapter for this seam.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, LiveRoom>();

  constructor(private readonly services: Services) {}

  get(sessionId: string): LiveRoom | null {
    return this.rooms.get(sessionId) ?? null;
  }

  async create(args: {
    topic: string;
    host: { id: ParticipantId; name: string; plan: PlanCode };
    band: SelectionBand;
    expertId?: string;
    visibility: 'public' | 'private';
    /** BCP-47 override; otherwise detected from the topic text. */
    language?: string;
  }): Promise<LiveRoom> {
    const { services } = this;
    const sessionId = newSessionId();
    const startedAt = Date.now();
    // Every stage of this session lands in its ledger and, bounded, in PostHog (ADR-0011).
    const counter = { stageEvents: 0 };
    const metrics = new SessionMetrics({
      sessionId,
      startedAt,
      ledger: services.ledger,
      onSample: (sample) => {
        if (counter.stageEvents >= MAX_STAGE_EVENTS_PER_SESSION) return;
        counter.stageEvents += 1;
        services.analytics.capture(args.host.id, 'stage', stageProperties(sessionId, sample));
      },
      // The breaker counts the very lines the ledger records, so the cap and
      // the Insights tab can never disagree about what today cost (ADR-0016).
      onCost: (line) => services.spend.record(line),
    });
    const modelId = services.modelFor(args.host.plan).id;
    // Intake (language + clean title) and an English resolution run concurrently: most topics are
    // English hits, and the lookup is free, so the model's ~1.5 s never sits on the critical path for them.
    const registry = services.onten.registry;
    const intakeTimer = metrics.start('intake');
    const resolveTimer = metrics.start('resolve');
    const [intake, quick] = await Promise.all([
      services.intake.intake(args.topic).then((r) => {
        const cached = r.via === 'cache';
        intakeTimer.end(true, {
          via: r.via,
          language: r.language,
          reused: cached,
          // A cache hit skips one translation call; English needs none, so nothing is "saved" there.
          savedUsd: cached ? freshEstimateUsd('intake', modelId) : 0,
        });
        if (r.usage) {
          metrics.sample({
            stage: 'llm',
            ms: r.usage.totalMs,
            ok: true,
            meta: {
              purpose: 'intake',
              model: r.usage.model,
              firstTokenMs: -1,
              tokensIn: r.usage.inputTokens,
              tokensCached: r.usage.cachedTokens,
              tokensOut: r.usage.outputTokens,
              usd: r.usage.usd,
              reused: false,
            },
          });
          for (const line of llmCostLines(r.usage, { purpose: 'intake', reused: false }))
            metrics.cost(line);
        }
        return r;
      }),
      registry.resolveTopic({ text: args.topic, language: 'en', locale: 'en-US', band: args.band }),
    ]);
    const { language, locale } = args.language
      ? { language: args.language.split('-')[0] ?? 'en', locale: args.language }
      : intake;
    // Knowledge is stored under the English title (packs are shared by every language) unless the
    // subject belongs to a language; the learner's own language only shapes communication.
    const resolution =
      intake.sourceLanguage === 'en' && quick.match === 'hit'
        ? quick
        : await registry.resolveTopic({
            text: intake.sourceLanguage === 'en' ? intake.canonicalTitle : intake.title,
            language: intake.sourceLanguage,
            locale: intake.sourceLanguage === 'en' ? 'en-US' : locale,
            band: args.band,
          });
    // Timing only: the room records the hit and what it saved (the memo decides the rest).
    resolveTimer.end(true, {
      canonicalId: resolution.canonicalKnowledgeId,
      match: resolution.match,
      score: resolution.score,
      timing: true,
    });
    const allowPremium = args.host.plan !== 'free';
    // Zero redundant generation: when nobody was asked for, the persona who already taught this
    // topic (and whose lesson is memoised) teaches it again, so the memo is reused, not rebuilt.
    const memoised =
      !args.expertId && resolution.packId
        ? await services.onten.memo.find(
            resolution.canonicalKnowledgeId,
            args.band,
            undefined,
            locale,
          )
        : null;
    const memoExpert = memoised ? services.experts.get(memoised.expertId) : null;
    const expert =
      (args.expertId ? services.experts.get(args.expertId) : null) ??
      (memoExpert && (allowPremium || !memoExpert.premium) ? memoExpert : null) ??
      services.experts.pickFor(
        resolution.domainBoundary as never,
        resolution.canonicalKnowledgeId,
        { allowPremium },
      );
    const seats = new Map<WebSocket, Seat>();
    const transport: RoomTransport = {
      broadcast: (message) => {
        const text = JSON.stringify(message);
        for (const seat of seats.keys()) if (seat.readyState === seat.OPEN) seat.send(text);
      },
      send: (participantId, message) => {
        const text = JSON.stringify(message);
        for (const [socket, seat] of seats)
          if (seat.participantId === participantId && socket.readyState === socket.OPEN)
            socket.send(text);
      },
      broadcastAudio: (header: DownstreamAudioHeader, pcm) => {
        const frame = encodeAudioFrame(header, pcm);
        for (const seat of seats.keys())
          if (seat.readyState === seat.OPEN) seat.send(frame, { binary: true });
      },
    };
    const room = new SessionRoom({
      sessionId,
      topic: args.topic,
      host: args.host,
      expert,
      band: args.band,
      language: locale,
      locale,
      resolution,
      onten: services.onten,
      runtime: services.onten.newRuntime(),
      memo: services.onten.memo,
      model: services.modelFor(args.host.plan),
      synthesizer: services.synthesizer,
      voice: services.voices.voiceFor(expert, locale),
      voiceFor: (lang) => services.voices.voiceFor(expert, lang),
      languageOf: (text) => detectSpokenLanguage(text),
      sampleRate: 44100,
      transport,
      observer: scopedObserver({ sessionId, expertId: expert.id, plan: args.host.plan }),
      acquirer: services.acquirer,
      ledger: services.ledger,
      metrics,
      searchProvider: services.searchProvider,
      targetMinutes: 14,
      participantAudio: services.livekit !== null,
      ads: services.ads.policyFor(args.host.plan, services.cfg.PEN_ADS_EVERY_SEGMENTS),
    });
    const record: SessionRecord = {
      id: sessionId,
      topic: args.topic,
      title: intake.title,
      promise: '',
      expertId: expert.id,
      hostId: args.host.id,
      hostName: args.host.name,
      band: args.band,
      domain: resolution.domainBoundary,
      visibility: args.visibility,
      language: locale,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      segments: 0,
      questions: 0,
      recap: [],
      views: 0,
      thumbnail: null,
      canonicalId: resolution.canonicalKnowledgeId,
      description: '',
      keywords: [],
      likes: 0,
    };
    await services.sessions.upsert(record);
    // The host's history row starts with the session (ADR-0015); taking the seat refreshes it.
    await services.lists.visit(args.host.id, record.id, 'host', record.startedAt);
    services.analytics.capture(args.host.id, 'session_started', {
      intake: intake.via,
      match: resolution.match,
      domain: resolution.domainBoundary,
      language,
      plan: args.host.plan,
      band: args.band,
    });
    const live: LiveRoom = {
      room,
      seats,
      record,
      createdAt: Date.now(),
      plan: args.host.plan,
      metrics,
      get stageEvents() {
        return counter.stageEvents;
      },
    };
    this.rooms.set(sessionId, live);
    void room.start().then(async () => {
      const state = room.getState();
      if (!state.plan) return;
      await services.sessions.patch(sessionId, {
        title: state.plan.title,
        promise: state.plan.promise,
        segments: state.plan.segments.length,
        // The room may have switched language with the learner; the saved page follows it.
        language: state.language,
      });
      // Card copy + sketch in the background (ADR-0013): the first audio never waits for it.
      services.meta.enqueue({
        sessionId,
        expert,
        band: args.band,
        topic: args.topic,
        plan: state.plan,
        language: state.language,
        // The lesson memo's scope is the card's too: a topic taught before reuses its sketch.
        canonicalId: resolution.canonicalKnowledgeId,
        cacheKey: roomCacheKey(expert.id, args.band),
        telemetry: metrics,
      });
    });
    return live;
  }

  attach(
    sessionId: string,
    socket: WebSocket,
    participant: { id: ParticipantId; name: string },
  ): { ok: true; live: LiveRoom } | { ok: false; message: ServerMessage } {
    const live = this.rooms.get(sessionId);
    if (!live)
      return {
        ok: false,
        message: {
          kind: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'This session is not live.',
          spoken: false,
        },
      };
    if (live.room.getState().phase === 'ended')
      return {
        ok: false,
        message: {
          kind: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'This session has ended.',
          spoken: false,
        },
      };
    const joined = live.room.join(participant);
    if (!joined.ok)
      return {
        ok: false,
        message: {
          kind: 'error',
          code: joined.code,
          message:
            joined.code === 'ROOM_FULL'
              ? 'This room is full (12 people).'
              : 'Rooms with guests need the Professional plan.',
          spoken: false,
        },
      };
    // A participant reconnecting replaces their old socket.
    for (const [s, seat] of live.seats)
      if (seat.participantId === participant.id) live.seats.delete(s);
    live.seats.set(socket, { participantId: participant.id, socket });
    // History (ADR-0015): the seat is what makes a session "attended". Off the join path;
    // a failed write costs one history row, never the join.
    this.services.lists
      .visit(participant.id, sessionId, participant.id === live.record.hostId ? 'host' : 'guest')
      .catch((error) => observer.error('lists.visit', error, { sessionId }));
    return { ok: true, live };
  }

  detach(sessionId: string, socket: WebSocket): void {
    const live = this.rooms.get(sessionId);
    if (!live) return;
    const seat = live.seats.get(socket);
    live.seats.delete(socket);
    if (seat) live.room.leave(seat.participantId);
  }

  async end(sessionId: string): Promise<void> {
    const live = this.rooms.get(sessionId);
    if (!live) return;
    await live.room.end();
    // The media room goes with the session; clients also disconnect on the ended state, so a
    // failure here only leaves an empty room for LiveKit's own empty_timeout to collect.
    this.services.livekit
      ?.closeRoom(sessionId)
      .catch((error) => observer.error('rooms.audio.close', error, { sessionId }));
    const state = live.room.getState();
    // The full summary (latencies, costs, reuse; numbers and codes only) so PostHog can chart
    // sessions without the ledger. The ad tally is the room-validated count of host reports
    // (ADR-0014); its revenue estimate is also in the ledger as `cost.adsRevenueUsd`.
    const ads = this.services.ads.tally(sessionId);
    try {
      const telemetry = computeTelemetry({
        sessionId,
        plan: live.plan,
        expertId: state.expertId,
        language: state.language,
        entries: this.services.ledger.read(sessionId),
      });
      this.services.analytics.capture(live.record.hostId, 'session_ended', {
        ...sessionEndedProperties(telemetry, {
          completed: state.mode === 'complete',
          providers: {
            llm: this.services.cfg.PEN_LLM_PROVIDER,
            tts: this.services.synthesizer.id,
            stt: this.services.recognizer?.id ?? 'browser',
          },
        }),
        adsRequested: ads.requested,
        adsCompleted: ads.completed,
        adsErrors: ads.errors,
        adRevenueEstimateUsd: ads.revenueUsd,
      });
      void this.services.analytics
        .flush()
        .catch((error) => observer.error('analytics.flush', error, { sessionId }));
    } catch (error) {
      observer.error('telemetry.session_ended', error, { sessionId });
    }
    observer.event('room.economics', { sessionId, ...ads });
    this.services.ads.forget(sessionId);
    await this.services.sessions.patch(sessionId, {
      endedAt: Date.now(),
      durationMs: state.clockMs,
      segments: state.plan?.segments.length ?? 0,
      recap: state.recap ?? [],
      questions: live.room.backlog().filter((c) => c.event.type === 'note').length,
    });
    // Keep the ended room around briefly so late "state" reads succeed, then release.
    setTimeout(() => this.rooms.delete(sessionId), 60_000);
  }

  /**
   * Rooms nobody is in (10 minutes) and rooms that have run their plan's full
   * length are ended. The length ceiling is what stops a tab left open
   * overnight from quietly spending all night (PLAN_LIMITS.maxSessionMinutes).
   */
  sweep(now = Date.now()): void {
    for (const [id, live] of this.rooms) {
      const state = live.room.getState();
      if (state.phase === 'ended') continue;
      const idle = live.seats.size === 0 && now - live.createdAt > 10 * 60_000;
      const ceilingMs = PLAN_LIMITS[live.plan].maxSessionMinutes * 60_000;
      const tooLong = now - live.createdAt > ceilingMs;
      if (tooLong)
        observer.event('room.length_ceiling', {
          sessionId: id,
          plan: live.plan,
          minutes: PLAN_LIMITS[live.plan].maxSessionMinutes,
        });
      if (idle || tooLong) void this.end(id);
    }
  }
}
