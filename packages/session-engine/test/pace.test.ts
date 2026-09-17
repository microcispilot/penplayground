import type { LedgerEntry, LessonEvent } from '@pen/contracts';
import { gapMsFor, ttsSpeedFor } from '@pen/contracts';
import { FakeLanguageModel, type FakeScript } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import type { LedgerSink } from '../src/room.js';
import { SessionRoom } from '../src/room.js';
import {
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  SpySynthesizer,
  say,
  segmentScript,
  sleep,
  until,
  voiceFor,
} from './fixtures.js';

const HOST = 'host-1234';
const GUEST = 'guest-5678';

class MemoryLedger implements LedgerSink {
  entries: LedgerEntry[] = [];
  append(_sessionId: string, entry: LedgerEntry) {
    this.entries.push(entry);
  }
  storeAudio() {
    return 'mem#0';
  }
}

/** Silent-synth speech length for a sentence: words at 150 wpm, shortened by the speed. */
function speechMs(text: string, speed: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
  return Math.max(350, Math.round(((words / 150) * 60_000) / speed));
}

async function liveRoom(opts: { scripts?: FakeScript[]; pace?: number } = {}) {
  const { onten } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const ledger = new MemoryLedger();
  const room = new SessionRoom({
    sessionId: 'sess-pace',
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo: onten.memo,
    model: new FakeLanguageModel(opts.scripts ?? [segmentScript(1)], [
      planCompletion(1),
      { purpose: 'recap', value: { points: ['Tokens become vectors'] } },
    ]),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    sampleRate: 44100,
    transport,
    acquirer: null,
    ledger,
    targetMinutes: 1,
    ...(opts.pace !== undefined ? { pace: opts.pace } : {}),
  });
  expect(room.join({ id: GUEST, name: 'Kim' })).toMatchObject({ ok: true });
  return { room, transport, synthesizer, ledger };
}

const completed = (transport: MemoryTransport) =>
  transport.messages.flatMap((m) => (m.kind === 'say_complete' ? [m] : []));

describe('pace', () => {
  it('starts at the teacher rhythm: Fish speed 0.95 and a 400 ms beat after each sentence', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => completed(transport).length >= 2);
    expect(room.getState().pace).toBe(1);
    expect(synthesizer.requests.map((r) => r.speed)).toEqual([0.95, 0.95]);
    const first = completed(transport)[0];
    expect(first?.durationMs).toBe(speechMs('Segment 1, first sentence.', 0.95) + 400);
    // The beat is audio: silent frames continue the say's clock up to the final chunk.
    const frames = transport.audio.filter((h) => h.sayId === first?.sayId);
    expect(frames.at(-1)?.final).toBe(true);
    expect(frames.at(-1)?.audioClockMs).toBeLessThan(first?.durationMs ?? 0);
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1];
      expect(frames[i]?.audioClockMs).toBe((prev?.audioClockMs ?? 0) + (prev?.durationMs ?? 0));
    }
    await room.end();
  });

  it('host set_pace changes the speed of the next sentence, not the one in flight, broadcasts state and records the ledger entry', async () => {
    // 600 ms between the two scripted sentences: s1 is synthesised before the change, s2 after.
    const { room, transport, synthesizer, ledger } = await liveRoom({
      scripts: [segmentScript(1, 600)],
    });
    await room.start();
    await until(() => synthesizer.requests.length >= 1);
    room.handle(HOST, { kind: 'set_pace', pace: 1.3 });
    expect(room.getState().pace).toBe(1.3);
    expect(transport.states().at(-1)?.pace).toBe(1.3);
    expect(ledger.entries.filter((e) => e.kind === 'pace')).toEqual([
      { kind: 'pace', t: expect.any(Number), pace: 1.3, participantId: HOST },
    ]);
    await until(() => completed(transport).length >= 2, 8000);
    expect(synthesizer.requests.map((r) => r.speed)).toEqual([0.95, ttsSpeedFor(1.3)]);
    const [s1, s2] = completed(transport);
    expect(s1?.durationMs).toBe(speechMs('Segment 1, first sentence.', 0.95) + 400);
    expect(s2?.durationMs).toBe(
      speechMs('Segment 1, second sentence.', ttsSpeedFor(1.3)) + gapMsFor('sentence', 1.3),
    );
    await room.end();
  });

  it('refuses a guest with NOT_HOST and leaves the pace and ledger untouched', async () => {
    const { room, transport, ledger } = await liveRoom();
    await room.start();
    const before = transport.messages.length;
    room.handle(GUEST, { kind: 'set_pace', pace: 0.75 });
    expect(transport.messages.slice(before)).toEqual([
      { kind: 'error', code: 'NOT_HOST', message: 'Only the host sets the pace.', spoken: false },
    ]);
    expect(room.getState().pace).toBe(1);
    expect(ledger.entries.some((e) => e.kind === 'pace')).toBe(false);
    await room.end();
  });

  it('clamps a wild pace, ignores a no-op, and honours the initial pace from the host preference', async () => {
    const { room, transport, ledger } = await liveRoom({ pace: 1.15 });
    await room.start();
    expect(room.getState().pace).toBe(1.15);
    room.handle(HOST, { kind: 'set_pace', pace: 1.15 });
    expect(ledger.entries.filter((e) => e.kind === 'pace')).toHaveLength(0);
    room.handle(HOST, { kind: 'set_pace', pace: 0.1 });
    expect(room.getState().pace).toBe(0.5);
    expect(transport.states().at(-1)?.pace).toBe(0.5);
    await room.end();
  });

  it('waits longer after a check-in question and after a board title', async () => {
    const title: LessonEvent = {
      type: 'board',
      id: 'b1',
      anchor: 's1',
      op: 'title',
      text: 'Tokens',
      lang: '',
      ref: '',
      ref2: '',
      place: 'newline',
      emphasis: 'ink',
    };
    const script: FakeScript = {
      match: (r) => r.purpose === 'lesson',
      gapMs: 2,
      events: [
        say('s1', 'Tokens first.'),
        title,
        say('s2', 'Quick one: what is a token?'),
        {
          type: 'check',
          id: 'c1',
          askedBy: 's2',
          options: ['A word piece', 'A number'],
          expected: 'A word piece',
          explain: 'A token is a piece of text.',
        },
        say('s3', 'Good, moving on.'),
        { type: 'done' },
      ],
    };
    const { room, transport } = await liveRoom({ scripts: [script] });
    await room.start();
    await until(() => completed(transport).length >= 3);
    const [s1, s2, s3] = completed(transport);
    expect(s1?.durationMs).toBe(speechMs('Tokens first.', 0.95) + 700);
    expect(s2?.durationMs).toBe(speechMs('Quick one: what is a token?', 0.95) + 700);
    expect(s3?.durationMs).toBe(speechMs('Good, moving on.', 0.95) + 400);
    await room.end();
  });

  it('a spoken "slower" from the host steps the pace down one preset', async () => {
    const { room, transport } = await liveRoom();
    await room.start();
    await until(() => transport.cues().length >= 2);
    room.handle(HOST, { kind: 'progress', seq: 0, clockMs: 1000 });
    room.handle(HOST, {
      kind: 'transcript',
      utteranceId: 'u1',
      text: 'slow down please',
      final: true,
    });
    await until(() => room.getState().pace === 0.9);
    await sleep(20);
    expect(room.getState().mode).toBe('teaching');
    await room.end();
  });
});
