import { describe, expect, it } from 'vitest';
import {
  AdaptiveJitterBuffer,
  ChunkValidator,
  decodePcmS16le,
  MAX_CHUNK_PCM_BYTES,
  PcmPlayer,
  type PlaybackChunk,
  type PlaybackErrorCode,
  type PlaybackSampleRate,
  type PlayerAudioContext,
  type PlayerBufferSource,
  queueCanAccept,
  SayTimeline,
  validateChunkShape,
} from '../src/client/player.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function chunk(
  sayId: string,
  audioChunkId: number,
  audioClockMs: number,
  durationMs: number,
  final = false,
  sampleRate: PlaybackSampleRate = 44100,
  overrides: Partial<PlaybackChunk> = {},
): PlaybackChunk {
  const samples = Math.round((sampleRate * durationMs) / 1_000);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(8_000 * Math.sin(index / 10)), true);
  }
  return { sayId, audioChunkId, audioClockMs, sampleRate, durationMs, pcm, final, ...overrides };
}

interface FakeSource extends PlayerBufferSource {
  startedAt: number | undefined;
  stopped: boolean;
}

interface FakeContext extends PlayerAudioContext {
  currentTime: number;
  state: PlayerAudioContext['state'];
  readonly sources: FakeSource[];
  readonly calls: string[];
  advance(seconds: number): void;
}

function fakeContext(
  sampleRate: number,
  initialState: FakeContext['state'] = 'running',
): FakeContext {
  const context: FakeContext = {
    currentTime: 0,
    sampleRate,
    state: initialState,
    destination: { disconnect: () => undefined },
    sources: [],
    calls: [],
    advance(seconds) {
      if (context.state === 'running') context.currentTime += seconds;
    },
    createGain() {
      const gain = {
        value: 1,
        cancelScheduledValues: () => undefined,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: (value: number) => {
          gain.value = value;
        },
      };
      return { gain, connect: () => undefined, disconnect: () => undefined };
    },
    createBuffer(_channels, length, rate) {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
    },
    createBufferSource() {
      const source: FakeSource = {
        buffer: null,
        startedAt: undefined,
        stopped: false,
        connect: () => undefined,
        disconnect: () => undefined,
        start: (when) => {
          source.startedAt = when;
        },
        stop: () => {
          source.stopped = true;
        },
        addEventListener: () => undefined,
      };
      context.sources.push(source);
      return source;
    },
    resume: async () => {
      context.calls.push('resume');
      context.state = 'running';
    },
    suspend: async () => {
      context.calls.push('suspend');
      context.state = 'suspended';
    },
    close: async () => {
      context.calls.push('close');
      context.state = 'closed';
    },
  };
  return context;
}

interface Harness {
  readonly player: PcmPlayer;
  readonly context: () => FakeContext;
  readonly errors: { code: PlaybackErrorCode; detail: string }[];
  readonly events: string[];
  /** Run the progress ticker once. */
  readonly tick: () => void;
  /** Fire every pending timeout. */
  readonly flushTimers: () => void;
}

