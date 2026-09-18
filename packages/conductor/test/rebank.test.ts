import type {
  ClientMessage,
  Cue,
  DownstreamAudioHeader,
  NoteEvent,
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

/**
 * The client half of a pace re-take (ADR-0010). The player schedules audio as
 * one contiguous timeline, so a stale sentence cannot be picked out of the
 * bank: the newer takes wait until the sentence at the speaker finishes, and
 * the swap happens in that gap, where nothing is cut and nothing is heard
 * twice.
 */

class FakeAudio implements AudioPort {
  enqueued: string[] = [];
  cancelled = 0;
  clock = { sayId: null as string | null, offsetMs: 0 };
  enqueue(chunk: { sayId: string }) {
    this.enqueued.push(chunk.sayId);
  }
  pause() {}
  resume() {}
  cancel() {
    this.cancelled += 1;
    return { ...this.clock };
  }
}
class FakeExec implements BoardExecution {
  done = Promise.resolve();
  pause() {}
  resume() {}
  finish() {}
  cancel() {}
}
class FakeBoard implements BoardPort {
  execute(): BoardExecution {
    return new FakeExec();
  }
  pinNote(_note: NoteEvent, _id: string) {}
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
  setState() {}
  setSpeaking() {}
  showCheck() {}
  showAd() {}
  notice() {}
}
class FakeTransport implements TransportPort {
  sent: ClientMessage[] = [];
  send(m: ClientMessage) {
    this.sent.push(m);
  }
}

const HOST = 'host-1';
function roomState(
  mode: RoomState['mode'] = 'teaching',
  extra: Partial<RoomState> = {},
): RoomState {
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
const sayCue = (seq: number, id: string, text: string): Cue => ({
  seq,
  segment: 0,
  thread: 'lesson',
  at: 0,
  event: { type: 'say', id, text, tone: 'warm' },
});
const frame = (sayId: string, take = 0): DownstreamAudioHeader => ({
  dir: 'down',
  sayId,
  audioChunkId: 0,
  audioClockMs: 0,
  sampleRate: 44100,
  durationMs: 120,
  textSpan: null,
  final: true,
  take,
});

function setup() {
  const audio = new FakeAudio();
  const transport = new FakeTransport();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const c = new Conductor({
    audio,
    board: new FakeBoard(),
    captions: new FakeCaptions(),
    presence: new FakePresence(),
    transport,
    participantId: HOST,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  c.handleServer({ kind: 'ready', participantId: HOST, state: roomState(), backlog: [] });
  return { c, audio, transport, timers };
}

/** Two sentences banked, the first one playing: the state a pace change arrives in. */
function banked() {
  const h = setup();
  h.c.handleServer({ kind: 'cue', cue: sayCue(0, 'L0.s1', 'First sentence.') });
  h.c.handleServer({ kind: 'cue', cue: sayCue(1, 'L0.s2', 'Second sentence.') });
  h.c.handleServer({ kind: 'cue', cue: sayCue(2, 'L0.s3', 'Third sentence.') });
  h.c.handleAudio(frame('L0.s1'), new Uint8Array(4));
  h.c.handleAudio(frame('L0.s2'), new Uint8Array(4));
  h.c.handleAudio(frame('L0.s3'), new Uint8Array(4));
  h.c.audioEvents.onSayStart('L0.s1@0');
  expect(h.audio.enqueued).toEqual(['L0.s1@0', 'L0.s2@0', 'L0.s3@0']);
  return h;
}

describe('pace re-take on the client', () => {
  it('holds the newer takes until the sentence being heard ends, then swaps the bank', () => {
    const { c, audio } = banked();

    // The room re-cut everything behind the sentence at the speaker.
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'pace' });
    c.handleServer({ kind: 'say_take', sayId: 'L0.s3', take: 1, reason: 'pace' });
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));
    c.handleAudio(frame('L0.s3', 1), new Uint8Array(4));

    // Nothing new reaches the player yet: both takes of a sentence on the
    // timeline at once would be heard twice.
    expect(audio.enqueued).toEqual(['L0.s1@0', 'L0.s2@0', 'L0.s3@0']);
    expect(audio.cancelled).toBe(0);

    c.audioEvents.onSayEnd('L0.s1@0', 1200);

    // The speaker has fallen silent: the stale bank goes and the new takes land.
    expect(audio.cancelled).toBe(1);
    expect(audio.enqueued).toEqual(['L0.s1@0', 'L0.s2@0', 'L0.s3@0', 'L0.s2@1', 'L0.s3@1']);
  });

  it('never cuts the sentence the learner is hearing', () => {
    const { c, audio } = banked();
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'pace' });
    // A re-take is pending, but s1 is still playing and must be left alone.
    expect(audio.cancelled).toBe(0);
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));
    expect(audio.cancelled).toBe(0);
  });

  it('drops audio from a take the room has moved past', () => {
    const { c, audio } = banked();
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'pace' });
    c.audioEvents.onSayEnd('L0.s1@0', 1200);
    const after = audio.enqueued.length;
    // A straggling chunk of the discarded take arrives late; it is not played.
    c.handleAudio(frame('L0.s2', 0), new Uint8Array(4));
    expect(audio.enqueued).toHaveLength(after);
  });

  it('does not swap for a sentence that has not been banked at all', () => {
    const { c, audio } = banked();
    // s4 was re-taken before its audio ever reached this client: there is
    // nothing stale to replace, so the boundary passes without a cancel.
    c.handleServer({ kind: 'cue', cue: sayCue(3, 'L0.s4', 'Fourth sentence.') });
    c.handleServer({ kind: 'say_take', sayId: 'L0.s4', take: 1, reason: 'pace' });
    c.handleAudio(frame('L0.s4', 1), new Uint8Array(4));
    expect(audio.enqueued).toContain('L0.s4@1');
    c.audioEvents.onSayEnd('L0.s1@0', 1200);
    expect(audio.cancelled).toBe(0);
  });

  it('forgets a pending re-take when the learner interrupts', () => {
    const { c, audio } = banked();
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'pace' });
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));

    // A barge-in: the room will re-speak from the resume point with newer takes
    // still, so the audio held for the pace change is moot.
    c.onSpeechStart();
    expect(audio.cancelled).toBe(1);
    const afterBargeIn = audio.enqueued.length;
    c.audioEvents.onSayEnd('L0.s1@0', 1200);
    expect(audio.cancelled).toBe(1);
    expect(audio.enqueued).toHaveLength(afterBargeIn);
  });

  it('swaps anyway if the sentence at the speaker never ends', () => {
    const { c, audio, timers } = banked();
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'pace' });
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));
    const ceiling = timers.find((t) => t.ms === 30_000);
    expect(ceiling).toBeDefined();

    ceiling?.fn();

    // Held audio can never be stranded, even by a say that stalls.
    expect(audio.cancelled).toBe(1);
    expect(audio.enqueued).toContain('L0.s2@1');
  });
});

