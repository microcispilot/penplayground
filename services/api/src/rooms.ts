import type {
  DownstreamAudioHeader,
  ParticipantId,
  PlanCode,
  SelectionBand,
  ServerMessage,
} from '@pen/contracts';
import { encodeAudioFrame } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import { newSessionId, type RoomTransport, SessionRoom } from '@pen/session-engine';
import type { WebSocket } from 'ws';
import { intakeTopic } from './language.js';
import { observer } from './observability.js';
import type { Services } from './services.js';

interface Seat {
  participantId: ParticipantId;
  socket: WebSocket;
}

interface LiveRoom {
  room: SessionRoom;
  seats: Map<WebSocket, Seat>;
  record: SessionRecord;
  createdAt: number;
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
    // Intake (language + clean title) and an English resolution run concurrently: most topics are
    // English hits, and the lookup is free, so the model's ~1.5 s never sits on the critical path for them.
    const registry = services.onten.registry;
    const [intake, quick] = await Promise.all([
      intakeTopic(services.modelFor(args.host.plan), args.topic),
      registry.resolveTopic({ text: args.topic, language: 'en', locale: 'en-US', band: args.band }),
    ]);
    const { language, locale } = args.language
      ? { language: args.language.split('-')[0] ?? 'en', locale: args.language }
      : intake;
    const resolution =
      language === 'en' && quick.match === 'hit'
        ? quick
        : await registry.resolveTopic({ text: intake.title, language, locale, band: args.band });
    const allowPremium = args.host.plan !== 'free';
    const expert =
      (args.expertId ? services.experts.get(args.expertId) : null) ??
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
      onten: services.onten,
      runtime: services.onten.newRuntime(),
      memo: services.onten.memo,
      model: services.modelFor(args.host.plan),
      synthesizer: services.synthesizer,
      voice: services.voices.voiceFor(expert, locale),
      sampleRate: 44100,
      transport,
      observer,
      acquirer: services.acquirer,
      ledger: services.ledger,
      targetMinutes: 14,
      ads:
        args.host.plan === 'free'
          ? {
              everySegments: services.cfg.PEN_ADS_EVERY_SEGMENTS,
              durationMs: 15_000,
              skippableAfterMs: 5_000,
            }
          : null,
    });
    const record: SessionRecord = {
      id: sessionId,
      topic: args.topic,
      title: resolution.title,
      promise: '',
      expertId: expert.id,
      hostId: args.host.id,
      hostName: args.host.name,
      band: args.band,
      domain: resolution.domainBoundary,
      visibility: args.visibility,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      segments: 0,
      questions: 0,
      recap: [],
      views: 0,
      thumbnail: null,
    };
    await services.sessions.upsert(record);
    services.analytics.capture(args.host.id, 'session_started', {
      match: resolution.match,
      domain: resolution.domainBoundary,
      language,
      plan: args.host.plan,
      band: args.band,
    });
    const live: LiveRoom = { room, seats, record, createdAt: Date.now() };
    this.rooms.set(sessionId, live);
    void room.start().then(async () => {
      const state = room.getState();
      if (state.plan)
        await services.sessions.patch(sessionId, {
          title: state.plan.title,
          promise: state.plan.promise,
          segments: state.plan.segments.length,
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
    const state = live.room.getState();
    this.services.analytics.capture(live.record.hostId, 'session_ended', {
      durationMs: state.clockMs,
      segments: state.plan?.segments.length ?? 0,
      questions: live.room.backlog().filter((c) => c.event.type === 'note').length,
      completed: state.mode === 'complete',
    });
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

  /** Idle rooms (no seats for 10 minutes) are ended to bound cost. */
  sweep(now = Date.now()): void {
    for (const [id, live] of this.rooms) {
      const state = live.room.getState();
      if (state.phase === 'ended') continue;
      const idle = live.seats.size === 0 && now - live.createdAt > 10 * 60_000;
      const tooLong = now - live.createdAt > 3 * 60 * 60_000;
      if (idle || tooLong) void this.end(id);
    }
  }
}
