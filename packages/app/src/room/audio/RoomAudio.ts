import type { AudioRoomEvents, AudioRoomPort } from './port.js';

export type RoomAudioStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** What the room UI renders: presence and mute per remote participant, who is speaking, our own state. */
export interface RoomAudioUi {
  status: RoomAudioStatus;
  /** Remote participants connected to the media server, by participant id. */
  participants: Record<string, { muted: boolean }>;
  /** Participant ids speaking right now (ours included). */
  speaking: string[];
  /** The host muted our voice to the room. The mic still hears us for questions; unmuting is ours to do. */
  mutedByHost: boolean;
  /** Remote voices are waiting for a gesture (browser autoplay policy). */
  playbackBlocked: boolean;
}

export interface RoomAudioOptions {
  /** Mint a join token for this participant; throws an error with `status` when the feature is refused. */
  token(): Promise<{ url: string; token: string }>;
  /** Host only: mute one guest, or everyone when `participantId` is absent. */
  mute(participantId?: string): Promise<{ muted: string[] }>;
  createPort(): AudioRoomPort;
  onUpdate(ui: RoomAudioUi): void;
  onError(area: string, error: unknown): void;
  /** Another human is talking: the mic raises its barge-in bar the same way it does for expert playback. */
  onRemoteSpeaking?(speaking: boolean): void;
  /** Test seam for the reconnect timer. */
  schedule?(fn: () => void, ms: number): () => void;
}

/** Reconnect after an unexpected drop: 1 s, 2 s, 4 s, 8 s, 8 s — then give up and say so. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000] as const;

const INITIAL: RoomAudioUi = {
  status: 'off',
  participants: {},
  speaking: [],
  mutedByHost: false,
  playbackBlocked: false,
};

function statusOf(error: unknown): number | null {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : null;
}

/**
 * Human-to-human audio for one visit to a room. Owns the media connection's
 * lifecycle (token → connect → publish the shared mic → recover from drops →
 * tear down) and turns port events into one UI snapshot. It never opens the
 * microphone: the session hands it the track it already captures for STT.
 */
export class RoomAudio {
  private ui: RoomAudioUi = INITIAL;
  private port: AudioRoomPort | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private published = false;
  /**
   * Bumped by anything that supersedes an in-flight publish — a detach, a
   * dispose, another publish. `publishIfReady` reads it back across its
   * await to find out whether the clone it just put in the room is still
   * wanted.
   */
  private publishEpoch = 0;
  private attempts = 0;
  private cancelTimer: (() => void) | null = null;
  private disposed = false;
  private connecting: Promise<void> | null = null;
  private readonly schedule: NonNullable<RoomAudioOptions['schedule']>;