function harness(
  options: { initialState?: FakeContext['state']; sampleRate?: number } = {},
): Harness {
  let context: FakeContext | undefined;
  let tickCallback: (() => void) | undefined;
  const timeouts: (() => void)[] = [];
  const errors: Harness['errors'] = [];
  const events: string[] = [];
  const player = new PcmPlayer({
    onError: (code, detail) => {
      errors.push({ code, detail });
    },
    onSayStart: (sayId) => {
      events.push(`start:${sayId}`);
    },
    onSayEnd: (sayId, durationMs) => {
      events.push(`end:${sayId}:${durationMs}`);
    },
    onUnderrun: () => {
      events.push('underrun');
    },
    onProgress: (sayId, offsetMs) => {
      events.push(`progress:${sayId}:${offsetMs}`);
    },
    createAudioContext: (rate) => {
      context = fakeContext(options.sampleRate ?? rate, options.initialState);
      return context;
    },
    setInterval: (callback) => {
      tickCallback = callback;
      return 'interval';
    },
    clearInterval: () => {
      tickCallback = undefined;
    },
    setTimeout: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeout: (handle) => {
      const index = (handle as number) - 1;
      timeouts[index] = () => undefined;
    },
  });
  return {
    player,
    errors,
    events,
    context: () => {
      if (context === undefined) throw new Error('context not created yet');
      return context;
    },
    tick: () => tickCallback?.(),
    flushTimers: () => {
      const pending = timeouts.splice(0);
      for (const callback of pending) callback();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

describe('validateChunkShape', () => {
  it('accepts a well-formed chunk', () => {
    expect(validateChunkShape(chunk('s1', 0, 0, 120)).ok).toBe(true);
  });

  it('rejects durations more than 2 ms away from the byte-derived truth', () => {
    const bad = chunk('s1', 0, 0, 120, false, 44100, { durationMs: 125 });
    const verdict = validateChunkShape(bad);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('PEN_PLAYBACK_DURATION_MISMATCH');
    // 1 ms off is within tolerance.
    expect(validateChunkShape(chunk('s1', 0, 0, 120, false, 44100, { durationMs: 121 })).ok).toBe(
      true,
    );
  });

  it('rejects malformed PCM and unsupported rates', () => {
    const odd = chunk('s1', 0, 0, 120, false, 44100, { pcm: new Uint8Array(3) });
    const oddVerdict = validateChunkShape(odd);
    expect(oddVerdict.ok === false && oddVerdict.code).toBe('PEN_PLAYBACK_PCM_REJECTED');
    const huge = chunk('s1', 0, 0, 120, false, 44100, {
      pcm: new Uint8Array(MAX_CHUNK_PCM_BYTES + 2),
    });
    const hugeVerdict = validateChunkShape(huge);
    expect(hugeVerdict.ok === false && hugeVerdict.code).toBe('PEN_PLAYBACK_PCM_REJECTED');
    const rate = validateChunkShape({ ...chunk('s1', 0, 0, 120), sampleRate: 22050 });
    expect(rate.ok === false && rate.code).toBe('PEN_PLAYBACK_SAMPLE_RATE_REJECTED');
    const shape = validateChunkShape({ ...chunk('s1', 0, 0, 120), final: 'yes' });
    expect(shape.ok === false && shape.code).toBe('PEN_PLAYBACK_CHUNK_REJECTED');
    expect(validateChunkShape(null).ok).toBe(false);
  });
});

describe('ChunkValidator', () => {
  it('enforces a contiguous clock, increasing ids, and nothing after final', () => {
    const validator = new ChunkValidator();
    const first = validator.accept(chunk('s1', 0, 0, 120));
    expect(first.ok && first.firstOfSay).toBe(true);
    const second = validator.accept(chunk('s1', 1, 120, 120));
    expect(second.ok && !second.firstOfSay).toBe(true);
    const hole = validator.accept(chunk('s1', 2, 300, 120));
    expect(hole.ok === false && hole.code).toBe('PEN_PLAYBACK_CLOCK_DISCONTINUITY');
    const duplicate = validator.accept(chunk('s1', 1, 240, 120));
    expect(duplicate.ok === false && duplicate.code).toBe('PEN_PLAYBACK_CHUNK_ID_REJECTED');
    expect(validator.accept(chunk('s1', 2, 240, 120, true)).ok).toBe(true);
    const late = validator.accept(chunk('s1', 3, 360, 120));
    expect(late.ok === false && late.code).toBe('PEN_PLAYBACK_SAY_STALE');
  });

  it('pins the sample rate to the first chunk', () => {
    const validator = new ChunkValidator();
    expect(validator.accept(chunk('s1', 0, 0, 120, false, 44100)).ok).toBe(true);
    const other = validator.accept(chunk('s2', 0, 0, 120, false, 48000));
    expect(other.ok === false && other.code).toBe('PEN_PLAYBACK_SAMPLE_RATE_REJECTED');
  });

  it('lets a say resume mid-way (first chunk adopts its clock) and interleaves says', () => {
    const validator = new ChunkValidator();
    expect(validator.accept(chunk('s1', 5, 600, 120)).ok).toBe(true);
    expect(validator.accept(chunk('s2', 0, 0, 120)).ok).toBe(true);
    expect(validator.accept(chunk('s1', 6, 720, 120)).ok).toBe(true);
    expect(validator.accept(chunk('s2', 1, 120, 120)).ok).toBe(true);
  });
});

describe('AdaptiveJitterBuffer', () => {
  it('starts once the bank reaches the target and stays active', () => {
    const jitter = new AdaptiveJitterBuffer({ initialTargetMs: 200 });
    expect(jitter.observeArrival(0, 120, 0, 120).playbackActive).toBe(false);
    expect(jitter.observeArrival(30, 120, 0, 240).playbackActive).toBe(true);
    expect(jitter.observeArrival(60, 120, 300, 120).playbackActive).toBe(true);
  });

  it('does not inflate the target for faster-than-realtime arrivals', () => {
    const jitter = new AdaptiveJitterBuffer();
    const initial = jitter.targetMs;
    let now = 0;
    for (let index = 0; index < 50; index += 1) {
      jitter.observeArrival(now, 120, 500, 120);
      now += 27; // 4.5× realtime
    }
    expect(jitter.targetMs).toBeLessThanOrEqual(initial);
  });

  it('bumps the target on underrun and grows it for late arrivals', () => {
    const jitter = new AdaptiveJitterBuffer({ initialTargetMs: 120, underrunBumpMs: 240 });
    jitter.observeArrival(0, 120, 0, 120);
    expect(jitter.playbackActive).toBe(true);
    const decision = jitter.observeArrival(900, 120, 0, 120);
    expect(decision.underrun).toBe(true);
    expect(decision.targetMs).toBeGreaterThanOrEqual(120 + 240);
    expect(decision.playbackActive).toBe(false);
    let now = 900;
    for (let index = 0; index < 100; index += 1) {
      now += 500; // chunks 380 ms late every time
      jitter.observeArrival(now, 120, 0, 120);
    }
    expect(jitter.targetMs).toBeGreaterThan(400);
  });

  it('keeps the learned target across reset()', () => {
    const jitter = new AdaptiveJitterBuffer({ initialTargetMs: 120 });
    jitter.observeArrival(0, 120, 0, 120);
    jitter.observeArrival(900, 120, 0, 120);
    const learned = jitter.targetMs;
    jitter.reset();
    expect(jitter.targetMs).toBe(learned);
    expect(jitter.playbackActive).toBe(false);
  });
});

describe('decodePcmS16le', () => {
  it('decodes aligned and unaligned little-endian s16', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x00]);
    const aligned = decodePcmS16le(bytes.subarray(0, 6));
    expect(Array.from(aligned)).toEqual([0, 32_767 / 32_768, -1]);
    const unaligned = decodePcmS16le(new Uint8Array([0xaa, ...bytes]).subarray(1, 7));
    expect(Array.from(unaligned)).toEqual(Array.from(aligned));
    expect(() => decodePcmS16le(new Uint8Array(3))).toThrow('PEN_PLAYBACK_PCM_REJECTED');
  });
});

