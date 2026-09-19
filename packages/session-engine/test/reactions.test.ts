import type { LedgerEntry } from '@pen/contracts';
import { REACTION_MIN_INTERVAL_MS } from '@pen/contracts';
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
  sleep,
  until,
} from './fixtures.js';

const HOST = 'host-1234';
const SEGMENTS = 4;
const TAG = 'https://ads.example.test/vast?slot=pen';

/** The room under test, with a clock the test drives so the 600 ms rule is exact. */
async function makeRoom(opts: { sessionId: string; ads?: boolean; now: () => number }) {
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
    host: { id: HOST, name: 'Sam', plan: 'free' },
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
    ...(opts.ads
      ? {
          ads: {
            everySegments: 1,
            durationMs: 15_000,
            skippableAfterMs: 5_000,
            tagUrl: TAG,
          },
        }
      : {}),
  });
  return { room, transport, entries };
}

const reactions = (t: MemoryTransport) =>
  t.messages.flatMap((m) => (m.kind === 'reaction' ? [m] : []));

describe('SessionRoom reactions', () => {
  it('broadcasts one, stamped, to everyone — and records it as an interaction', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport, entries } = await makeRoom({
      sessionId: 'sess-react',
      now: () => clock,
    });
    await room.start();

    room.handle(HOST, { kind: 'reaction', emoji: '👏' });
    expect(reactions(transport)).toEqual([
      { kind: 'reaction', participantId: HOST, emoji: '👏', at: clock },
    ]);
    const sent = entries.flatMap((e) =>
      e.kind === 'interaction' && e.interaction.event === 'reaction_sent' ? [e.interaction] : [],
    );
    expect(sent.map((i) => [i.participantId, i.props])).toEqual([[HOST, { emoji: '👏' }]]);
    await room.end();
  });

  it('drops a second one inside 600 ms without a word, and takes the next one after', async () => {
    let clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-react-rate', now: () => clock });
    await room.start();

    room.handle(HOST, { kind: 'reaction', emoji: '👍' });
    clock += REACTION_MIN_INTERVAL_MS - 1;
    room.handle(HOST, { kind: 'reaction', emoji: '🔥' });
    room.handle(HOST, { kind: 'reaction', emoji: '🎉' });
    expect(reactions(transport).map((r) => r.emoji)).toEqual(['👍']);
    // Silently: a held-down key is not an error the learner should be told about.
    expect(transport.messages.filter((m) => m.kind === 'error')).toEqual([]);

    clock += 1;
    room.handle(HOST, { kind: 'reaction', emoji: '🔥' });
    expect(reactions(transport).map((r) => r.emoji)).toEqual(['👍', '🔥']);
    await room.end();
  });

  it('refuses a reaction from behind an ad, through the same window as voice and chat', async () => {
    let clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({
      sessionId: 'sess-react-ad',
      ads: true,
      now: () => clock,
    });
    await room.start();

    // Teach to the boundary the room hangs its first ad on, then reach it.
    for (let i = 0; i <= 1; i++) {
      await until(
        () => transport.cues().filter((c) => c.thread === 'lesson' && c.segment === i).length >= 2,
      );
      const last = Math.max(
        ...transport
          .cues()
          .filter((c) => c.thread === 'lesson' && c.segment === i)
          .map((c) => c.seq),
      );
      room.handle(HOST, { kind: 'progress', seq: last, clockMs: 1000 * (i + 1) });
    }
    await until(() => transport.ads().length > 0);
    const ad = transport.ads()[0];
    if (!ad) throw new Error('no ad was scheduled');
    room.handle(HOST, { kind: 'progress', seq: ad.afterSeq, clockMs: 9_000 });

    // The window only counts while nobody holds the floor: a learner being
    // listened to, thought about or answered never sees an ad, so those modes
    // are deliberately not ad windows. This used to be raced rather than
    // waited for — CI reached the progress message while the room was still on
    // the floor, the window never opened, and the refusal below failed as if
    // the gate had leaked. Wait for the state the test is actually about, and
    // name it if it never comes.
    const holdsFloor = () => ['listening', 'thinking', 'answering'].includes(room.getState().mode);
    await until(() => !holdsFloor()).catch(() => {
      throw new Error(`the room stayed on the floor ("${room.getState().mode}"): no ad window`);
    });

    room.handle(HOST, { kind: 'reaction', emoji: '😕' });
    expect(reactions(transport)).toEqual([]);

    // The ad ends; expression comes back with everything else.
    room.handle(HOST, { kind: 'ad_event', adId: ad.adId, event: 'ad_skipped', atMs: 5_200 });
    clock += REACTION_MIN_INTERVAL_MS;
    room.handle(HOST, { kind: 'reaction', emoji: '😕' });
    expect(reactions(transport).map((r) => r.emoji)).toEqual(['😕']);
    await sleep(10);
    await room.end();
  });

  it('is not an interrupt: it never touches the floor, the mode or the lesson', async () => {
    const clock = 1_800_000_000_000;
    const { room, transport } = await makeRoom({ sessionId: 'sess-react-quiet', now: () => clock });
    await room.start();
    await until(() => transport.cues().length > 0);
    const before = {
      mode: room.getState().mode,
      floor: room.getState().floor,
      resume: room.getState().resume,
      cues: transport.cues().length,
    };
    room.handle(HOST, { kind: 'reaction', emoji: '❤️' });
    await sleep(20);
    expect(room.getState().mode).toBe(before.mode);
    expect(room.getState().floor).toBe(before.floor);
    expect(room.getState().resume).toEqual(before.resume);
    // Nothing was said, cancelled or re-spoken because somebody tapped a heart.
    expect(transport.messages.filter((m) => m.kind === 'say_take')).toEqual([]);
    await room.end();
  });
});
