import type {
  DownstreamAudioHeader,
  Expert,
  FeatureSet,
  ParticipantId,
  PlanCode,
  Platform,
  SelectionBand,
  ServerMessage,
} from '@pen/contracts';
import {
  encodeAudioFrame,
  freshEstimateUsd,
  llmCostLines,
  PLAN_LIMITS,
  planAllowsExpert,
} from '@pen/contracts';
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
import type { EndReason } from './stats/derive.js';
import { computeTelemetry, sessionEndedProperties, stageProperties } from './telemetry.js';

/**
 * Stage samples streamed to PostHog per session. The ledger keeps every
 * sample regardless; this only bounds analytics volume for long sessions.
 */
export const MAX_STAGE_EVENTS_PER_SESSION = 500;

/**
 * How long an ended room is kept in the registry, so a client's last "state"
 * read after the socket closes still finds it.
 */
export const ROOM_RELEASE_MS = 60_000;

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
  /** Where the host started this session from. */
  platform: Platform;
  /** The flags the room was built with (ADR-0036), resolved once for the host's plan and platform. */
  features: FeatureSet;
  metrics: SessionMetrics;
  /**
   * The runtime settings the room was built with (ADR-0025), so the finished
   * session can be explained from its own record rather than from whatever
   * the dashboard happens to say when someone comes to look.
   */
  settings: Record<string, string | number | boolean>;
  /** Stage events already sent to PostHog for this session. */
  readonly stageEvents: number;
}

/**
 * The topic is not prepared and this host's plan may not have it prepared
 * (`prepare_new_topics`, ADR-0036). Thrown before a row is written, an ad
 * priced or a room built, so the attempt costs nothing and counts for
 * nothing: the intake lookup that found the miss is the whole of it.
 */
export class PreparationRefused extends Error {
  constructor(
    readonly plan: PlanCode,
    readonly canonicalId: string,
  ) {
    super('This topic is not prepared yet.');
    this.name = 'PreparationRefused';
  }
}

