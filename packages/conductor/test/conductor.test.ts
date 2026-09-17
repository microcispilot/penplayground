import type {
  BoardEvent,
  ClientMessage,
  Cue,
  DownstreamAudioHeader,
  RoomState,
} from '@pen/contracts';
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
  executed: Array<{ op: BoardEvent; paceMs: number | null; exec: FakeExec }> = [];
  notes: string[] = [];
  dimmed = false;
  execute(op: BoardEvent, opts: { paceMs: number | null }) {
    const exec = new FakeExec();
    this.executed.push({ op, paceMs: opts.paceMs, exec });
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
  learner: string[] = [];
  hints: Array<string | null> = [];
  showExpert(text: string) {
    this.expert.push(text);
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
    c.onSpeechStart();
    expect(audio.cancelled).toBe(1);
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

  it('ad card: pauses after the marked cue, resumes on skip', () => {
    const { c, audio, presence, timers } = setup();
    c.handleServer({ kind: 'cue', cue: say(3, 'L0.s4', 'End of segment.') });
    c.handleServer({
      kind: 'ad',
      adId: 'ad-1',
      afterSeq: 3,
      skippableAfterMs: 5000,
      durationMs: 15000,
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

  it('host pause/resume: pauses locally and tells the room; resume discards held audio (new take incoming)', () => {
    const { c, audio, transport } = setup();
    c.handleServer({ kind: 'cue', cue: say(0, 'L0.s1', 'x') });
    c.audioEvents.onSayStart('L0.s1@0');
    c.control('pause');
    expect(audio.paused).toBe(true);
    expect(transport.sent.at(-1)).toEqual({ kind: 'control', action: 'pause' });
    c.handleServer({ kind: 'state', state: state('paused') });
    c.control('resume');
    expect(audio.cancelled).toBe(1);
    expect(transport.sent.at(-1)).toEqual({ kind: 'control', action: 'resume' });
  });
});
