import type {
  BoardEvent,
  ClientMessage,
  Cue,
  DownstreamAudioHeader,
  RoomState,
} from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { Conductor, WAITING_AFTER_MS } from '../src/conductor.js';
import type {
  AudioPort,
  BoardExecution,
  BoardPort,
  CaptionPort,
  PresencePort,
  TransportPort,
} from '../src/ports.js';

class FakeAudio implements AudioPort {
  enqueued: string[] = [];
  paused = false;
  cancelled = 0;
  clock = { sayId: null as string | null, offsetMs: 0 };
  enqueue(chunk: { sayId: string }) {
    this.enqueued.push(chunk.sayId);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  cancel() {
    this.cancelled++;
    const c = { ...this.clock };
    this.clock = { sayId: null, offsetMs: 0 };
    return c;
  }
}
class FakeExec implements BoardExecution {
  resolve!: () => void;
  done = new Promise<void>((r) => {
    this.resolve = r;
  });
  paused = 0;
  resumed = 0;
  finished = 0;
  cancelled = 0;
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
  finish() {
    this.finished++;
    this.resolve();
  }
  cancel() {
    this.cancelled++;
    this.resolve();
  }
}
class FakeBoard implements BoardPort {
  executed: Array<{ op: BoardEvent; paceMs: number | null; rate: number; exec: FakeExec }> = [];
  notes: string[] = [];
  dimmed = false;
  execute(op: BoardEvent, opts: { paceMs: number | null; rate?: number }) {
    const exec = new FakeExec();
    this.executed.push({ op, paceMs: opts.paceMs, rate: opts.rate ?? 1, exec });
    return exec;
  }
  pinNote(note: { headline: string }) {
    this.notes.push(note.headline);
  }
  setDimmed(d: boolean) {
    this.dimmed = d;
  }
  clear() {}
}
class FakeCaptions implements CaptionPort {
  expert: string[] = [];
  reveals: number[] = [];
  learner: string[] = [];
  hints: Array<string | null> = [];
  showExpert(text: string, revealMs: number) {
    this.expert.push(text);
    this.reveals.push(revealMs);
  }
  showLearner(_n: string, text: string) {
    this.learner.push(text);
  }
  hint(t: string | null) {
    this.hints.push(t);
  }
  clear() {}
}
class FakePresence implements PresencePort {
  speaking = false;
  checks: unknown[] = [];
  ads: unknown[] = [];
  notices: string[] = [];
  setState() {}
  setSpeaking(s: boolean) {
    this.speaking = s;
  }
  showCheck(c: unknown) {
    this.checks.push(c);
  }
  showAd(a: unknown) {
    this.ads.push(a);
  }
  waiting = false;
  setWaiting(w: boolean) {
    this.waiting = w;
  }
  notice(t: string | null) {
    if (t) this.notices.push(t);
  }
}
class FakeTransport implements TransportPort {
  sent: ClientMessage[] = [];
  send(m: ClientMessage) {
    this.sent.push(m);
  }
}

const HOST = 'host-1';
function state(mode: RoomState['mode'], extra: Partial<RoomState> = {}): RoomState {
  return {
    sessionId: 's',
    topic: 't',
    language: 'en',
    expertId: 'ada',
    phase: 'live',
    mode,
    floor: null,
    hostId: HOST,
    participants: [{ id: HOST, name: 'Sam', role: 'host', hue: 1, micOn: false, joinedAt: 0 }],
    plan: null,
    segment: 0,
    clockMs: 0,
    pace: 1,
    preparation: null,
    evidenceTier: 'reviewed_pack_source',
    startedAt: 0,
    recap: null,
    resume: null,
    ...extra,
  };
}
const say = (seq: number, id: string, text: string, thread = 'lesson'): Cue => ({
  seq,
  segment: 0,
  thread,
  at: 0,
  event: { type: 'say', id, text, tone: 'warm' },
});
const boardCue = (seq: number, id: string, anchor: string, text: string): Cue => ({
  seq,
  segment: 0,
  thread: 'lesson',
  at: 0,
  event: {
    type: 'board',
    id,
    anchor,
    op: 'write',
    text,
    lang: '',
    ref: '',
    ref2: '',
    place: 'flow',
    emphasis: 'ink',
  },
});
const frame = (sayId: string, take = 0, final = true): DownstreamAudioHeader => ({
  dir: 'down',
  sayId,
  audioChunkId: 0,
  audioClockMs: 0,
  sampleRate: 44100,
  durationMs: 120,
  textSpan: null,
  final,
  take,
});

function setup() {
  const audio = new FakeAudio();
  const boardPort = new FakeBoard();
  const captions = new FakeCaptions();
  const presence = new FakePresence();
  const transport = new FakeTransport();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const c = new Conductor({
    audio,
    board: boardPort,
    captions,
    presence,
    transport,
    participantId: HOST,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  c.handleServer({ kind: 'ready', participantId: HOST, state: state('teaching'), backlog: [] });
  return { c, audio, board: boardPort, captions, presence, transport, timers };
}

describe('Conductor', () => {
  it('paces a with-anchored board op to the sentence and reports progress when the sentence ends', () => {
    const { c, audio, board, captions, transport } = setup();
    c.handleServer({
      kind: 'cue',
      cue: say(0, 'L0.s1', 'Six tokens is everything the model sees.'),
    });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'L0.s1', 'the cat sat') });
    c.handleServer({ kind: 'cue', cue: boardCue(2, 'L0.b2', 'after:L0.s1', 'token → vector') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s1', durationMs: 3200 });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    expect(audio.enqueued).toEqual(['L0.s1@0']);
    expect(board.executed).toHaveLength(0);
    c.audioEvents.onSayStart('L0.s1@0');
    expect(captions.expert).toEqual(['Six tokens is everything the model sees.']);
    expect(board.executed.map((e) => [e.op.id, e.paceMs])).toEqual([['L0.b1', 3200]]);
    c.audioEvents.onSayEnd('L0.s1@0', 3200);
    expect(board.executed[0]?.exec.finished).toBe(1);
    expect(board.executed.map((e) => e.op.id)).toEqual(['L0.b1', 'L0.b2']);
    expect(transport.sent).toContainEqual({ kind: 'progress', seq: 0, clockMs: 0 });
  });

  it('barge-in: cancels audio, freezes the board, dims, and sends the exact resume point', () => {
    const { c, audio, board, transport } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'A long sentence being spoken.') });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'L0.s1', 'writing…') });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    audio.clock = { sayId: 'L0.s1@0', offsetMs: 900 };
    // Counted as a delta: joining the room cancels once to start the clock clean.
    const cancelsBefore = audio.cancelled;
    c.onSpeechStart();
    expect(audio.cancelled).toBe(cancelsBefore + 1);
    expect(board.dimmed).toBe(true);
    expect(board.executed[0]?.exec.paused).toBe(1);
    expect(transport.sent.at(-1)).toEqual({
      kind: 'interrupt',
      atSeq: 0,
      sayId: 'L0.s1',
      offsetMs: 900,
    });
    expect(c.getPhase()).toBe('listening');
    // Stale audio for take 0 is dropped after the room announces take 1; the new take plays and the frozen op resumes.
    c.handleServer({ kind: 'state', state: state('teaching') });
    c.handleServer({ kind: 'say_take', sayId: 'L0.s1', take: 1 });
    c.handleAudio(frame('L0.s1', 0), new Uint8Array(4));
    c.handleAudio(frame('L0.s1', 1), new Uint8Array(4));
    expect(audio.enqueued).toEqual(['L0.s1@0', 'L0.s1@1']);
    c.audioEvents.onSayStart('L0.s1@1');
    expect(board.executed[0]?.exec.resumed).toBe(1);
    expect(board.dimmed).toBe(false);
  });

  it('answer turn: undims when the turn speaks, sends resumed only after turn_done and the last turn sentence', () => {
    const { c, board, transport } = setup();
    c.handleServer({ kind: 'state', state: state('listening', { floor: HOST }) });
    c.handleServer({ kind: 'state', state: state('answering', { floor: HOST }) });
    c.handleServer({
      kind: 'cue',
      cue: {
        seq: 5,
        segment: 0,
        thread: 't1',
        at: 0,
        event: {
          type: 'note',
          language: 'en-US',
          question: 'why √d?',
          headline: 'keeps scores',
          detail: 'in range',
        },
      },
    });
    c.handleServer({ kind: 'cue', cue: say(6, 't1.s1', 'Good question.', 't1') });
    c.handleServer({ kind: 'cue', cue: say(7, 't1.s2', 'Okay, back to it.', 't1') });
    expect(board.notes).toEqual(['keeps scores']);
    c.audioEvents.onSayStart('t1.s1@0');
    expect(board.dimmed).toBe(false);
    c.audioEvents.onSayEnd('t1.s1@0', 1000);
    c.handleServer({ kind: 'turn_done', thread: 't1' });
    expect(transport.sent.some((m) => m.kind === 'resumed')).toBe(false);
    c.audioEvents.onSayStart('t1.s2@0');
    c.audioEvents.onSayEnd('t1.s2@0', 900);
    expect(transport.sent.filter((m) => m.kind === 'resumed')).toHaveLength(1);
  });

  it('shows a check-in when its asking sentence ends and reports the check cue', () => {
    const { c, presence, transport } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L1.s2', 'Quick one: what is a vector?') });
    c.handleServer({
      kind: 'cue',
      cue: {
        seq: 1,
        segment: 1,
        thread: 'lesson',
        at: 0,
        event: {
          type: 'check',
          id: 'L1.c1',
          askedBy: 'L1.s2',
          options: ['A', 'B'],
          expected: 'B',
          explain: 'x',
        },
      },
    });
    c.audioEvents.onSayStart('L1.s2@0');
    c.audioEvents.onSayEnd('L1.s2@0', 1500);
    expect(presence.checks.at(-1)).toMatchObject({ id: 'L1.c1' });
    expect(
      transport.sent
        .filter((m) => m.kind === 'progress')
        .map((m) => (m.kind === 'progress' ? m.seq : -1)),
    ).toEqual([0, 1]);
    c.answerCheck('L1.c1', 'a list of numbers');
    expect(transport.sent.at(-1)).toEqual({
      kind: 'check_answer',
      checkId: 'L1.c1',
      text: 'a list of numbers',
    });
  });

  it("reveals a check-in when the question's words end, before the beat of silence, and only once", () => {
    const { c, presence, transport, timers } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L1.s2', 'Quick one: what is a vector?') });
    c.handleServer({
      kind: 'cue',
      cue: {
        seq: 1,
        segment: 1,
        thread: 'lesson',
        at: 0,
        event: {
          type: 'check',
          id: 'L1.c1',
          askedBy: 'L1.s2',
          options: ['A', 'B'],
          expected: 'B',
          explain: 'x',
        },
      },
    });
    // 2200 ms of audio = 1500 ms of words + the 700 ms check beat at 1×.
    c.handleServer({ kind: 'say_complete', sayId: 'L1.s2', durationMs: 2200 });
    c.audioEvents.onSayStart('L1.s2@0');
    const reveal = timers.at(-1);
    expect(reveal?.ms).toBe(1500);
    const shown = () => presence.checks.filter((x) => x !== null);
    expect(shown()).toHaveLength(0);
    reveal?.fn();
    expect(shown().at(-1)).toMatchObject({ id: 'L1.c1' });
    // The question's say counts as heard (only its beat remains), then the check: progress stays monotonic.
    expect(transport.sent.filter((m) => m.kind === 'progress')).toEqual([
      { kind: 'progress', seq: 0, clockMs: 0 },
      { kind: 'progress', seq: 1, clockMs: 0 },
    ]);
    c.audioEvents.onSayEnd('L1.s2@0', 2200);
    expect(shown()).toHaveLength(1);
    expect(transport.sent.filter((m) => m.kind === 'progress')).toHaveLength(2);
  });

  it('a barge-in during the question cancels the pending reveal', () => {
    const { c, audio, presence, timers } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L1.s2', 'Quick one?') });
    c.handleServer({
      kind: 'cue',
      cue: {
        seq: 1,
        segment: 1,
        thread: 'lesson',
        at: 0,
        event: {
          type: 'check',
          id: 'L1.c1',
          askedBy: 'L1.s2',
          options: [],
          expected: 'B',
          explain: 'x',
        },
      },
    });
    c.handleServer({ kind: 'say_complete', sayId: 'L1.s2', durationMs: 2200 });
    c.handleAudio(frame('L1.s2'), new Uint8Array(4));
    c.audioEvents.onSayStart('L1.s2@0');
    audio.clock = { sayId: 'L1.s2@0', offsetMs: 300 };
    c.onSpeechStart();
    timers.at(-1)?.fn();
    expect(presence.checks.filter((x) => x !== null)).toHaveLength(0);
  });

  it('ad card: pauses after the marked cue, resumes on skip', () => {
    const { c, audio, presence, timers } = setup();
    c.handleServer({ kind: 'cue', cue: say(3, 'L0.s4', 'End of segment.') });
    c.handleServer({
      kind: 'ad',
      adId: 'ad-1',
      afterSeq: 3,
      skippableAfterMs: 5000,
      durationMs: 15000,
      format: 'video',
      tagUrl: 'https://ads.example.test/vast',
      slot: 'boundary',
    });
    c.audioEvents.onSayStart('L0.s4@0');
    c.audioEvents.onSayEnd('L0.s4@0', 1000);
    expect(c.getPhase()).toBe('ad');
    expect(audio.paused).toBe(true);
    expect(timers.at(-1)?.ms).toBe(15000);
    c.skipAd();
    expect(c.getPhase()).toBe('playing');
    expect(audio.paused).toBe(false);
    expect(presence.ads.at(-1)).toBeNull();
  });

  /** A boundary ad up and running: phase 'ad', audio held, ceiling timer armed. */
  function adUp() {
    const s = setup();
    s.c.handleServer({ kind: 'cue', cue: say(3, 'L0.s4', 'End of segment.') });
    s.c.handleServer({
      kind: 'ad',
      adId: 'ad-1',
      afterSeq: 3,
      skippableAfterMs: 5000,
      durationMs: 30000,
      format: 'video',
      tagUrl: 'https://ads.example.test/vast',
      slot: 'boundary',
    });
    s.c.audioEvents.onSayStart('L0.s4@0');
    s.c.audioEvents.onSayEnd('L0.s4@0', 1000);
    expect(s.c.getPhase()).toBe('ad');
    return s;
  }

  it('an ad keeps the phase through answering/checking/teaching broadcasts, so the skip still ends it', () => {
    for (const mode of ['answering', 'checking', 'teaching'] as const) {
      const { c, audio, presence } = adUp();
      c.handleServer({ kind: 'state', state: state(mode) });
      expect(c.getPhase(), mode).toBe('ad');
      expect(audio.paused, mode).toBe(true);
      c.skipAd();
      expect(c.getPhase(), mode).toBe('playing');
      expect(audio.paused, mode).toBe(false);
      expect(presence.ads.at(-1), mode).toBeNull();
    }
  });

  it('a host pause during an ad keeps the ad; when the ad ends the conductor lands in paused with audio held', () => {
    const { c, audio, presence, timers } = adUp();
    c.handleServer({ kind: 'state', state: state('paused') });
    expect(c.getPhase()).toBe('ad');
    // The ceiling fires (or the learner skips): the overlay goes, but nothing plays while the room is paused.
    timers.at(-1)?.fn();
    expect(presence.ads.at(-1)).toBeNull();
    expect(c.getPhase()).toBe('paused');
    expect(audio.paused).toBe(true);
    c.handleServer({ kind: 'state', state: state('teaching') });
    expect(c.getPhase()).toBe('playing');
  });

  it("someone else's floor during an ad keeps the ad; the ad's end lands in listening with audio cancelled", () => {
    const { c, audio } = adUp();
    c.handleServer({ kind: 'state', state: state('listening', { floor: 'guest-1' }) });
    expect(c.getPhase()).toBe('ad');
    const cancelledBefore = audio.cancelled;
    c.skipAd();
    expect(c.getPhase()).toBe('listening');
    expect(audio.cancelled).toBeGreaterThan(cancelledBefore);
  });

  it('host pause/resume: pauses locally and tells the room; resume discards held audio (new take incoming)', () => {
    const { c, audio, transport } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'x') });
    c.audioEvents.onSayStart('L0.s1@0');
    c.control('pause');
    expect(audio.paused).toBe(true);
    expect(transport.sent.at(-1)).toEqual({ kind: 'control', action: 'pause' });
    c.handleServer({ kind: 'state', state: state('paused') });
    const cancelsBefore = audio.cancelled;
    c.control('resume');
    expect(audio.cancelled).toBe(cancelsBefore + 1);
    expect(transport.sent.at(-1)).toEqual({ kind: 'control', action: 'resume' });
  });
});

