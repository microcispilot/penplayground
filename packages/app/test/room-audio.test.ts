import { describe, expect, it } from 'vitest';
import type { AudioRoomEvents, AudioRoomPort } from '../src/room/audio/port.js';
import { RoomAudio, type RoomAudioUi } from '../src/room/audio/RoomAudio.js';

/** A media room that records every call and lets the test raise events as the SDK would. */
class FakePort implements AudioRoomPort {
  events: AudioRoomEvents | null = null;
  readonly calls: string[] = [];
  published: FakeTrack[] = [];
  muted: boolean[] = [];
  connectError: Error | null = null;
  async connect(url: string, token: string, events: AudioRoomEvents): Promise<void> {
    this.calls.push(`connect ${url} ${token}`);
    if (this.connectError) throw this.connectError;
    this.events = events;
  }
  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    for (const t of this.published) t.stop();
  }
  async publish(track: MediaStreamTrack): Promise<void> {
    this.calls.push('publish');
    this.published.push(track as unknown as FakeTrack);
  }
  async unpublish(): Promise<void> {
    this.calls.push('unpublish');
    for (const t of this.published) t.stop();
  }
  async setMuted(muted: boolean): Promise<void> {
    this.calls.push(`setMuted ${muted}`);
    this.muted.push(muted);
  }
  async resumePlayback(): Promise<void> {
    this.calls.push('resumePlayback');
  }
}

/** Only what the controller touches: `clone()` and `stop()`; the clone is what gets published. */
class FakeTrack {
  stopped = false;
  clones: FakeTrack[] = [];
  clone(): FakeTrack {
    const c = new FakeTrack();
    this.clones.push(c);
    return c;
  }
  stop(): void {
    this.stopped = true;
  }
  asTrack(): MediaStreamTrack {
    return this as unknown as MediaStreamTrack;
  }
}

interface Harness {
  audio: RoomAudio;
  ports: FakePort[];
  updates: RoomAudioUi[];
  errors: Array<{ area: string; error: unknown }>;
  remoteSpeaking: boolean[];
  tokens: number;
  mutes: Array<string | undefined>;
  timers: Array<{ fn: () => void; ms: number }>;
  fire(): void;
}

