/**
 * The seam between the room's audio controller and the media SDK. Small on
 * purpose: the controller only needs to know who is present, who is speaking,
 * who is muted, and whether the connection is up. `LiveKitAudioRoom`
 * implements it with livekit-client; tests drive `RoomAudio` with a fake.
 */
export type AudioRoomConnection = 'connected' | 'reconnecting' | 'disconnected';

/**
 * Why a connection ended: `leave` is our own `disconnect()`, `server` is a deliberate
 * server-side removal (room deleted, participant removed, same identity joined elsewhere)
 * that a reconnect would only fight, `lost` is a drop the controller should recover from.
 */
export type AudioRoomDisconnectReason = 'leave' | 'server' | 'lost';

export interface AudioRoomEvents {
  connection(status: AudioRoomConnection, detail?: { reason: AudioRoomDisconnectReason }): void;
  /** A remote participant's presence and audio mute state; emitted for everyone present right after connect. */
  participant(id: string, info: { present: boolean; muted: boolean }): void;
  /** Identities currently speaking (local included), replacing the previous set. */
  speakers(ids: readonly string[]): void;
  /** Our published microphone was muted or unmuted — by us or by the host through the server. */
  localMuted(muted: boolean): void;
  /** The browser refused to start remote audio without a gesture; call `resumePlayback()` from one. */
  playbackBlocked(): void;
}

export interface AudioRoomPort {
  connect(url: string, token: string, events: AudioRoomEvents): Promise<void>;
  disconnect(): Promise<void>;
  /** Publish a microphone track the port now owns (it is stopped on unpublish/disconnect). */
  publish(track: MediaStreamTrack): Promise<void>;
  unpublish(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  resumePlayback(): Promise<void>;
}
