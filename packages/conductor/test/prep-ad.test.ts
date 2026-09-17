import type { BoardEvent, ClientMessage, Cue, RoomState } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { Conductor } from '../src/conductor.js';
import type {
  AudioPort,
  BoardExecution,
  BoardPort,
  CaptionPort,
  PresencePort,
  TransportPort,
} from '../src/ports.js';

class FakeAudio implements AudioPort {
  paused = 0;
  resumed = 0;
  cancelled = 0;
  clock = { sayId: null as string | null, offsetMs: 0 };
  enqueue() {}
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  cancel() {
    this.cancelled++;
    return { ...this.clock };
  }
}
class FakeExec implements BoardExecution {
  done = new Promise<void>(() => undefined);
  paused = 0;
  resumed = 0;
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  finish() {}
  cancel() {}
}
class FakeBoard implements BoardPort {
  execs: FakeExec[] = [];
  execute(_op: BoardEvent) {
    const exec = new FakeExec();
    this.execs.push(exec);
    return exec;
  }
  pinNote() {}
  setDimmed() {}
  clear() {}
}
class FakeCaptions implements CaptionPort {
  showExpert() {}
  showLearner() {}
  hint() {}
  clear() {}
}
class FakePresence implements PresencePort {
  ads: Array<{ adId: string; durationMs: number; skippableAfterMs: number } | null> = [];
  states: RoomState[] = [];
  setState(s: RoomState) {
    this.states.push(s);
  }
  setSpeaking() {}
  showCheck() {}
  showAd(a: { adId: string; durationMs: number; skippableAfterMs: number } | null) {
    this.ads.push(a);
  }
  notice() {}
}
class FakeTransport implements TransportPort {
  sent: ClientMessage[] = [];
  send(m: ClientMessage) {
    this.sent.push(m);
  }
}

const HOST = 'host-1';
function state(
  phase: RoomState['phase'],
  mode: RoomState['mode'] = 'teaching',
  extra: Partial<RoomState> = {},
): RoomState {
  return {
    sessionId: 's',
    topic: 't',
    language: 'en',
    expertId: 'ada',
    phase,
    mode,
    floor: null,
    hostId: HOST,
    participants: [{ id: HOST, name: 'Sam', role: 'host', hue: 1, micOn: false, joinedAt: 0 }],
    plan: null,
    segment: 0,
    clockMs: 0,
    pace: 1,
    preparation:
      phase === 'preparing'
        ? {
            stage: 'fetching',
            fraction: 0.3,
            status: 'Reading sources…',
            sourcesFound: 3,
            sourcesFetched: 1,
          }
        : null,
    evidenceTier: 'reviewed_pack_source',
    startedAt: 0,
    recap: null,
    resume: null,
    ...extra,
  };
}
const say = (seq: number, id: string, text: string): Cue => ({
  seq,
  segment: 0,
  thread: 'lesson',
  at: 0,
  event: { type: 'say', id, text, tone: 'warm' },
});
const PREP_AD = {
  kind: 'ad' as const,
  adId: 'ad-s-prep',
  afterSeq: -1,
  skippableAfterMs: 5000,
  durationMs: 15000,
};

