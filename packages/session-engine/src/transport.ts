import type { DownstreamAudioHeader, ParticipantId, ServerMessage } from '@pen/contracts';

/** How the room reaches its participants; the API implements it over WebSocket. */
export interface RoomTransport {
  broadcast(message: ServerMessage): void;
  send(participantId: ParticipantId, message: ServerMessage): void;
  broadcastAudio(header: DownstreamAudioHeader, pcm: Uint8Array): void;
}

export interface RoomObserver {
  /** Structured events for logs/Sentry/analytics; never throws. */
  event(name: string, data: Record<string, unknown>): void;
  error(area: string, error: unknown, data?: Record<string, unknown>): void;
}

export const SILENT_OBSERVER: RoomObserver = { event: () => undefined, error: () => undefined };
