import type { Participant, RemoteParticipant, Room, Track } from 'livekit-client';
import type { AudioRoomDisconnectReason, AudioRoomEvents, AudioRoomPort } from './port.js';

/** Debug handle for devtools and the two-browser e2e (`window.__penAudioRoom.remoteParticipants`). */
declare global {
  interface Window {
    __penAudioRoom?: Room;
  }
}

function audioMuted(p: Participant): boolean {
  const pubs = [...p.audioTrackPublications.values()];
  return pubs.length > 0 && pubs.every((pub) => pub.isMuted);
}

/**
 * livekit-client behind `AudioRoomPort`. The SDK is imported lazily so solo
 * sessions never download it. Remote voices play through hidden <audio>
 * elements (Chrome's echo canceller sees them, so a guest's voice does not
 * open our own mic); the microphone comes from the session, never from here.
 */
export class LiveKitAudioRoom implements AudioRoomPort {
  private room: Room | null = null;
  private published: MediaStreamTrack | null = null;
  private mount: HTMLElement | null = null;

  async connect(url: string, token: string, events: AudioRoomEvents): Promise<void> {
    const lk = await import('livekit-client');
    const room = new lk.Room({
      adaptiveStream: false,
      dynacast: false,
      // A page unload is a leave; the server frees the seat instead of waiting for a timeout.
      disconnectOnPageLeave: true,
      publishDefaults: {
        // Opus mono at 48 kb/s: transparent for speech, trivial for a self-hosted SFU.
        audioPreset: { maxBitrate: 48_000 },
        dtx: true,
        red: true,
        // The track is a clone of the session's mic; a mute must never stop it and re-open the device.
        stopMicTrackOnMute: false,
      },
    });
    const isLocal = (p: Participant) => p === room.localParticipant;
    room
      .on(lk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== lk.Track.Kind.Audio) return;
        const element = track.attach();
        element.dataset.penParticipant = participant.identity;
        this.mountElement(element);
        events.participant(participant.identity, { present: true, muted: publication.isMuted });
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) element.remove();
      })
      .on(lk.RoomEvent.ParticipantConnected, (p: RemoteParticipant) =>
        events.participant(p.identity, { present: true, muted: audioMuted(p) }),
      )
      .on(lk.RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) =>
        events.participant(p.identity, { present: false, muted: false }),
      )
      .on(lk.RoomEvent.TrackMuted, (publication, participant) => {
        if (publication.kind !== lk.Track.Kind.Audio) return;
        if (isLocal(participant)) events.localMuted(true);
        else events.participant(participant.identity, { present: true, muted: true });
      })
      .on(lk.RoomEvent.TrackUnmuted, (publication, participant) => {
        if (publication.kind !== lk.Track.Kind.Audio) return;
        if (isLocal(participant)) events.localMuted(false);
        else events.participant(participant.identity, { present: true, muted: false });
      })
      .on(lk.RoomEvent.ActiveSpeakersChanged, (speakers) =>
        events.speakers(speakers.map((s) => s.identity)),
      )
      .on(lk.RoomEvent.Reconnecting, () => events.connection('reconnecting'))
      .on(lk.RoomEvent.Reconnected, () => events.connection('connected'))
      .on(lk.RoomEvent.Disconnected, (reason) => {
        this.unmountAll();
        const R = lk.DisconnectReason;
        const why: AudioRoomDisconnectReason =
          reason === R.CLIENT_INITIATED
            ? 'leave'
            : reason === R.ROOM_DELETED ||
                reason === R.PARTICIPANT_REMOVED ||
                reason === R.DUPLICATE_IDENTITY ||
                reason === R.ROOM_CLOSED
              ? 'server'
              : 'lost';
        events.connection('disconnected', { reason: why });
      })
      .on(lk.RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        if (!playing) events.playbackBlocked();
      });
    // No `rtcConfig` here on purpose: the TURN servers come from the join response, and
    // livekit-client only fills `rtcConfig.iceServers` from it while the app has set none
    // (ADR-0012). A network that blocks UDP and 7881 is relayed through them without the
    // app configuring anything.
    await room.connect(url, token, { autoSubscribe: true });
    this.room = room;
    window.__penAudioRoom = room;
    for (const p of room.remoteParticipants.values())
      events.participant(p.identity, { present: true, muted: audioMuted(p) });
    events.connection('connected');
    if (!room.canPlaybackAudio) events.playbackBlocked();
  }

  async publish(track: MediaStreamTrack): Promise<void> {
    const room = this.room;
    if (!room) {
      track.stop();
      return;
    }
    const { Track: T } = await import('livekit-client');
    await room.localParticipant.publishTrack(track, { source: T.Source.Microphone });
    this.published = track;
  }

  async unpublish(): Promise<void> {
    const track = this.published;
    this.published = null;
    if (!track) return;
    if (this.room) await this.room.localParticipant.unpublishTrack(track, true);
    else track.stop();
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    const { Track: T } = await import('livekit-client');
    const publication = room.localParticipant.getTrackPublication(T.Source.Microphone);
    const track = publication?.track;
    if (!track) return;
    if (muted) await track.mute();
    else await track.unmute();
  }

  async resumePlayback(): Promise<void> {
    await this.room?.startAudio();
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.published = null;
    if (window.__penAudioRoom === room) delete window.__penAudioRoom;
    this.unmountAll();
    // `true` stops our published track (the mic clone); the session's own mic is untouched.
    await room?.disconnect(true);
  }

  private mountElement(element: HTMLMediaElement): void {
    if (!this.mount) {
      const div = document.createElement('div');
      div.hidden = true;
      div.dataset.pen = 'room-audio';
      document.body.append(div);
      this.mount = div;
    }
    this.mount.append(element);
  }

  private unmountAll(): void {
    this.mount?.remove();
    this.mount = null;
  }
}

/** Kept for type-only consumers that want the SDK's track kinds without importing the SDK. */
export type { Track };