describe('a resume take is not a pace re-take', () => {
  it('plays a resume take straight away instead of holding it', () => {
    const { c, audio } = banked();
    // After a pause or an answer the client has already dropped its bank, so
    // there is nothing stale to swap: holding this audio would strand it.
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1, reason: 'resume' });
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));
    expect(audio.enqueued).toContain('L0.s2@1');
    c.audioEvents.onSayEnd('L0.s1@0', 1200);
    expect(audio.cancelled).toBe(0);
  });

  it('treats a take with no reason as a resume, for older servers', () => {
    const { c, audio } = banked();
    c.handleServer({ kind: 'say_take', sayId: 'L0.s2', take: 1 });
    c.handleAudio(frame('L0.s2', 1), new Uint8Array(4));
    expect(audio.enqueued).toContain('L0.s2@1');
  });
});

describe('an ad whose boundary has already gone by', () => {
  it('starts now rather than waiting for a sentence that may never come', () => {
    const { c, transport } = setup();
    c.handleServer({ kind: 'cue', cue: sayCue(0, 'L0.s1', 'First sentence.') });
    c.handleAudio(frame('L0.s1'), new Uint8Array(4));
    c.audioEvents.onSayStart('L0.s1@0');
    // The host reports progress through cue 0 as the sentence ends.
    c.audioEvents.onSayEnd('L0.s1@0', 1200);
    expect(transport.sent).toContainEqual({ kind: 'progress', seq: 0, clockMs: 0 });

    // The room's ad for that same boundary arrives late (it is scheduled from
    // the progress report the client just sent).
    c.handleServer({
      kind: 'ad',
      adId: 'ad-1',
      afterSeq: 0,
      skippableAfterMs: 5_000,
      durationMs: 30_000,
      format: 'video',
      tagUrl: 'https://ads.test/vast',
      slot: 'boundary',
    });
    expect(c.getPhase()).toBe('ad');
  });

  it('still waits when the boundary is genuinely ahead', () => {
    const { c } = setup();
    c.handleServer({
      kind: 'ad',
      adId: 'ad-2',
      afterSeq: 9,
      skippableAfterMs: 5_000,
      durationMs: 30_000,
      format: 'video',
      tagUrl: 'https://ads.test/vast',
      slot: 'boundary',
    });
    expect(c.getPhase()).not.toBe('ad');
  });
});
