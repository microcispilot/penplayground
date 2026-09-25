import type { LedgerEntry, LessonEvent } from '@pen/contracts';
import { FakeLanguageModel, type FakeScript } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import type { LedgerSink } from '../src/room.js';
import { optionsSpoken, SessionRoom } from '../src/room.js';
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
 * A check-in the way a teacher does it (ADR-0050): the question, then the
 * options read out, then the card — and with check-ins off for this host,
 * neither the question nor the card, and the lesson runs straight through.
 */
const HOST = 'host-check-01';

class MemoryLedger implements LedgerSink {
  readonly entries: LedgerEntry[] = [];
  append(_sessionId: string, entry: LedgerEntry): void {
    this.entries.push(entry);
  }
  storeAudio(): string {
    return 'mem#0';
  }
}

const script: FakeScript = {
  match: (r) => r.purpose === 'lesson',
  gapMs: 2,
  events: [
    say('s1', 'Tokens first.'),
    say('s2', 'Quick check: what is a token?'),
    {
      type: 'check',
      id: 'c1',
      askedBy: 's2',
      options: ['A word piece.', 'A number'],
      expected: 'A word piece',
      explain: 'A token is a piece of text.',
    },
    say('s3', 'Good, moving on.'),
    { type: 'done' },
  ] as LessonEvent[],
};

async function liveRoom(checkIns: boolean) {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const room = new SessionRoom({
    sessionId: `sess-check-${checkIns ? 'on' : 'off'}`,
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo,
    model: new FakeLanguageModel(
      [script],
      [planCompletion(1), { purpose: 'recap', value: { points: ['Tokens'] } }],
    ),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    sampleRate: 44100,
    transport,
    acquirer: null,
    ledger: new MemoryLedger(),
    targetMinutes: 1,
    checkIns,
  });
  await room.start();
  return { room, transport, synthesizer };
}

const says = (t: MemoryTransport) =>
  t.cues().flatMap((c) => (c.event.type === 'say' ? [{ id: c.event.id, text: c.event.text }] : []));

describe('optionsSpoken', () => {
  it('reads the options out with a letter each and one full stop each', () => {
    expect(optionsSpoken(['A word piece.', 'A number', ' A position '])).toBe(
      'A: A word piece. B: A number. C: A position.',
    );
  });
});

describe('check-ins on', () => {
  it('reads the options after the question, and the card carries the question as asked', async () => {
    const { room, transport } = await liveRoom(true);
    await until(() => says(transport).some((s) => s.id === 'L0.s3'));
    // Announced, asked, options read: three sentences where the model wrote one.
    expect(says(transport).map((s) => s.id)).toEqual([
      'L0.s1',
      'L0.s2i',
      'L0.s2',
      'L0.s2o',
      'L0.s3',
    ]);
    expect(says(transport).find((s) => s.id === 'L0.s2i')?.text).toBe(
      "Quick check — let's see if that landed.",
    );
    expect(says(transport).find((s) => s.id === 'L0.s2o')?.text).toBe(
      'A: A word piece. B: A number.',
    );
    const check = transport.cues().find((c) => c.event.type === 'check')?.event;
    expect(check).toMatchObject({
      askedBy: 'L0.s2o',
      question: 'Quick check: what is a token?',
    });
    await room.end();
  });
});

describe('check-ins off', () => {
  it('drops the question and the check, and the lesson runs straight through', async () => {
    const { room, transport } = await liveRoom(false);
    await until(() => says(transport).some((s) => s.id === 'L0.s3'));
    expect(transport.cues().some((c) => c.event.type === 'check')).toBe(false);
    expect(says(transport).map((s) => s.id)).toEqual(['L0.s1', 'L0.s3']);
    await room.end();
  });
});