function harness(opts: { tokenError?: unknown; portFactory?: () => FakePort } = {}): Harness {
  const ports: FakePort[] = [];
  const updates: RoomAudioUi[] = [];
  const errors: Array<{ area: string; error: unknown }> = [];
  const remoteSpeaking: boolean[] = [];
  const mutes: Array<string | undefined> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const h = { tokens: 0 } as Harness;
  h.audio = new RoomAudio({
    token: async () => {
      h.tokens += 1;
      if (opts.tokenError) throw opts.tokenError;
      return { url: 'ws://lk', token: `t${h.tokens}` };
    },
    mute: async (participantId) => {
      mutes.push(participantId);
      return { muted: participantId ? [participantId] : ['g1', 'g2'] };
    },
    createPort: () => {
      const port = opts.portFactory ? opts.portFactory() : new FakePort();
      ports.push(port);
      return port;
    },
    onUpdate: (ui) => updates.push(ui),
    onError: (area, error) => errors.push({ area, error }),
    onRemoteSpeaking: (s) => remoteSpeaking.push(s),
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  Object.assign(h, {
    ports,
    updates,
    errors,
    remoteSpeaking,
    mutes,
    timers,
    fire: () => {
      const next = timers.shift();
      next?.fn();
    },
  });
  return h;
}

const events = (h: Harness, i = h.ports.length - 1): AudioRoomEvents => {
  const e = h.ports[i]?.events;
  if (!e) throw new Error('port not connected');
  return e;
};

describe('RoomAudio', () => {
  it('connects with a fresh token and publishes the microphone clone once both are ready', async () => {
    const h = harness();
    const mic = new FakeTrack();
    // The mic came up before the room said audio is on: the track waits for the connection.
    await h.audio.attachMicrophone(mic.asTrack());
    expect(h.ports).toHaveLength(0);
    await h.audio.connect();
    expect(h.ports[0]?.calls).toEqual(['connect ws://lk t1', 'publish']);
    expect(mic.clones).toHaveLength(1);
    expect(mic.stopped).toBe(false);
    expect(h.audio.state.status).toBe('connected');
    // Idempotent: a second state message does not open a second connection.
    await h.audio.connect();
    expect(h.ports).toHaveLength(1);
  });

  it('publishes when the mic arrives after connecting, and unpublishes without touching the source track', async () => {
    const h = harness();
    await h.audio.connect();
    const mic = new FakeTrack();
    await h.audio.attachMicrophone(mic.asTrack());
    expect(h.ports[0]?.calls).toEqual(['connect ws://lk t1', 'publish']);
    await h.audio.detachMicrophone();
    expect(h.ports[0]?.calls.at(-1)).toBe('unpublish');
    expect(mic.clones[0]?.stopped).toBe(true);
    expect(mic.stopped).toBe(false);
    // A second detach is a no-op.
    await h.audio.detachMicrophone();
    expect(h.ports[0]?.calls.filter((c) => c === 'unpublish')).toHaveLength(1);
  });

  it('tracks remote presence, mute state and speakers; raises the barge-in bar while a remote human talks', async () => {
    const h = harness();
    await h.audio.connect();
    const e = events(h);
    e.participant('g1', { present: true, muted: false });
    e.participant('g2', { present: true, muted: true });
    expect(h.audio.state.participants).toEqual({ g1: { muted: false }, g2: { muted: true } });
    e.speakers(['me']);
    expect(h.remoteSpeaking.at(-1)).toBe(false);
    e.speakers(['me', 'g1']);
    expect(h.audio.state.speaking).toEqual(['me', 'g1']);
    expect(h.remoteSpeaking.at(-1)).toBe(true);
    e.speakers([]);
    expect(h.remoteSpeaking.at(-1)).toBe(false);
    e.participant('g2', { present: true, muted: false });
    expect(h.audio.state.participants.g2).toEqual({ muted: false });
    e.participant('g1', { present: false, muted: false });
    expect(h.audio.state.participants).toEqual({ g2: { muted: false } });
  });

  it('a mute we did not ask for is the host’s; unmute lifts it through the port', async () => {
    const h = harness();
    await h.audio.connect();
    events(h).localMuted(true);
    expect(h.audio.state.mutedByHost).toBe(true);
    await h.audio.unmute();
    expect(h.ports[0]?.muted).toEqual([false]);
    expect(h.audio.state.mutedByHost).toBe(false);
    events(h).localMuted(false);
    expect(h.audio.state.mutedByHost).toBe(false);
  });

  it('host mute goes through the API: one guest or everyone; failures are reported and rethrown', async () => {
    const h = harness();
    await h.audio.connect();
    expect(await h.audio.muteParticipant('g1')).toEqual(['g1']);
    expect(await h.audio.muteParticipant()).toEqual(['g1', 'g2']);
    expect(h.mutes).toEqual(['g1', undefined]);
    const failing = new RoomAudio({
      token: async () => ({ url: 'ws://lk', token: 't' }),
      mute: async () => {
        throw new Error('502');
      },
      createPort: () => new FakePort(),
      onUpdate: () => undefined,
      onError: (area) => h.errors.push({ area, error: null }),
    });
    await expect(failing.muteParticipant('g1')).rejects.toThrow('502');
    expect(h.errors.at(-1)?.area).toBe('rooms.audio.mute');
  });

  it('a 4xx from the token route means voice is not for this session: stays off, no retry, no error', async () => {
    const h = harness({ tokenError: Object.assign(new Error('nope'), { status: 402 }) });
    await h.audio.connect();
    expect(h.audio.state.status).toBe('off');
    expect(h.ports).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('a network failure minting the token is reported and retried with backoff', async () => {
    const h = harness({ tokenError: Object.assign(new Error('offline'), { status: 0 }) });
    await h.audio.connect();
    expect(h.audio.state.status).toBe('reconnecting');
    expect(h.errors[0]?.area).toBe('rooms.audio.token');
    expect(h.timers.map((t) => t.ms)).toEqual([1_000]);
  });

  it('recovers from an unexpected drop with a new token, republishes the mic, clears stale presence', async () => {
    const h = harness();
    const mic = new FakeTrack();
    await h.audio.attachMicrophone(mic.asTrack());
    await h.audio.connect();
    events(h).participant('g1', { present: true, muted: false });
    events(h).speakers(['g1']);
    events(h).connection('reconnecting');
    expect(h.audio.state.status).toBe('reconnecting');
    events(h).connection('connected');
    expect(h.audio.state.status).toBe('connected');
    // The SDK gave up.
    events(h).connection('disconnected', { reason: 'lost' });
    expect(h.audio.state.participants).toEqual({});
    expect(h.ports[0]?.calls.at(-1)).toBe('disconnect');
    expect(h.audio.state.speaking).toEqual([]);
    expect(h.remoteSpeaking.at(-1)).toBe(false);
    expect(h.audio.state.status).toBe('reconnecting');
    expect(h.timers.map((t) => t.ms)).toEqual([1_000]);
    h.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.ports).toHaveLength(2);
    expect(h.ports[1]?.calls).toEqual(['connect ws://lk t2', 'publish']);
    expect(mic.clones).toHaveLength(2);
    expect(h.audio.state.status).toBe('connected');
    // Events from the dead port are ignored.
    events(h, 0).participant('ghost', { present: true, muted: false });
    expect(h.audio.state.participants).toEqual({});
  });

  it('gives up after the backoff schedule and says so', async () => {
    let port: FakePort;
    const h = harness({
      portFactory: () => {
        port = new FakePort();
        port.connectError = new Error('ECONNREFUSED');
        return port;
      },
    });
    await h.audio.connect();
    const delays: number[] = [];
    while (h.timers.length > 0) {
      delays.push(h.timers[0]?.ms ?? -1);
      h.fire();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(h.audio.state.status).toBe('failed');
    expect(h.errors.at(-1)?.area).toBe('rooms.audio.gave_up');
    expect(h.errors.filter((e) => e.area === 'rooms.audio.connect')).toHaveLength(6);
  });

  it('playback blocked → resumePlayback from a gesture clears it', async () => {
    const h = harness();
    await h.audio.connect();
    events(h).playbackBlocked();
    expect(h.audio.state.playbackBlocked).toBe(true);
    await h.audio.resumePlayback();
    expect(h.ports[0]?.calls.at(-1)).toBe('resumePlayback');
    expect(h.audio.state.playbackBlocked).toBe(false);
  });

  it('disconnect tears everything down, cancels pending reconnects and ignores late events', async () => {
    const h = harness();
    const mic = new FakeTrack();
    await h.audio.attachMicrophone(mic.asTrack());
    await h.audio.connect();
    events(h).connection('disconnected', { reason: 'lost' });
    expect(h.timers).toHaveLength(1);
    await h.audio.disconnect();
    expect(h.timers).toHaveLength(0);
    expect(h.audio.state.status).toBe('off');
    await h.audio.connect();
    expect(h.ports).toHaveLength(1);
    // A leave we initiated never triggers a reconnect.
    const h2 = harness();
    await h2.audio.connect();
    const e = events(h2);
    await h2.audio.disconnect();
    expect(h2.ports[0]?.calls.at(-1)).toBe('disconnect');
    e.connection('disconnected', { reason: 'leave' });
    expect(h2.timers).toHaveLength(0);
    expect(h2.audio.state.status).toBe('off');
  });

  it('a server-side removal (room deleted, duplicate identity) ends voice without a reconnect', async () => {
    const h = harness();
    await h.audio.connect();
    events(h).connection('disconnected', { reason: 'server' });
    expect(h.timers).toHaveLength(0);
    expect(h.audio.state.status).toBe('off');
    expect(h.ports[0]?.calls.at(-1)).toBe('disconnect');
  });
});

/**
 * The microphone that stays on.
 *
 * `publishIfReady` sets `published = true` before awaiting `port.publish()`,
 * which is right — it is what stops a second caller publishing a second
 * clone — and on its own it was a hot mic. Publishing is a renegotiation and
 * takes real time; a learner who turns the mic off inside that window runs
 * `detachMicrophone`, which sees `published === true`, sets it false and
 * unpublishes nothing, because nothing is there yet. The publish then lands:
 * a live clone in the room, `published === false` beside it, and nothing
 * that will ever take it down. The UI says the microphone is off. It is not.
 */
describe('a microphone turned off while it is still being published', () => {
  /** A port whose `publish` does not finish until the test lets it. */
  class SlowPort extends FakePort {
    release: (() => void) | null = null;
    override async publish(track: MediaStreamTrack): Promise<void> {
      this.calls.push('publish');
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      this.published.push(track as unknown as FakeTrack);
    }
  }

  it('does not leave a live clone in the room', async () => {
    const slow = new SlowPort();
    const h = harness({ portFactory: () => slow });
    await h.audio.connect();
    const mic = new FakeTrack();

    const publishing = h.audio.attachMicrophone(mic.asTrack());
    await Promise.resolve();
    expect(slow.calls).toContain('publish');

    // The learner turns it off, mid-renegotiation.
    await h.audio.detachMicrophone();
    slow.release?.();
    await publishing;

    const clone = mic.clones[0];
    expect(clone, 'a clone was made').toBeDefined();
    expect(clone?.stopped, 'and it is not still running').toBe(true);
    // Undone at the port too, not merely in this object's bookkeeping.
    expect(slow.calls.filter((c) => c === 'unpublish').length).toBeGreaterThan(0);
  });

  it('keeps the clone when nothing superseded it', async () => {
    const slow = new SlowPort();
    const h = harness({ portFactory: () => slow });
    await h.audio.connect();
    const mic = new FakeTrack();

    const publishing = h.audio.attachMicrophone(mic.asTrack());
    await Promise.resolve();
    slow.release?.();
    await publishing;

    expect(mic.clones[0]?.stopped, 'the ordinary path keeps the microphone').toBe(false);
    expect(slow.calls).not.toContain('unpublish');
  });

  it('stops the clone when the publish itself fails, rather than leaking the grant', async () => {
    class FailingPort extends FakePort {
      override async publish(): Promise<void> {
        this.calls.push('publish');
        throw new Error('renegotiation failed');
      }
    }
    const port = new FailingPort();
    const h = harness({ portFactory: () => port });
    await h.audio.connect();
    const mic = new FakeTrack();
    await h.audio.attachMicrophone(mic.asTrack());

    expect(mic.clones[0]?.stopped).toBe(true);
    expect(h.errors.map((e) => e.area)).toContain('rooms.audio.publish');
  });
});
