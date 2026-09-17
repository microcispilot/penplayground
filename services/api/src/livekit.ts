import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';

/**
 * Human-to-human audio in rooms rides on a self-hosted LiveKit server. The API
 * never carries media; it only mints join tokens (identity = participant id,
 * room = session id) and, for the host, asks the media server to mute a
 * participant's published audio. Everything the SDK does over the network is
 * behind `RoomServicePort` so tests can drive the mute flow with a fake.
 */
export interface RoomAudioTokenArgs {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
  /** Lets the media server accept mute requests signed by this token's owner; the API enforces host-only anyway. */
  roomAdmin: boolean;
  ttlSeconds?: number;
}

export interface RoomServiceParticipant {
  identity: string;
  /** SIDs of the audio tracks this participant publishes (muted or not). */
  audioTrackSids: string[];
}

export interface RoomServicePort {
  /** Every participant currently connected to the media room; empty when the room does not exist yet. */
  listParticipants(room: string): Promise<RoomServiceParticipant[]>;
  getParticipant(room: string, identity: string): Promise<RoomServiceParticipant | null>;
  muteTrack(room: string, identity: string, trackSid: string, muted: boolean): Promise<void>;
  /** Disconnect everyone and drop the room; a no-op when it does not exist. */
  deleteRoom(room: string): Promise<void>;
}

export interface LiveKitRoomsOptions {
  /** What browsers connect to (wss://DOMAIN/livekit). */
  url: string;
  /** How the API reaches the server's HTTP API; defaults to `url` with ws→http. */
  apiUrl?: string | undefined;
  apiKey: string;
  apiSecret: string;
  /** Test seam; the real one is a `RoomServiceClient`. */
  roomService?: RoomServicePort;
}

/** Sessions are ended after three hours (`RoomRegistry.sweep`); a token outliving that is pointless. */
const TOKEN_TTL_SECONDS = 3 * 60 * 60;

class SdkRoomService implements RoomServicePort {
  private readonly client: RoomServiceClient;
  constructor(apiUrl: string, apiKey: string, apiSecret: string) {
    this.client = new RoomServiceClient(apiUrl, apiKey, apiSecret);
  }
  async listParticipants(room: string): Promise<RoomServiceParticipant[]> {
    try {
      const list = await this.client.listParticipants(room);
      return list.map(toParticipant);
    } catch (error) {
      // A room only exists on the media server once someone connected; "not found" means nobody to mute.
      if (isNotFound(error)) return [];
      throw error;
    }
  }
  async getParticipant(room: string, identity: string): Promise<RoomServiceParticipant | null> {
    try {
      return toParticipant(await this.client.getParticipant(room, identity));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async muteTrack(room: string, identity: string, trackSid: string, muted: boolean): Promise<void> {
    await this.client.mutePublishedTrack(room, identity, trackSid, muted);
  }
  async deleteRoom(room: string): Promise<void> {
    try {
      await this.client.deleteRoom(room);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function toParticipant(info: {
  identity: string;
  tracks: Array<{ sid: string; type: TrackType }>;
}): RoomServiceParticipant {
  return {
    identity: info.identity,
    audioTrackSids: info.tracks.filter((t) => t.type === TrackType.AUDIO).map((t) => t.sid),
  };
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not\s*found|does not exist/i.test(message);
}

export class LiveKitRooms {
  readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly service: RoomServicePort;

  constructor(opts: LiveKitRoomsOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    const apiUrl = opts.apiUrl ?? opts.url.replace(/^ws(s?):\/\//, 'http$1://');
    this.service = opts.roomService ?? new SdkRoomService(apiUrl, opts.apiKey, opts.apiSecret);
  }

  /** A join token scoped to exactly one room; subscribing is always allowed, publishing per the caller. */
  async token(args: RoomAudioTokenArgs): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: args.identity,
      name: args.name,
      ttl: args.ttlSeconds ?? TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      room: args.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: args.canPublish,
      // Nothing of ours rides on LiveKit data channels (cues stay on our WebSocket), but without
      // this grant the server closes the SDK's data channel and every client logs an error.
      canPublishData: true,
      roomAdmin: args.roomAdmin,
    });
    return at.toJwt();
  }

  /** Mute every audio track a participant publishes. Returns how many tracks were muted (0 = not connected). */
  async muteParticipant(room: string, identity: string): Promise<number> {
    const participant = await this.service.getParticipant(room, identity);
    if (!participant) return 0;
    await Promise.all(
      participant.audioTrackSids.map((sid) => this.service.muteTrack(room, identity, sid, true)),
    );
    return participant.audioTrackSids.length;
  }

  /** The session ended: nobody should stay on a voice channel for a classroom that is over. */
  async closeRoom(room: string): Promise<void> {
    await this.service.deleteRoom(room);
  }

  /** Mute everyone but `except` (the host). Returns the identities that had audio to mute. */
  async muteAll(room: string, except: readonly string[]): Promise<string[]> {
    const participants = await this.service.listParticipants(room);
    const targets = participants.filter(
      (p) => !except.includes(p.identity) && p.audioTrackSids.length > 0,
    );
    await Promise.all(
      targets.flatMap((p) =>
        p.audioTrackSids.map((sid) => this.service.muteTrack(room, p.identity, sid, true)),
      ),
    );
    return targets.map((p) => p.identity);
  }
}