  constructor(private readonly o: RoomAudioOptions) {
    this.schedule =
      o.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  get state(): RoomAudioUi {
    return this.ui;
  }

  /** Idempotent: safe to call on every room-state message that says audio is on. */
  connect(): Promise<void> {
    if (this.disposed || this.port) return this.connecting ?? Promise.resolve();
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    this.patch({ status: this.attempts === 0 ? 'connecting' : 'reconnecting' });
    let grant: { url: string; token: string };
    try {
      grant = await this.o.token();
    } catch (error) {
      const status = statusOf(error);
      // Refused (plan, membership, feature off): nothing a retry would change; the room stays voice-less.
      if (status !== null && status >= 400 && status < 500) {
        this.patch({ status: 'off' });
        return;
      }
      this.o.onError('rooms.audio.token', error);
      this.retry();
      return;
    }
    if (this.disposed) return;
    const port = this.o.createPort();
    try {
      await port.connect(grant.url, grant.token, this.events(port));
    } catch (error) {
      this.o.onError('rooms.audio.connect', error);
      await port.disconnect().catch(() => undefined);
      this.retry();
      return;
    }
    if (this.disposed) {
      await port.disconnect().catch(() => undefined);
      return;
    }
    this.port = port;
    this.attempts = 0;
    this.patch({ status: 'connected' });
    await this.publishIfReady();
  }

  private events(port: AudioRoomPort): AudioRoomEvents {
    const live = () => this.port === port && !this.disposed;
    return {
      connection: (status, detail) => {
        if (!live()) return;
        if (status === 'connected') this.patch({ status: 'connected' });
        else if (status === 'reconnecting') this.patch({ status: 'reconnecting' });
        else {
          // The SDK gave up, or the server removed us. Release the dead port either way
          // (its own disconnect is idempotent) and start over with a fresh token only for a
          // genuine drop: after a server-side removal a reconnect would just fight the server.
          this.port = null;
          this.published = false;
          this.publishEpoch += 1;
          this.patch({ participants: {}, speaking: [] });
          this.o.onRemoteSpeaking?.(false);
          void port.disconnect().catch(() => undefined);
          if (detail?.reason === 'lost') this.retry();
          else if (detail?.reason === 'server') this.patch({ status: 'off' });
        }
      },
      participant: (id, info) => {
        if (!live()) return;
        const participants = { ...this.ui.participants };
        if (info.present) participants[id] = { muted: info.muted };
        else delete participants[id];
        this.patch({ participants });
      },
      speakers: (ids) => {
        if (!live()) return;
        const speaking = [...ids];
        this.patch({ speaking });
        this.o.onRemoteSpeaking?.(speaking.some((id) => this.ui.participants[id] !== undefined));
      },
      localMuted: (muted) => {
        if (!live()) return;
        // We never mute our own publication through the port (mic off = unpublish), so an
        // unrequested mute can only be the host's.
        this.patch({ mutedByHost: muted });
      },
      playbackBlocked: () => {
        if (live()) this.patch({ playbackBlocked: true });
      },
    };
  }

  private retry(): void {
    if (this.disposed) return;
    const delay = RECONNECT_DELAYS_MS[this.attempts];
    if (delay === undefined) {
      this.patch({ status: 'failed' });
      this.o.onError(
        'rooms.audio.gave_up',
        new Error(`no media connection after ${this.attempts} attempts`),
      );
      return;
    }
    this.attempts += 1;
    this.patch({ status: 'reconnecting' });
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      void this.connect();
    }, delay);
  }

  /** The microphone the session already captures; published as a clone so STT and the room share one grant. */
  async attachMicrophone(track: MediaStreamTrack): Promise<void> {
    this.micTrack = track;
    await this.publishIfReady();
  }

  async detachMicrophone(): Promise<void> {
    this.micTrack = null;
    // Anything already publishing is now superseded: see `publishIfReady`.
    this.publishEpoch += 1;
    if (!this.port || !this.published) return;
    this.published = false;
    try {
      await this.port.unpublish();
    } catch (error) {
      this.o.onError('rooms.audio.unpublish', error);
    }
  }

  /**
   * Publish a clone of the microphone the session already captures.
   *
   * `published = true` is set **before** the await and that is deliberate —
   * it is what stops a second caller publishing a second clone — but on its
   * own it was a hot microphone. `port.publish()` is a renegotiation and
   * takes real time; a learner who turns the mic off inside that window runs
   * `detachMicrophone`, which sees `published === true`, sets it to `false`
   * and unpublishes *nothing that is there yet*. The publish then completes,
   * and a live clone is in the room with `published === false` beside it —
   * so nothing will ever take it down, and the UI says the microphone is
   * off while it is not.
   *
   * The epoch is what closes it: whoever finishes publishing checks whether
   * the world still wants what it published, and undoes it if not. The clone
   * is stopped on every path that does not keep it, because a clone left
   * running holds the browser's recording indicator on by itself.
   */
  private async publishIfReady(): Promise<void> {
    if (!this.port || !this.micTrack || this.published) return;
    const epoch = ++this.publishEpoch;
    const port = this.port;
    const clone = this.micTrack.clone();
    this.published = true;
    try {
      await port.publish(clone);
    } catch (error) {
      this.published = false;
      clone.stop();
      this.o.onError('rooms.audio.publish', error);
      return;
    }
    if (epoch === this.publishEpoch && this.micTrack && !this.disposed) return;
    // Detached, disposed or superseded while we were publishing.
    this.published = false;
    clone.stop();
    try {
      await port.unpublish();
    } catch (error) {
      this.o.onError('rooms.audio.unpublish', error);
    }
  }

  /** Lift a host mute on ourselves (the mic button when `mutedByHost`). */
  async unmute(): Promise<void> {
    if (!this.port) return;
    await this.port.setMuted(false);
    this.patch({ mutedByHost: false });
  }

  /** Host: mute one guest or everyone. Rejects when the API refuses so the UI can say so. */
  async muteParticipant(participantId?: string): Promise<string[]> {
    try {
      return (await this.o.mute(participantId)).muted;
    } catch (error) {
      this.o.onError('rooms.audio.mute', error);
      throw error;
    }
  }

  /** From a user gesture: let the browser play the room. */
  async resumePlayback(): Promise<void> {
    if (!this.port) return;
    try {
      await this.port.resumePlayback();
      this.patch({ playbackBlocked: false });
    } catch (error) {
      this.o.onError('rooms.audio.playback', error);
    }
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const port = this.port;
    this.port = null;
    this.micTrack = null;
    this.published = false;
    // Same reason as `detachMicrophone`: a publish still in flight must not
    // land in a room nobody is in any more.
    this.publishEpoch += 1;
    this.o.onRemoteSpeaking?.(false);
    this.patch({ ...INITIAL });
    if (port)
      await port.disconnect().catch((error) => this.o.onError('rooms.audio.disconnect', error));
  }

  private patch(partial: Partial<RoomAudioUi>): void {
    this.ui = { ...this.ui, ...partial };
    this.o.onUpdate(this.ui);
  }
}