describe('queueCanAccept', () => {
  it('bounds the bank at 30 s plus one chunk', () => {
    expect(queueCanAccept(0, 0.12)).toBe(true);
    expect(queueCanAccept(29.9, 0.12)).toBe(true);
    expect(queueCanAccept(30.1, 0.12)).toBe(false);
    expect(queueCanAccept(1, 5)).toBe(false);
    expect(queueCanAccept(Number.NaN, 0.1)).toBe(false);
  });
});

describe('SayTimeline', () => {
  it('maps the context clock to say and offset across contiguous runs', () => {
    const timeline = new SayTimeline(1_000);
    timeline.addSaySamples('s1', 500, true, 0);
    timeline.addRun(1, 500);
    timeline.addSaySamples('s2', 300, false, 0);
    timeline.addRun(1.5, 300);
    expect(timeline.clockAt(0.5)).toEqual({ sayId: null, offsetMs: 0 });
    expect(timeline.clockAt(1.25)).toEqual({ sayId: 's1', offsetMs: 250 });
    expect(timeline.clockAt(1.6)).toEqual({ sayId: 's2', offsetMs: 100 });
    expect(timeline.hasOpenSay).toBe(true);
    // Open say: the clock holds at the scheduled end during a gap.
    expect(timeline.clockAt(5)).toEqual({ sayId: 's2', offsetMs: 300 });
    expect(timeline.isDrained(5)).toBe(false);
  });

  it('dispatches start and end events exactly once, in order', () => {
    const timeline = new SayTimeline(1_000);
    const events: string[] = [];
    const handlers = {
      onSayStart: (id: string) => {
        events.push(`start:${id}`);
      },
      onSayEnd: (id: string, ms: number) => {
        events.push(`end:${id}:${ms}`);
      },
    };
    timeline.addSaySamples('s1', 500, true, 0);
    timeline.addSaySamples('s2', 200, true, 500);
    timeline.addRun(1, 700);
    timeline.dispatch(0.5, handlers);
    expect(events).toEqual([]);
    timeline.dispatch(1.2, handlers);
    expect(events).toEqual(['start:s1']);
    timeline.dispatch(1.55, handlers);
    expect(events).toEqual(['start:s1', 'end:s1:500', 'start:s2']);
    timeline.dispatch(2, handlers);
    expect(events).toEqual(['start:s1', 'end:s1:500', 'start:s2', 'end:s2:200']);
    expect(timeline.isDrained(2)).toBe(true);
    expect(timeline.isEmpty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PcmPlayer with a fake AudioContext
// ---------------------------------------------------------------------------

describe('PcmPlayer', () => {
  it('creates the context at the first chunk rate and rejects other rates', () => {
    const h = harness();
    expect(h.player.enqueue(chunk('s1', 0, 0, 120)).accepted).toBe(true);
    expect(h.context().sampleRate).toBe(44100);
    const result = h.player.enqueue(chunk('s2', 0, 0, 120, false, 48000));
    expect(result.accepted).toBe(false);
    expect(h.errors.map((e) => e.code)).toEqual(['PEN_PLAYBACK_SAMPLE_RATE_REJECTED']);
  });

  it('reports every validation rejection through onError with a PEN_PLAYBACK_* code', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120));
    // A rejected chunk leaves the say's state untouched: the clock still
    // expects 120 ms and the last accepted id is still 0.
    h.player.enqueue(chunk('s1', 1, 500, 120));
    h.player.enqueue(chunk('s1', 0, 120, 120));
    h.player.enqueue(chunk('s1', 1, 120, 120, false, 44100, { durationMs: 130 }));
    expect(h.errors.map((e) => e.code)).toEqual([
      'PEN_PLAYBACK_CLOCK_DISCONTINUITY',
      'PEN_PLAYBACK_CHUNK_ID_REJECTED',
      'PEN_PLAYBACK_DURATION_MISMATCH',
    ]);
    for (const error of h.errors) expect(error.detail.length).toBeGreaterThan(0);
  });

  it('plays a say sample-exactly: start, progress, clock and end from the media clock', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120));
    h.player.enqueue(chunk('s1', 1, 120, 120));
    h.player.enqueue(chunk('s1', 2, 240, 120, true));
    const context = h.context();
    // The first flush was scheduled 30 ms ahead; later chunks butt against it.
    const first = context.sources[0];
    expect(first?.startedAt).toBeCloseTo(0.03, 6);
    expect(h.player.clock).toEqual({ sayId: null, offsetMs: 0 });
    context.advance(0.03 + 0.1);
    h.tick();
    expect(h.player.clock).toEqual({ sayId: 's1', offsetMs: 100 });
    expect(h.events).toEqual(['start:s1', 'progress:s1:100']);
    expect(h.player.speaking).toBe(true);
    context.advance(0.3);
    h.tick();
    expect(h.events).toContain('end:s1:360');
    expect(h.player.clock).toEqual({ sayId: null, offsetMs: 0 });
    expect(h.player.speaking).toBe(false);
    expect(h.player.bufferedMs).toBe(0);
  });

  it('plays consecutive says back to back with per-say boundaries', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120, true));
    h.player.enqueue(chunk('s2', 0, 0, 120));
    h.player.enqueue(chunk('s2', 1, 120, 120, true));
    const context = h.context();
    context.advance(0.03 + 0.06);
    h.tick();
    expect(h.player.clock).toEqual({ sayId: 's1', offsetMs: 60 });
    context.advance(0.12);
    h.tick();
    expect(h.player.clock).toEqual({ sayId: 's2', offsetMs: 60 });
    expect(h.events.filter((e) => !e.startsWith('progress'))).toEqual([
      'start:s1',
      'end:s1:120',
      'start:s2',
    ]);
    // Scheduled ahead is measured against the shared timeline.
    expect(h.player.bufferedMs).toBeCloseTo(180, 0);
  });

  it('applies startup buffering for a non-final first chunk under a higher target', () => {
    let context: FakeContext | undefined;
    const player = new PcmPlayer({
      onError: () => undefined,
      jitter: { initialTargetMs: 300 },
      createAudioContext: (rate) => {
        context = fakeContext(rate);
        return context;
      },
      setInterval: () => 'i',
      clearInterval: () => undefined,
    });
    player.enqueue(chunk('s1', 0, 0, 120));
    expect(context?.sources).toHaveLength(0);
    player.enqueue(chunk('s1', 1, 120, 120));
    expect(context?.sources).toHaveLength(0);
    player.enqueue(chunk('s1', 2, 240, 120));
    expect(context?.sources).toHaveLength(1);
    expect(player.bufferedMs).toBeCloseTo(390, 0);
  });

  it('forces playback when a final chunk arrives below the startup target', () => {
    let context: FakeContext | undefined;
    const player = new PcmPlayer({
      onError: () => undefined,
      jitter: { initialTargetMs: 1_000 },
      createAudioContext: (rate) => {
        context = fakeContext(rate);
        return context;
      },
      setInterval: () => 'i',
      clearInterval: () => undefined,
    });
    player.enqueue(chunk('s1', 0, 0, 120, true));
    expect(context?.sources).toHaveLength(1);
  });

  it('reports an underrun once when playback runs dry with a say still open', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120));
    const context = h.context();
    context.advance(0.03 + 0.2);
    h.tick();
    h.tick();
    expect(h.events.filter((e) => e === 'underrun')).toHaveLength(1);
    // The late chunk restarts with a fresh anchor (a gap, not a butt-join).
    h.player.enqueue(chunk('s1', 1, 120, 120, true));
    const second = context.sources[1];
    expect(second?.startedAt).toBeCloseTo(context.currentTime + 0.03, 6);
  });

  it('cancel() fades, discards everything, returns the interrupted position', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120));
    h.player.enqueue(chunk('s1', 1, 120, 120));
    const context = h.context();
    context.advance(0.03 + 0.05);
    const snapshot = h.player.cancel();
    expect(snapshot).toEqual({ sayId: 's1', offsetMs: 50 });
    expect(h.player.clock).toEqual({ sayId: null, offsetMs: 0 });
    expect(h.player.bufferedMs).toBe(0);
    // Sources are released after the 20 ms fade.
    expect(context.sources.every((s) => !s.stopped)).toBe(true);
    h.flushTimers();
    expect(context.sources.every((s) => s.stopped)).toBe(true);
    // No onSayEnd for a cancelled say; a stale chunk for it is rejected.
    expect(h.events.some((e) => e.startsWith('end:'))).toBe(false);
    h.player.enqueue(chunk('s1', 2, 240, 120));
    expect(h.errors.at(-1)?.code).toBe('PEN_PLAYBACK_SAY_STALE');
    // A new say plays normally afterwards.
    expect(h.player.enqueue(chunk('s2', 0, 0, 120, true)).accepted).toBe(true);
  });

  it('pause() freezes the clock via suspend and resume() continues from the same sample', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120));
    h.player.enqueue(chunk('s1', 1, 120, 120, true));
    const context = h.context();
    context.advance(0.03 + 0.07);
    h.player.pause();
    expect(h.player.paused).toBe(true);
    h.flushTimers();
    expect(context.calls).toContain('suspend');
    expect(context.state).toBe('suspended');
    context.advance(1);
    expect(h.player.clock).toEqual({ sayId: 's1', offsetMs: 70 });
    // Chunks keep banking while paused.
    expect(h.player.enqueue(chunk('s2', 0, 0, 120, true)).accepted).toBe(true);
    h.player.resume();
    expect(h.player.paused).toBe(false);
    return Promise.resolve().then(() => {
      expect(context.state).toBe('running');
      context.advance(0.05);
      expect(h.player.clock).toEqual({ sayId: 's1', offsetMs: 120 });
    });
  });

  it('rejects chunks beyond the 30 s bank and reports the bound', () => {
    const h = harness();
    let clockMs = 0;
    let id = 0;
    let rejected: PlaybackErrorCode | undefined;
    while (rejected === undefined && id < 400) {
      const result = h.player.enqueue(chunk('s1', id, clockMs, 120));
      if (!result.accepted) rejected = result.code;
      clockMs += 120;
      id += 1;
    }
    expect(rejected).toBe('PEN_PLAYBACK_QUEUE_BOUND_REJECTED');
    expect(h.player.bufferedMs).toBeGreaterThan(29_000);
    expect(h.player.canAccept(120)).toBe(false);
  });

  it('reports a context that stays suspended (autoplay policy) exactly once', async () => {
    const h = harness({ initialState: 'suspended' });
    // This fake keeps refusing to run.
    const player = new PcmPlayer({
      onError: (code, detail) => {
        h.errors.push({ code, detail });
      },
      createAudioContext: (rate) => {
        const context = fakeContext(rate, 'suspended');
        context.resume = async () => undefined;
        return context;
      },
      setInterval: () => 'i',
      clearInterval: () => undefined,
    });
    player.enqueue(chunk('s1', 0, 0, 120));
    player.enqueue(chunk('s1', 1, 120, 120));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors.filter((e) => e.code === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED')).toHaveLength(
      1,
    );
  });

  it('setVolume clamps and applies to the master gain; dispose closes the context', () => {
    const h = harness();
    h.player.enqueue(chunk('s1', 0, 0, 120, true));
    h.player.setVolume(1.7);
    expect(h.player.volume).toBe(1);
    h.player.setVolume(0.25);
    expect(h.player.volume).toBe(0.25);
    h.player.dispose();
    expect(h.context().calls).toContain('close');
    const after = h.player.enqueue(chunk('s2', 0, 0, 120, true));
    expect(after.accepted).toBe(false);
    expect(h.errors.at(-1)?.code).toBe('PEN_PLAYBACK_AUDIO_CONTEXT_FAILED');
  });
});

