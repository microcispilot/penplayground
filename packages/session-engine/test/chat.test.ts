import type { LedgerEntry } from '@pen/contracts';
import { CHAT_MAX_CHARS, CHAT_MIN_INTERVAL_MS } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import { SessionMetrics } from '../src/metrics.js';
import { type KnowledgeAcquirer, SessionRoom } from '../src/room.js';
import {
  CANONICAL_ID,
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  segmentScript,
  until,
} from './fixtures.js';

/**
 * Chat is between the people in the room. The expert never sees it.
 *
 * The owner: *"the chat is only between participants and the expert never
 * sees that and never care and this should not interrupt the session."*
 *
 * That is not a rule the panel enforces — a UI rule would be one refactor
 * away from being wrong. It is enforced here, in the room, by `chat()` doing
 * nothing except broadcast: no floor, no plan, no pipeline, no model. These
 * tests are written as *absences*, because the absences are the feature.
 *
 * Asking the expert something is still speaking (`transcript`), the way a
 * person interrupts a person.
 */

const HOST = 'host-1234';
const GUEST = 'guest-5678';
const SEGMENTS = 4;

async function makeRoom(opts: { sessionId: string; now: () => number }) {
  const { onten, packId, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const hit = await onten.registry.resolveTopic({
    text: 'How Transformers work in LLMs',
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  const acquirer: KnowledgeAcquirer = {
    async prepare() {
      return { packId, provisional: false, background: Promise.resolve(null) };
    },
  };
  const entries: LedgerEntry[] = [];
  const room = new SessionRoom({
    sessionId: opts.sessionId,
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    resolution: { ...hit, canonicalKnowledgeId: CANONICAL_ID },
    onten,
    runtime: onten.newRuntime(),
    memo,
    model: new FakeLanguageModel(
      Array.from({ length: SEGMENTS }, (_, i) => segmentScript(i + 1)),
      [planCompletion(SEGMENTS), { purpose: 'recap', value: { points: ['x'] } }],
    ),
    synthesizer: new SilentSynthesizer(),
    voice: 'v',
    sampleRate: 44100,
    transport,
    acquirer,
    targetMinutes: 4,
    now: opts.now,
    metrics: new SessionMetrics({
      sessionId: opts.sessionId,
      startedAt: 0,
      ledger: { append: (_id, entry) => void entries.push(entry) },
    }),
  });
  return { room, transport, entries };
}

const chats = (t: MemoryTransport) => t.messages.flatMap((m) => (m.kind === 'chat' ? [m] : []));

describe('SessionRoom chat', () => {
  it('broadcasts one line, stamped and named, to everyone including its sender', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat', now: () => clock });
    await room.start();

    room.handle(HOST, { kind: 'chat', text: 'can you see the board?' });
    expect(chats(transport)).toEqual([
      {
        kind: 'chat',
        participantId: HOST,
        name: 'Sam',
        text: 'can you see the board?',
        at: clock,
      },
    ]);
    await room.end();
  });

  /**
   * The whole point, stated as the four things that must not happen. If any
   * of these ever starts happening, chat has become a question again.
   */
  it('does not interrupt the lesson: no floor, no mode change, no cue, no model call', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat-quiet', now: () => clock });
    await room.start();
    await until(() => transport.cues().filter((c) => c.thread === 'lesson').length >= 2);

    const before = room.getState();
    const cuesBefore = transport.cues().length;
    room.handle(HOST, { kind: 'chat', text: 'wait, why is that?' });

    const after = room.getState();
    expect(after.mode, 'the expert keeps teaching').toBe(before.mode);
    expect(after.floor, 'nobody took the floor').toBe(before.floor);
    expect(after.segment).toBe(before.segment);
    // A question would have produced an `answer` thread; chat produces nothing.
    expect(transport.cues().filter((c) => c.thread === 'answer')).toEqual([]);
    expect(transport.cues().length, 'no cue was emitted for it').toBe(cuesBefore);
    await room.end();
  });

  it('is counted for the statistics and never stored as words', async () => {
    const clock = 1_800_000_000_000;
    const { room, entries } = await makeRoom({ sessionId: 'sess-chat-ledger', now: () => clock });
    await room.start();

    room.handle(HOST, { kind: 'chat', text: 'something private between us' });
    const sent = entries.flatMap((e) =>
      e.kind === 'interaction' && e.interaction.event === 'chat_sent' ? [e.interaction] : [],
    );
    expect(sent.map((i) => [i.participantId, i.props])).toEqual([[HOST, { chars: 28 }]]);
    // CLAUDE.md: never log transcripts or spoken text. Chat is neither more
    // nor less private than speech, so the ledger holds a length and no words.
    expect(JSON.stringify(entries)).not.toContain('something private');
    await room.end();
  });

  it('drops a flood in silence and takes the next line after', async () => {
    let clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat-rate', now: () => clock });
    await room.start();

    room.handle(HOST, { kind: 'chat', text: 'one' });
    clock += CHAT_MIN_INTERVAL_MS - 1;
    room.handle(HOST, { kind: 'chat', text: 'two' });
    room.handle(HOST, { kind: 'chat', text: 'three' });
    expect(chats(transport).map((c) => c.text)).toEqual(['one']);
    // Silently: typing fast is not an error anyone should be told about.
    expect(transport.messages.filter((m) => m.kind === 'error')).toEqual([]);

    clock += 1;
    room.handle(HOST, { kind: 'chat', text: 'two' });
    expect(chats(transport).map((c) => c.text)).toEqual(['one', 'two']);
    await room.end();
  });

  it('each participant has their own pace, so one person cannot mute another', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat-two', now: () => clock });
    await room.start();
    room.join({ id: GUEST, name: 'Kim' });

    room.handle(HOST, { kind: 'chat', text: 'from the host' });
    room.handle(GUEST, { kind: 'chat', text: 'from the guest' });
    expect(chats(transport).map((c) => [c.participantId, c.name, c.text])).toEqual([
      [HOST, 'Sam', 'from the host'],
      [GUEST, 'Kim', 'from the guest'],
    ]);
    await room.end();
  });

  it('trims, caps and refuses a line with nothing in it', async () => {
    let clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat-shape', now: () => clock });
    await room.start();

    room.handle(HOST, { kind: 'chat', text: '   spaced   ' });
    clock += CHAT_MIN_INTERVAL_MS;
    room.handle(HOST, { kind: 'chat', text: '   ' });
    clock += CHAT_MIN_INTERVAL_MS;
    room.handle(HOST, { kind: 'chat', text: 'x'.repeat(CHAT_MAX_CHARS + 50) });

    const sent = chats(transport).map((c) => c.text);
    expect(sent[0]).toBe('spaced');
    expect(sent, 'whitespace alone is not a line').toHaveLength(2);
    expect(sent[1]?.length).toBe(CHAT_MAX_CHARS);
    await room.end();
  });

  it('says nothing once the room has ended', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-chat-ended', now: () => clock });
    await room.start();
    await room.end();

    room.handle(HOST, { kind: 'chat', text: 'anybody there?' });
    expect(chats(transport)).toEqual([]);
  });
});