describe('Conductor pace', () => {
  it('writes board ops at the room pace: rate follows state.pace, the with-op still finishes with the sentence', () => {
    const { c, board } = setup();
    c.handleServer({ kind: 'state', state: state('teaching', { pace: 1.3 }) });
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'A sentence.') });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'L0.s1', 'the cat sat') });
    c.handleServer({ kind: 'cue', cue: boardCue(2, 'L0.b2', 'now', 'aside') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s1', durationMs: 2600 });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    expect(board.executed.map((e) => [e.op.id, e.paceMs, e.rate])).toEqual([
      ['L0.b2', null, 1.3],
      ['L0.b1', 2600, 1.3],
    ]);
    expect(c.boardRate).toBe(1.3);
  });

  it('a pace change mid-sentence applies from the next sentence: ops of the current one keep their rate', () => {
    const { c, board } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'First.') });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'after:L0.s1', 'after one') });
    c.handleServer({ kind: 'cue', cue: say(2, 'L0.s2', 'Second.') });
    c.handleServer({ kind: 'cue', cue: boardCue(3, 'L0.b2', 'L0.s2', 'with two') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s2', durationMs: 1800 });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    // The host picks 0.75× while sentence one is still being spoken.
    c.handleServer({ kind: 'state', state: state('teaching', { pace: 0.75 }) });
    expect(c.boardRate).toBe(1);
    c.audioEvents.onSayEnd('L0.s1@0', 1500);
    expect(board.executed.map((e) => [e.op.id, e.rate])).toEqual([['L0.b1', 1]]);
    c.handleAudio(frame('L0.s2'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s2@0');
    expect(c.boardRate).toBe(0.75);
    expect(board.executed.map((e) => [e.op.id, e.paceMs, e.rate])).toEqual([
      ['L0.b1', null, 1],
      ['L0.b2', 1800, 0.75],
    ]);
  });

  it('replay playback rate re-times board ops and captions to wall time on top of the recorded pace', () => {
    const { c, board, captions } = setup();
    c.handleServer({ kind: 'state', state: state('teaching', { pace: 0.9 }) });
    c.setPlaybackRate(2);
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'Twice as fast.') });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'L0.s1', 'the cat sat') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s1', durationMs: 3000 });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    expect(captions.expert).toEqual(['Twice as fast.']);
    expect(captions.reveals).toEqual([1500]);
    expect(board.executed.map((e) => [e.op.id, e.paceMs, e.rate])).toEqual([['L0.b1', 1500, 1.8]]);
    c.setPlaybackRate(Number.NaN);
    expect(c.boardRate).toBe(0.9);
  });
});

