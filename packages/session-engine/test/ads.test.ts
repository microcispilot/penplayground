import type { PlanCode } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
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
const SEGMENTS = 6;
const ADS = { everySegments: 2, durationMs: 15_000, skippableAfterMs: 5_000 };

function model() {
  return new FakeLanguageModel(
    Array.from({ length: SEGMENTS }, (_, i) => segmentScript(i + 1)),
    [planCompletion(SEGMENTS), { purpose: 'recap', value: { points: ['x'] } }],
  );
}

async function makeRoom(opts: { plan: PlanCode; miss: boolean; sessionId: string }) {
  const { onten, packId } = await preparedPack();
  const transport = new MemoryTransport();
  const hit = await onten.registry.resolveTopic({
    text: 'How Transformers work in LLMs',
    language: 'en',
    locale: 'en-US',
    band: 'beginner',
  });
  expect(hit.match).toBe('hit');
  const prepare = { calls: 0, adsWhenCalled: -1, adsWhenResolved: -1 };
  const acquirer: KnowledgeAcquirer = {
    async prepare() {
      prepare.calls += 1;
      prepare.adsWhenCalled = transport.ads().length;
      await sleep(60);
      prepare.adsWhenResolved = transport.ads().length;
      return { packId, provisional: false, background: Promise.resolve(null) };
    },
  };
  const room = new SessionRoom({
    sessionId: opts.sessionId,
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: opts.plan },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    resolution: opts.miss
      ? { ...hit, match: 'miss', packId: null, lessonMemoId: null, score: 0 }
      : { ...hit, canonicalKnowledgeId: CANONICAL_ID },
    onten,
    runtime: onten.newRuntime(),
    memo: onten.memo,
    model: model(),
    synthesizer: new SilentSynthesizer(),
    voice: 'v',
    sampleRate: 44100,
    transport,
    acquirer,
    targetMinutes: 6,
    ads: ADS,
  });
  return { room, transport, prepare };
}

/** Plays the whole lesson as the host would: report each segment heard so the next one generates. */
async function teachAll(room: SessionRoom, transport: MemoryTransport): Promise<number[]> {
  const lastSeq: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    await until(
      () => transport.cues().filter((c) => c.thread === 'lesson' && c.segment === i).length >= 2,
    );
    const seqs = transport
      .cues()
      .filter((c) => c.thread === 'lesson' && c.segment === i)
      .map((c) => c.seq);
    const last = Math.max(...seqs);
    lastSeq[i] = last;
    room.handle(HOST, { kind: 'progress', seq: last, clockMs: 1000 * (i + 1) });
  }
  return lastSeq;
}

describe('SessionRoom ad budget', () => {
  it('shows a card only at segment boundaries 2 and 4 of a prepared six-segment lesson', async () => {
    const { room, transport, prepare } = await makeRoom({
      plan: 'free',
      miss: false,
      sessionId: 'sess-a',
    });
    await room.start();
    expect(room.getState().plan?.segments).toHaveLength(SEGMENTS);
    expect(prepare.calls).toBe(0);
    expect(transport.ads()).toEqual([]);

    const lastSeq = await teachAll(room, transport);
    await sleep(50);
    const ads = transport.ads();
    expect(ads.map((a) => a.afterSeq)).toEqual([lastSeq[2], lastSeq[4]]);
    expect(ads.map((a) => a.adId)).toEqual(['ad-sess-a-1', 'ad-sess-a-2']);
    expect(ads[0]).toMatchObject({ skippableAfterMs: 5_000, durationMs: 15_000 });
    // Never before the first sentence, never after the last segment.
    const firstCue = transport.messages.findIndex((m) => m.kind === 'cue');
    const firstAd = transport.messages.findIndex((m) => m.kind === 'ad');
    expect(firstAd).toBeGreaterThan(firstCue);
    const lastSegmentStart = transport.messages.findIndex(
      (m) => m.kind === 'cue' && m.cue.segment === SEGMENTS - 1,
    );
    const lastAd = transport.messages.findLastIndex((m) => m.kind === 'ad');
    expect(lastAd).toBeLessThan(lastSegmentStart);
    // The card is broadcast right after its segment's last cue, before the next segment starts.
    const seg3Start = transport.messages.findIndex((m) => m.kind === 'cue' && m.cue.segment === 3);
    expect(firstAd).toBeLessThan(seg3Start);
    await room.end();
  });

  it('on a topic miss shows the preparation card first and skips the first boundary card', async () => {
    const { room, transport, prepare } = await makeRoom({
      plan: 'free',
      miss: true,
      sessionId: 'sess-b',
    });
    await room.start();
    expect(room.getState().phase).toBe('live');
    expect(prepare.calls).toBe(1);
    // The card was already on its way to the learner when acquisition started.
    expect(prepare.adsWhenCalled).toBe(1);
    expect(prepare.adsWhenResolved).toBe(1);
    expect(transport.ads()[0]).toEqual({
      kind: 'ad',
      adId: 'ad-sess-b-prep',
      afterSeq: -1,
      skippableAfterMs: 5_000,
      durationMs: 15_000,
    });
    await until(() => transport.messages.some((m) => m.kind === 'cue'));
    const prepAt = transport.messages.findIndex((m) => m.kind === 'ad');
    const firstCue = transport.messages.findIndex((m) => m.kind === 'cue');
    expect(prepAt).toBeGreaterThanOrEqual(0);
    expect(prepAt).toBeLessThan(firstCue);

    const lastSeq = await teachAll(room, transport);
    await sleep(50);
    const ads = transport.ads();
    expect(ads.map((a) => a.afterSeq)).toEqual([-1, lastSeq[4]]);
    expect(ads.map((a) => a.adId)).toEqual(['ad-sess-b-prep', 'ad-sess-b-2']);
    expect(ads.some((a) => a.afterSeq === lastSeq[2])).toBe(false);
    await room.end();
  });

  it('never sends a card to a standard-plan host, prepared or not', async () => {
    const miss = await makeRoom({ plan: 'standard', miss: true, sessionId: 'sess-c' });
    await miss.room.start();
    expect(miss.prepare.calls).toBe(1);
    expect(miss.prepare.adsWhenCalled).toBe(0);
    await teachAll(miss.room, miss.transport);
    await sleep(50);
    expect(miss.transport.ads()).toEqual([]);
    await miss.room.end();

    const hit = await makeRoom({ plan: 'standard', miss: false, sessionId: 'sess-d' });
    await hit.room.start();
    await teachAll(hit.room, hit.transport);
    await sleep(50);
    expect(hit.transport.ads()).toEqual([]);
    await hit.room.end();
  });
});