describe('PcmPlayer: a device that cannot make an audio context', () => {
  /**
   * A browser that refuses to build a context refuses again immediately, and
   * chunks arrive by the dozen. Before this was held, one broken device asked
   * fifty-six times in a single lesson and reported every one of them: a retry
   * loop behind silence, and a Sentry issue per chunk.
   */
  it('asks once, says so once, and tries again only when the learner taps', async () => {
    const errors: string[] = [];
    let attempts = 0;
    let refuse = true;
    const player = new PcmPlayer({
      onError: (code) => {
        errors.push(code);
      },
      onSayStart: () => undefined,
      onSayEnd: () => undefined,
      onUnderrun: () => undefined,
      onProgress: () => undefined,
      createAudioContext: (rate) => {
        attempts += 1;
        if (refuse) throw new Error('no audio device');
        return fakeContext(rate);
      },
    });

    for (let i = 0; i < 20; i++) player.enqueue(chunk('s1', i, i * 120, 120, i === 19));
    expect(attempts, 'one attempt, not one per chunk').toBe(1);
    expect(errors).toEqual(['PEN_PLAYBACK_AUDIO_CONTEXT_FAILED']);

    // The learner taps "Tap to hear …": that is a fair reason to try again,
    // and when the device has come back the sound simply works.
    refuse = false;
    await player.prime();
    expect(attempts).toBe(2);
    expect(errors).toEqual(['PEN_PLAYBACK_AUDIO_CONTEXT_FAILED']);
    player.dispose();
  });
});