describe('Conductor honest states', () => {
  /**
   * The bug the ads agent reported: the bottom bar stayed on "Answering you"
   * after a check's feedback. The mic tripping during the feedback sentence
   * cancelled its audio, so the sentence never reached `onSayEnd` and the
   * client could never honestly tell the room the turn had finished playing.
   */
  it('a barge-in during a turn still settles the turn: resumed is sent for the abandoned audio', () => {
    const { c, audio, transport } = setup();
    c.handleServer({ kind: 'state', state: state('checking') });
    c.answerCheck('L1.c1', 'a list of numbers');
    c.handleServer({ kind: 'state', state: state('thinking', { floor: HOST }) });
    c.handleServer({ kind: 'state', state: state('answering', { floor: HOST }) });
    c.handleServer({ kind: 'cue', cue: say(10, 't1.s1', 'Exactly that.', 't1') });
    c.handleAudio(frame('t1.s1', 0, false), new Uint8Array(4));
    c.audioEvents.onSayStart('t1.s1@0');
    expect(c.getPhase()).toBe('playing');

    // The mic trips mid-feedback: the player is cancelled, so this say never ends.
    audio.clock = { sayId: 't1.s1@0', offsetMs: 400 };
    c.onSpeechStart();
    expect(c.getPhase()).toBe('listening');

    c.handleServer({ kind: 'turn_done', thread: 't1' });
    expect(transport.sent.filter((m) => m.kind === 'resumed')).toHaveLength(1);
  });

  it('a turn that plays to the end still sends resumed exactly once', () => {
    const { c, transport } = setup();
    c.handleServer({ kind: 'state', state: state('answering', { floor: HOST }) });
    c.handleServer({ kind: 'cue', cue: say(10, 't1.s1', 'Exactly that.', 't1') });
    c.audioEvents.onSayStart('t1.s1@0');
    c.audioEvents.onSayEnd('t1.s1@0', 1200);
    c.handleServer({ kind: 'turn_done', thread: 't1' });
    expect(transport.sent.filter((m) => m.kind === 'resumed')).toHaveLength(1);
  });

  it('lesson sentences are never abandoned: they come back with a new take', () => {
    const { c, audio, transport } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'A long sentence.') });
    c.audioEvents.onSayStart('L0.s1@0');
    audio.clock = { sayId: 'L0.s1@0', offsetMs: 900 };
    c.onSpeechStart();
    // Nothing to resume: the lesson thread never reports a turn.
    expect(transport.sent.some((m) => m.kind === 'resumed')).toBe(false);
  });

  it('says the expert is thinking when nothing is heard or written for the waiting beat', () => {
    const { c, presence, timers } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'One sentence.') });
    c.audioEvents.onSayStart('L0.s1@0');
    expect(presence.waiting).toBe(false);
    c.audioEvents.onSayEnd('L0.s1@0', 900);
    // The gap after the sentence: the watchdog is armed for the waiting beat.
    const watch = timers.filter((t) => t.ms === WAITING_AFTER_MS).at(-1);
    expect(watch).toBeDefined();
    watch?.fn();
    expect(presence.waiting).toBe(true);
    // The next sentence starts: the line goes away without anyone asking.
    c.handleServer({ kind: 'cue', cue: say(1, 'L0.s2', 'The next one.') });
    c.audioEvents.onSayStart('L0.s2@0');
    expect(presence.waiting).toBe(false);
  });

  it('never claims the expert is thinking while the learner has the floor', () => {
    const { c, presence, timers } = setup();
    c.handleServer({ kind: 'state', state: state('listening', { floor: HOST }) });
    for (const t of timers.filter((t) => t.ms === WAITING_AFTER_MS)) t.fn();
    expect(presence.waiting).toBe(false);
  });

  it('says the expert is thinking while the room composes an answer', () => {
    const { c, presence, timers } = setup();
    c.handleServer({ kind: 'state', state: state('thinking', { floor: HOST }) });
    const watch = timers.filter((t) => t.ms === WAITING_AFTER_MS).at(-1);
    watch?.fn();
    expect(presence.waiting).toBe(true);
  });
});

