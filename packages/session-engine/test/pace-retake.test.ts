import type { LedgerEntry } from '@pen/contracts';
import { ttsSpeedFor } from '@pen/contracts';
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
  until,
  voiceFor,
} from './fixtures.js';

/**
 * A pace change is heard now, not two sentences from now (tasks/todo.md,
 * ADR-0010). The sentence at the speaker keeps its own speed — re-cutting it
 * would restart it mid-word — and every sentence banked behind it is
 * re-synthesised under a fresh take.
 */

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

/** Four sentences: more than the pipeline's lookahead, so some are banked and some still queued. */
function longSegment(gapMs = 2): FakeScript {
  return {
    match: (r) =>
      r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 1:')),
    gapMs,
    events: [
      say('s1', 'Segment 1, first sentence.'),
      say('s2', 'Segment 1, second sentence.'),
      say('s3', 'Segment 1, third sentence.'),
      say('s4', 'Segment 1, fourth sentence.'),
      { type: 'done' },
    ],
  };
}

async function liveRoom() {
  const { onten } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const ledger = new MemoryLedger();
  const room = new SessionRoom({
    sessionId: 'sess-retake',
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo: onten.memo,
    model: new FakeLanguageModel(
      [longSegment()],
      [planCompletion(1), { purpose: 'recap', value: { points: ['Tokens become vectors'] } }],
    ),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    sampleRate: 44100,
    transport,
    acquirer: null,
    ledger,
    targetMinutes: 1,
  });
  expect(room.join({ id: GUEST, name: 'Kim' })).toMatchObject({ ok: true });
  return { room, transport, synthesizer, ledger };
}

/** `say_take` messages, which are how a client learns its banked audio is stale. */
const takes = (transport: MemoryTransport) =>
  transport.messages.flatMap((m) => (m.kind === 'say_take' ? [m] : []));

/** Model ids are qualified with the thread (`L0.s2`); this is the bare sentence id. */
const bare = (sayId: string) => sayId.slice(sayId.lastIndexOf('.') + 1);

/** Lesson sentences the room has emitted as cues — independent of how many are synthesised. */
const lessonSays = (transport: MemoryTransport) =>
  transport.cues().filter((c) => c.thread === 'lesson' && c.event.type === 'say');

describe('pace re-take', () => {
  it('re-cuts every banked sentence behind the one being heard, at the new speed', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    // All four sentences are on the wire, and the pipeline has banked what it may.
    await until(() => lessonSays(transport).length >= 4);
    await until(() => synthesizer.requests.length >= 3);
    const before = synthesizer.requests.length;

    room.handle(HOST, { kind: 'set_pace', pace: 1.3 });

    const retaken = takes(transport);
    // Nothing has been heard yet, so s1 is at the speaker and s2-s4 are behind it.
    expect(retaken.map((t) => bare(t.sayId))).toEqual(['s2', 's3', 's4']);
    // A newer take, so the conductor knows the audio it holds is stale.
    expect(retaken.every((t) => t.take === 1)).toBe(true);

    // The sentences that were actually banked are bought again at the new speed
    // together: releasing the budget their discarded takes were holding is what
    // stops them trickling out one per sentence heard. (s4 was never banked —
    // the lookahead is three and s1 still holds a slot — so it is simply
    // synthesised at the new speed when its turn comes.)
    await until(
      () => synthesizer.requests.filter((r) => r.speed === ttsSpeedFor(1.3)).length >= 2,
      8000,
    );
    const afterChange = synthesizer.requests.slice(before);
    expect(afterChange.every((r) => r.speed === ttsSpeedFor(1.3))).toBe(true);
    expect(new Set(afterChange.map((r) => r.text))).toEqual(
      new Set(['Segment 1, second sentence.', 'Segment 1, third sentence.']),
    );
    // The sentence that was already playing was bought at the old speed and left alone.
    expect(synthesizer.requests[0]?.speed).toBe(0.95);
    await room.end();
  }, 15_000);

  it('re-takes only what is still ahead once the host has heard some of the lesson', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => lessonSays(transport).length >= 4);
    await until(() => synthesizer.requests.length >= 2);
    // The host's conductor reports through cue 1: s1 and s2 have been heard.
    room.handle(HOST, { kind: 'progress', seq: 1, clockMs: 2_000 });

    room.handle(HOST, { kind: 'set_pace', pace: 0.75 });

    // s3 is the sentence now at the speaker, so the swap starts at s4.
    expect(takes(transport).map((t) => bare(t.sayId))).toEqual(['s4']);
    await room.end();
  }, 15_000);

  it('does not re-take anything for a guest, or for a pace that did not change', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => lessonSays(transport).length >= 4);

    room.handle(GUEST, { kind: 'set_pace', pace: 1.3 });
    expect(takes(transport)).toHaveLength(0);

    room.handle(HOST, { kind: 'set_pace', pace: 1 });
    expect(takes(transport)).toHaveLength(0);
    await room.end();
  });

  it('spends nothing more than it has to: the aborted takes are not re-bought at the old speed', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => lessonSays(transport).length >= 4);
    await until(() => synthesizer.requests.length >= 2);
    room.handle(HOST, { kind: 'set_pace', pace: 1.3 });
    await until(() => takes(transport).length >= 3);
    // Let the pipeline settle, then check no sentence was synthesised twice at 0.95.
    await until(
      () => synthesizer.requests.filter((r) => r.speed === ttsSpeedFor(1.3)).length >= 2,
      8000,
    );
    const atOldSpeed = synthesizer.requests.filter((r) => r.speed === 0.95).map((r) => r.text);
    expect(new Set(atOldSpeed).size).toBe(atOldSpeed.length);
    await room.end();
  }, 15_000);
});