/**
 * Registry of live rooms and the WebSocket transport that fans cues, state and
 * audio frames out to their seats. One process today; a Redis-backed registry
 * is the horizontal-scaling adapter for this seam.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, LiveRoom>();
  /** The one ending each live session will have, claimed in `end`'s first tick. */
  private readonly ending = new Map<string, Promise<void>>();

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
    /** The host's remembered teaching pace, so the room is born at it (ADR-0010). */
    pace?: number;
    /** Where the host is starting from; decides the flags with the plan (ADR-0036). */
    platform?: Platform;
    /**
     * `replay` when the host started a prepared lesson again from a card or a
     * shelf (ADR-0035): reported, and never allowed to reach the preparation
     * path, because a replay of an unprepared lesson is a contradiction.
     */
    origin?: 'search' | 'replay';
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
    const plan = args.host.plan;
    const platform = args.platform ?? 'web';
    /**
     * Resolved once, here, and kept for the room's life (ADR-0036) — the same
     * rule as the runtime settings below: what the room was built with is
     * what it offers, whatever the console says an hour later.
     */
    const features = services.features.featuresFor(plan, platform);
    const prepared =
      resolution.match === 'hit' || (resolution.match === 'partial' && resolution.packId !== null);
    if (!prepared && !features.prepare_new_topics) {
      observer.event('rooms.preparation_refused', {
        plan,
        platform,
        origin: args.origin ?? 'search',
        ckid: resolution.canonicalKnowledgeId,
      });
      // The intake timing above already opened this id's ledger on disk;
      // an attempt that becomes no session leaves nothing behind.
      services.ledger.remove(sessionId);
      throw new PreparationRefused(plan, resolution.canonicalKnowledgeId);
    }
    // Zero redundant generation: when nobody was asked for, the persona who already taught this
    // topic (and whose lesson is memoised) teaches it again, so the memo is reused, not rebuilt.
    const memoised =
      !args.expertId && resolution.packId
        ? await services.memo.find(resolution.canonicalKnowledgeId, args.band, undefined, locale)
        : null;
    const memoExpert = memoised ? services.experts.get(memoised.expertId) : null;
    // A persona the plan does not include is never seated, however it was reached:
    // asked for by id (the API has already answered that request with a 402),
    // inherited from a memo, or picked for the domain.
    const included = (e: Expert | null) => (e && planAllowsExpert(plan, e.id) ? e : null);
    const expert =
      included(args.expertId ? services.experts.get(args.expertId) : null) ??
      included(memoExpert) ??
      services.experts.pickFor(
        resolution.domainBoundary as never,
        resolution.canonicalKnowledgeId,
        { plan },
      );
    /**
     * The runtime settings this room will run on, read once here and kept
     * (ADR-0025). A lesson never changes its mind half way through because
     * somebody saved the dashboard: what the room was built with is what it
     * teaches with, and what its telemetry reports afterwards.
     */
    const settings = services.config.snapshot();
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
      // The host removed them (ADR-0037): after the `REMOVED` error the room
      // already sent, their seats close, and `join` will refuse them.
      close: (participantId) => {
        for (const [socket, seat] of seats)
          if (seat.participantId === participantId) {
            seats.delete(socket);
            if (socket.readyState === socket.OPEN) socket.close(4003, 'removed');
          }
      },
    };
    const room = new SessionRoom({
      sessionId,
      topic: args.topic,
      host: args.host,
      expert,
      band: args.band,
      ...(args.pace === undefined ? {} : { pace: args.pace }),
      language: locale,
      locale,
      resolution,
      onten: services.onten,
      runtime: services.onten.newRuntime(),
      memo: services.memo,
      model: services.modelFor(args.host.plan),
      intent: services.intentFor(),
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
      features,
      ads: services.ads.policyFor(
        features,
        sessionId,
        services.config.get('PEN_ADS_EVERY_SEGMENTS'),
      ),
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
    // From here on the room exists in the ad ledger (`policyFor` above put
    // its rate there), so anything that throws before it is registered has to
    // take that entry with it — otherwise a database wobble with retrying
    // clients grows that map without bound.
    try {
      await services.sessions.upsert(record);
      // The host's history row starts with the session (ADR-0015); taking the seat refreshes it.
      await services.lists.visit(args.host.id, record.id, 'host', record.startedAt);
    } catch (error) {
      services.ads.forget(sessionId);
      throw error;
    }
    services.analytics.capture(args.host.id, 'session_started', {
      intake: intake.via,
      match: resolution.match,
      domain: resolution.domainBoundary,
      language,
      plan: args.host.plan,
      band: args.band,
      platform,
      origin: args.origin ?? 'search',
    });
    const live: LiveRoom = {
      room,
      seats,
      record,
      createdAt: Date.now(),
      plan: args.host.plan,
      platform,
      features,
      metrics,
      settings,
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
      // Card copy + thumbnail in the background (ADR-0013, ADR-0021): the
      // first audio never waits for them — and, just as importantly, they
      // never compete with it. All of it goes to the same provider over the
      // same connection, so a card started the moment the plan lands is
      // written alongside the one call the learner is actually waiting for.
      // It waits for the first sentence to be audible instead; by then
      // nothing is racing it.
      await room.firstAudio;
      const settled = room.getState();
      if (!settled.plan) return;
      services.meta.enqueue({
        sessionId,
        expert,
        band: args.band,
        topic: args.topic,
        plan: settled.plan,
        language: settled.language,
        // The host's plan decides the provider key both background calls bill
        // to — the same key `modelFor` gave this session's lesson. Never the
        // platform key: this work belongs to this learner's session.
        billTo: args.host.plan,
        // The lesson memo's scope is the card's too: a topic taught before
        // reuses its copy and its picture, and pays for neither.
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
              : joined.code === 'REMOVED'
                ? 'The host removed you from this room.'
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

  /**
   * Close a session: stop the room, tell analytics, write the row, queue the
   * statistics, then let the room go.
   *
   * One ending per session, claimed in this tick. The socket's `control`/`end`
   * frame, the REST route, `endAndErase` and `sweep()` can all reach this, and
   * two of them overlapping used to run the whole tail twice — two
   * `session_ended` events, two telemetry computations, and an `endReason`
   * overwritten by whichever landed second. `SessionRoom.end` has its own
   * claim for its own recap; this is the registry's.
   */
  async end(sessionId: string, reason: EndReason = 'host'): Promise<void> {
    const live = this.rooms.get(sessionId);
    if (!live) return;
    let ending = this.ending.get(sessionId);
    if (!ending) {
      ending = this.runEnd(sessionId, live, reason);
      this.ending.set(sessionId, ending);
    }
    return ending;
  }

  private async runEnd(sessionId: string, live: LiveRoom, reason: EndReason): Promise<void> {
    try {
      await this.endInner(sessionId, live);
    } finally {
      // Whatever went wrong above, these two must still happen.
      //
      // `sessions.patch` used to be awaited in the middle of this tail, so one
      // database blip took everything below it: the ledger never reached the
      // statistics queue, and the room was never scheduled for release. The
      // room's phase is already `ended` by then, so `sweep()` skips it for
      // good — a whole `LiveRoom` held for the life of the process, and a
      // session that never appears in any report.
      this.services.deriver.enqueue(sessionId, {
        completed: live.room.getState().mode === 'complete',
        endReason: reason,
      });
      // Keep the ended room around briefly so late "state" reads succeed, then
      // release it. Unreferenced: a process on its way out should not wait a
      // minute to tidy a map it is about to drop anyway.
      const release = setTimeout(() => {
        this.rooms.delete(sessionId);
        this.ending.delete(sessionId);
      }, ROOM_RELEASE_MS);
      release.unref?.();
    }
  }

  /** The ending itself. Everything here may fail; `runEnd` owns what may not. */
  private async endInner(sessionId: string, live: LiveRoom): Promise<void> {
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
            llm: this.services.config.get('PEN_LLM_PROVIDER'),
            tts: this.services.synthesizer.id,
            stt: this.services.recognizer?.id ?? 'browser',
          },
          settings: live.settings,
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
    try {
      await this.services.sessions.patch(sessionId, {
        endedAt: Date.now(),
        durationMs: state.clockMs,
        segments: state.plan?.segments.length ?? 0,
        recap: state.recap ?? [],
        questions: live.room.backlog().filter((c) => c.event.type === 'note').length,
      });
    } catch (error) {
      // The room is closed either way, and the learner is not the person to
      // tell about a database blip. It goes to Sentry, and the deletion route
      // that is about to remove this row does not become a 500 over it.
      observer.error('rooms.patch_ended', error, { sessionId });
    }
    // The statistics queue (ADR-0027) and the room's release are in `runEnd`'s
    // `finally`, because they have to happen whether or not this write did.
  }

  /**
   * Rooms nobody is in (10 minutes) and rooms that have run their plan's full
   * length are ended. The length ceiling is what stops a tab left open
   * overnight from quietly spending all night (PLAN_LIMITS.maxSessionMinutes).
   */
  /**
   * End every room that is still running, and wait for all of them.
   *
   * Shutdown only. A live room that the process simply exits under keeps
   * `endedAt: null` for ever: it never enters the catalogue, never reaches
   * the statistics queue, and shows in "My sessions" as a lesson that never
   * finished — which, from the learner's side, is what a deploy looked like.
   * `reason: 'shutdown'` is what tells those rows apart afterwards from a
   * learner who walked away.
   *
   * Failures are reported, never thrown: one room that cannot be written
   * must not stop the others from being.
   */
  async endAll(reason: EndReason = 'shutdown'): Promise<number> {
    const live = [...this.rooms]
      .filter(([, room]) => room.room.getState().phase !== 'ended')
      .map(([id]) => id);
    await Promise.all(
      live.map((id) =>
        this.end(id, reason).catch((error: unknown) =>
          observer.error('rooms.end_all', error, { sessionId: id }),
        ),
      ),
    );
    return live.length;
  }

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
      // Which of the two closed it is the difference between "they walked
      // away" and "their plan's hour ran out", and the statistics keep them apart.
      if (tooLong) void this.end(id, 'length_ceiling');
      else if (idle) void this.end(id, 'idle');
    }
  }
}