function setup() {
  const audio = new FakeAudio();
  const board = new FakeBoard();
  const presence = new FakePresence();
  const transport = new FakeTransport();
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const c = new Conductor({
    audio,
    board,
    captions: new FakeCaptions(),
    presence,
    transport,
    participantId: HOST,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  // The host joined while the room was still preparing (topic miss).
  c.handleServer({ kind: 'ready', participantId: HOST, state: state('preparing'), backlog: [] });
  return { c, audio, board, presence, transport, timers };
}

describe('Conductor preparation ad (afterSeq -1)', () => {
  it('starts immediately: phase ad, presence.showAd, audio held, a duration timer armed', () => {
    const { c, audio, presence, timers } = setup();
    expect(c.getPhase()).toBe('playing');
    c.handleServer(PREP_AD);
    expect(c.getPhase()).toBe('ad');
    expect(presence.ads).toEqual([
      { adId: 'ad-s-prep', durationMs: 15000, skippableAfterMs: 5000 },
    ]);
    expect(audio.paused).toBe(1);
    expect(timers.at(-1)?.ms).toBe(15000);
  });

  it('stays in the ad while preparation progress keeps arriving', () => {
    const { c, presence } = setup();
    c.handleServer(PREP_AD);
    c.handleServer({
      kind: 'prep',
      progress: {
        stage: 'compiling',
        fraction: 0.7,
        status: 'Compiling…',
        sourcesFound: 4,
        sourcesFetched: 4,
      },
    });
    c.handleServer({ kind: 'state', state: state('preparing') });
    expect(c.getPhase()).toBe('ad');
    expect(presence.ads).toHaveLength(1);
  });

  it('ends when the room goes live: showAd(null), phase playing, audio resumed, timer cleared', () => {
    const { c, audio, presence, timers } = setup();
    c.handleServer(PREP_AD);
    c.handleServer({ kind: 'state', state: state('live') });
    expect(presence.ads.at(-1)).toBeNull();
    expect(c.getPhase()).toBe('playing');
    expect(audio.resumed).toBe(1);
    expect(timers.at(-1)?.cleared).toBe(true);
    // The card is consumed: nothing lingers to fire when the first sentence ends.
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'Hello.') });
    c.audioEvents.onSayStart('L0.s1@0');
    c.audioEvents.onSayEnd('L0.s1@0', 800);
    expect(c.getPhase()).toBe('playing');
    expect(presence.ads).toHaveLength(2);
  });

  it('skipAd() while still preparing ends the card and returns to idle until the room is live', () => {
    const { c, audio, presence } = setup();
    c.handleServer(PREP_AD);
    c.skipAd();
    expect(presence.ads.at(-1)).toBeNull();
    expect(c.getPhase()).toBe('idle');
    expect(audio.resumed).toBe(0);
    // A second skip is a no-op; the live state then puts the conductor into playing.
    c.skipAd();
    expect(presence.ads).toHaveLength(2);
    c.handleServer({ kind: 'state', state: state('live') });
    expect(c.getPhase()).toBe('playing');
    expect(presence.ads).toHaveLength(2);
  });

  it('skipAd() after the room went live during the card resumes playback', () => {
    const { c, audio } = setup();
    c.handleServer(PREP_AD);
    // A live state ends the card by itself; a skip that races it is harmless.
    c.handleServer({ kind: 'state', state: state('live') });
    c.skipAd();
    expect(c.getPhase()).toBe('playing');
    expect(audio.resumed).toBe(1);
  });

  it('the duration timer ends the card like a skip', () => {
    const { c, presence, timers } = setup();
    c.handleServer(PREP_AD);
    const timer = timers.at(-1);
    if (!timer) throw new Error('no timer');
    timer.fn();
    expect(presence.ads.at(-1)).toBeNull();
    expect(c.getPhase()).toBe('idle');
    c.handleServer({ kind: 'state', state: state('live') });
    expect(c.getPhase()).toBe('playing');
  });

  it('a boundary ad (afterSeq >= 0) is not started immediately even while preparing', () => {
    const { c, presence } = setup();
    c.handleServer({ ...PREP_AD, adId: 'ad-s-1', afterSeq: 3 });
    expect(c.getPhase()).toBe('playing');
    expect(presence.ads).toEqual([]);
  });

  it('pauses frozen board work during the card and resumes it when the room goes live', () => {
    const { c, board } = setup();
    c.handleServer({
      kind: 'cue',
      cue: {
        seq: 0,
        segment: 0,
        thread: 'lesson',
        at: 0,
        event: {
          type: 'board',
          id: 'L0.b1',
          anchor: 'now',
          op: 'title',
          text: 'Title',
          lang: '',
          ref: '',
          ref2: '',
          place: 'newline',
          emphasis: 'accent',
        },
      },
    });
    c.handleServer(PREP_AD);
    expect(board.execs[0]?.paused).toBe(1);
    c.handleServer({ kind: 'state', state: state('live') });
    expect(board.execs[0]?.resumed).toBe(1);
  });
});