describe('PcmPlayer: the tap that turns the sound on', () => {
  /**
   * The room's "Tap to hear …" control calls `prime()` from a real user
   * gesture. This is the proof that the tap is what makes audio audible: the
   * context is suspended by autoplay policy, reports itself once, and is
   * running after the tap — with no further complaint.
   */
  it('a suspended context starts running after prime(), and stops reporting itself', async () => {
    const errors: string[] = [];
    /** Autoplay policy: resume() only takes effect once a gesture has happened. */
    let gestured = false;
    let context: ReturnType<typeof fakeContext> | undefined;
    const player = new PcmPlayer({
      onError: (code) => errors.push(code),
      createAudioContext: (rate) => {
        const ctx = fakeContext(rate, 'suspended');
        ctx.resume = async () => {
          if (gestured) ctx.state = 'running';
        };
        context = ctx;
        return ctx;
      },
      setInterval: () => 'i',
      clearInterval: () => undefined,
    });

    player.enqueue(chunk('s1', 0, 0, 120));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.filter((c) => c === 'PEN_PLAYBACK_AUDIO_CONTEXT_SUSPENDED')).toHaveLength(1);
    expect(context?.state).toBe('suspended');

    // The learner taps the pill.
    const before = errors.length;
    gestured = true;
    await player.prime(44100);
    expect(context?.state).toBe('running');
    // Nothing new to say: the learner fixed it.
    expect(errors).toHaveLength(before);
    player.dispose();
  });
});

describe('PcmPlayer: a disposed player says nothing', () => {
  it('does not report a closed context as an autoplay block', async () => {
    const errors: string[] = [];
    const player = new PcmPlayer({
      onError: (code) => errors.push(code),
      createAudioContext: (rate) => fakeContext(rate, 'suspended'),
      setInterval: () => 'i',
      clearInterval: () => undefined,
    });
    // React StrictMode: the first instance is torn down while prime() is in flight.
    const primed = player.prime(44100);
    player.dispose();
    await primed;
    expect(errors).toHaveLength(0);
  });
});