describe('Conductor fast-forward (replay seek)', () => {
  /**
   * "Jump to cue N" is the same catch-up a late joiner gets: every board op
   * before the target sentence is drawn in its finished state, in cue order,
   * and then the lesson continues at the recorded pace.
   */
  it('renders the whole backlog instantly and in cue order, then paces what follows', () => {
    const { c, board } = setup();
    c.handleServer({
      kind: 'ready',
      participantId: HOST,
      state: state('teaching'),
      backlog: [
        say(0, 'L0.s1', 'First sentence.'),
        boardCue(1, 'L0.b1', 'L0.s1', 'the cat sat'),
        boardCue(2, 'L0.b2', 'after:L0.s1', 'token → vector'),
        say(3, 'L0.s2', 'Second sentence.'),
      ],
    });
    // Both ops are on the paper already, finished, in the order they were written.
    expect(board.executed.map((e) => e.op.id)).toEqual(['L0.b1', 'L0.b2']);
    for (const e of board.executed) expect(e.exec.finished).toBe(1);

    // From the target sentence on, the board is written at the human pace again.
    c.handleServer({ kind: 'cue', cue: boardCue(4, 'L0.b3', 'L0.s2', 'and then this') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s2', durationMs: 2400 });
    c.audioEvents.onSayStart('L0.s2@0');
    const live = board.executed.at(-1);
    expect(live?.op.id).toBe('L0.b3');
    expect(live?.paceMs).toBe(2400);
    expect(live?.exec.finished).toBe(0);
  });

  it('draws `now`-anchored ops in a backlog too, instead of dropping them', () => {
    const { c, board } = setup();
    const nowOp: Cue = {
      seq: 1,
      segment: 0,
      thread: 'lesson',
      at: 0,
      event: {
        type: 'board',
        id: 'L0.b1',
        anchor: 'now',
        op: 'write',
        text: 'drawn on arrival',
        lang: '',
        ref: '',
        ref2: '',
        place: 'flow',
        emphasis: 'ink',
      },
    };
    c.handleServer({
      kind: 'ready',
      participantId: HOST,
      state: state('teaching'),
      backlog: [say(0, 'L0.s1', 'First.'), nowOp],
    });
    expect(board.executed.map((e) => e.op.id)).toEqual(['L0.b1']);
    expect(board.executed[0]?.exec.finished).toBe(1);
  });

  it('a sentence entered part-way through gets only the time it has left', () => {
    const { c, board, captions } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'A four second sentence.') });
    c.handleServer({ kind: 'cue', cue: boardCue(1, 'L0.b1', 'L0.s1', 'with the sentence') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s1', durationMs: 4000 });
    // The seek landed 1.5 s in: the pen and the caption have 2.5 s, not 4 s.
    c.startNextSayAt(1500);
    c.audioEvents.onSayStart('L0.s1@0');
    expect(board.executed[0]?.paceMs).toBe(2500);
    expect(captions.reveals.at(-1)).toBe(2500);

    // It applies once: the next sentence is timed normally again.
    c.handleServer({ kind: 'cue', cue: say(2, 'L0.s2', 'The next one.') });
    c.handleServer({ kind: 'cue', cue: boardCue(3, 'L0.b2', 'L0.s2', 'more') });
    c.handleServer({ kind: 'say_complete', sayId: 'L0.s2', durationMs: 3000 });
    c.audioEvents.onSayStart('L0.s2@0');
    expect(board.executed.at(-1)?.paceMs).toBe(3000);
  });
});

describe('Conductor rejoin', () => {
  /**
   * After a drop the room replays its state and cue backlog. Audio banked
   * before the gap belongs to a clock the resumed stream no longer shares, so
   * a rejoin starts the audio clean — otherwise the player rejects every new
   * chunk on a clock discontinuity and the room goes quiet.
   */
  it('drops audio banked before the gap and rebuilds the board from the backlog', () => {
    const { c, audio, board } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'Before the drop.') });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    expect(audio.enqueued).toEqual(['L0.s1@0']);
    const cancelledBefore = audio.cancelled;

    // The socket came back and the room re-admitted us.
    c.handleServer({
      kind: 'ready',
      participantId: HOST,
      state: state('teaching'),
      backlog: [
        say(0, 'L0.s1', 'Before the drop.'),
        boardCue(1, 'L0.b1', 'L0.s1', 'written while away'),
      ],
    });
    expect(audio.cancelled).toBe(cancelledBefore + 1);
    // What was written while we were gone is on the paper, finished.
    expect(board.executed.map((e) => e.op.id)).toEqual(['L0.b1']);
    expect(board.executed[0]?.exec.finished).toBe(1);

    // And the resumed stream plays.
    c.handleAudio(frame('L0.s2'), new Uint8Array(4));
    expect(audio.enqueued).toEqual(['L0.s1@0', 'L0.s2@0']);
  });
});
