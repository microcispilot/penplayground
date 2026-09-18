import { FakeLanguageModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import { SessionRoom } from '../src/room.js';
import {
  CANONICAL_ID,
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  SpySynthesizer,
  segmentScript,
  until,
  voiceFor,
} from './fixtures.js';

/**
 * Where the line falls between what a session may reuse and what belongs to
 * the learner who sat through it (ADR-0017).
 *
 * The lesson is the same for everyone who asks for this topic, so its
 * sentences are marked as a lesson's and may be stored beside it. A question,
 * the answer composed for it, a check-in verdict, an honest line about a
 * failure — those are this person's session. They carry no lesson mark, so the
 * store never sees them, whatever they happen to say.
 */

const HOST = 'host-1234';

async function liveRoom() {
  const { onten } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const room = new SessionRoom({
    sessionId: 'sess-boundary',
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
      [segmentScript(1, 2)],
      [planCompletion(1), { purpose: 'recap', value: { points: ['Tokens become vectors'] } }],
    ),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    sampleRate: 44100,
    transport,
    acquirer: null,
    targetMinutes: 1,
  });
  return { room, transport, synthesizer };
}

describe('what a session may reuse', () => {
  it('marks the taught lesson as the lesson it belongs to', async () => {
    const { room, synthesizer } = await liveRoom();
    await room.start();
    await until(() => synthesizer.requests.length >= 2);

    for (const request of synthesizer.requests) {
      expect(request.lesson, request.text).toBeDefined();
      expect(request.lesson).toMatchObject({
        canonicalId: CANONICAL_ID,
        band: 'beginner',
        expertId: expert.id,
      });
      // The sentence's own id, so a re-written sentence retires only itself.
      expect(request.lesson?.sayId).toMatch(/^L\d+\.s\d+$/);
    }
    await room.end();
  });

  it('never marks a learner’s question, its answer, or a check-in verdict', async () => {
    const { room, synthesizer } = await liveRoom();
    await room.start();
    await until(() => synthesizer.requests.length >= 1);
    const lessonSentences = synthesizer.requests.length;

    // The learner interrupts and asks something. Everything the expert says
    // back is composed for them.
    room.handle(HOST, { kind: 'interrupt', atSeq: 0, sayId: null, offsetMs: 0 });
    room.handle(HOST, {
      kind: 'transcript',
      utteranceId: 'u1',
      text: 'Why do we divide by the square root of d?',
      final: true,
    });
    await until(() => synthesizer.requests.length > lessonSentences, 8000);

    const answer = synthesizer.requests.slice(lessonSentences);
    expect(answer.length).toBeGreaterThan(0);
    for (const request of answer)
      expect(request.lesson, `answered: ${request.text}`).toBeUndefined();
    await room.end();
  }, 15_000);

  it('keeps the lesson mark stable, so a second learner hears the stored take', async () => {
    // Two rooms, same topic, same band, same expert: the same marks, so the
    // second one finds what the first one paid for.
    const first = await liveRoom();
    await first.room.start();
    await until(() => first.synthesizer.requests.length >= 2);
    const second = await liveRoom();
    await second.room.start();
    await until(() => second.synthesizer.requests.length >= 2);

    const marks = (s: SpySynthesizer) =>
      s.requests
        .filter((r) => r.lesson)
        .map((r) => `${r.lesson?.canonicalId}/${r.lesson?.band}/${r.lesson?.expertId}`);
    expect(new Set(marks(second.synthesizer))).toEqual(new Set(marks(first.synthesizer)));
    await first.room.end();
    await second.room.end();
  }, 15_000);
});
