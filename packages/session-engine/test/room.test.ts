import type {
  Cue,
  DownstreamAudioHeader,
  Expert,
  ServerMessage,
  SourceDocument,
} from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { createOnten } from '@pen/onten';
import { SilentSynthesizer } from '@pen/voice';
import { describe, expect, it } from 'vitest';
import { qualifyIds, SessionRoom } from '../src/room.js';
import type { RoomTransport } from '../src/transport.js';

const expert: Expert = {
  id: 'ada-okonkwo',
  displayName: 'Ada Okonkwo',
  role: 'Deep Learning Expert',
  tagline: 't',
  biography: 'b',
  specialties: ['transformers'],
  interactionStyle: 'warm',
  aiDisclosure: 'I am Ada, an AI expert.',
  provenance: 'fictional-synthetic',
  portrait: null,
  voiceId: 'af_heart',
  domain: 'computing-data',
  premium: false,
  gender: 'woman',
  voices: { en: 'voice-en' },
};

const rights = {
  redistribution: 'allowed' as const,
  authorizedAudiences: ['*'],
  ingestionAllowed: true,
  license: 'CC-BY-4.0',
  attribution: 'Open CS Textbook',
  policyRevision: '1',
  licenseText: '',
};
const doc: SourceDocument = {
  sourceId: 'attention-101',
  url: 'https://example.test/attention',
  title: 'Attention',
  mediaType: 'text/markdown',
  observedAt: Date.now(),
  rights,
  text: `# Tokens and vectors\n\nEach token becomes a vector, a list of numbers the model can move around. Position signals are added so order matters.\n\n# Queries keys and values\n\nAttention computes three projections of every vector: a query, a key and a value. The score is the query dotted with the key, scaled by the square root of d, then softmaxed so weights sum to one.\n\n# Why divide by sqrt d\n\nWithout scaling, dot products grow with vector length and softmax saturates into a hard max, so gradients stop flowing. Dividing by the square root of d keeps the scores in a useful range.\n\n# Multi-head attention\n\nSeveral heads run in parallel; each learns its own projection so one may track agreement while another watches punctuation. Their outputs are concatenated.\n`,
};

class MemoryTransport implements RoomTransport {
  messages: ServerMessage[] = [];
  audio: DownstreamAudioHeader[] = [];
  broadcast(m: ServerMessage) {
    this.messages.push(m);
  }
  send(_p: string, m: ServerMessage) {
    this.messages.push(m);
  }
  broadcastAudio(h: DownstreamAudioHeader) {
    this.audio.push(h);
  }
  cues(): Cue[] {
    return this.messages.flatMap((m) => (m.kind === 'cue' ? [m.cue] : []));
  }
  states() {
    return this.messages.flatMap((m) => (m.kind === 'state' ? [m.state] : []));
  }
}

const board = (id: string, anchor: string, text: string) => ({
  type: 'board' as const,
  id,
  anchor,
  op: 'write' as const,
  text,
  lang: '',
  ref: '',
  ref2: '',
  place: 'flow' as const,
  emphasis: 'ink' as const,
});
const say = (id: string, text: string) => ({
  type: 'say' as const,
  id,
  text,
  tone: 'warm' as const,
});

function fakeModel() {
  return new FakeLanguageModel(
    [
      {
        match: (r) =>
          r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 1:')),
        gapMs: 5,
        events: [
          say('s1', "Let's start with a sentence."),
          board('b1', 's1', 'the cat sat on the mat'),
          say('s2', 'Six tokens is everything the model sees at first.'),
          { type: 'done' },
        ],
      },
      {
        match: (r) =>
          r.purpose === 'lesson' && r.messages.some((m) => m.content.includes('SEGMENT 2:')),
        gapMs: 5,
        events: [
          say('s1', 'Each token becomes a vector.'),
          board('b1', 'after:s1', 'token → vector'),
          say('s2', 'Quick one: what is a vector here?'),
          {
            type: 'check',
            id: 'c1',
            askedBy: 's2',
            options: ['A word', 'A list of numbers', 'A position'],
            expected: 'A list of numbers',
            explain: 'A vector is just a list of numbers.',
          },
          { type: 'done' },
        ],
      },
      {
        match: (r) => r.purpose === 'turn',
        gapMs: 5,
        events: [
          {
            type: 'note',
            language: 'en-US',
            question: 'why divide by √d?',
            headline: 'keeps scores in range',
            detail: 'dot products grow with length',
          },
          say('s1', 'Without it the dot products get huge.'),
          say('s2', 'Okay, back to where we were.'),
          { type: 'done' },
        ],
      },
    ],
    [
      {
        purpose: 'plan',
        value: {
          title: 'How Transformers work',
          promise: 'Learn to read an attention diagram.',
          segments: [
            { title: 'Tokens', goal: 'See tokens as vectors', minutes: 1, hasCheck: false },
            { title: 'Vectors', goal: 'Vectors and positions', minutes: 1, hasCheck: true },
          ],
        },
      },
      {
        purpose: 'grade',
        value: { verdict: 'correct', feedback: 'Exactly that, a list of numbers. Nicely done.' },
      },
      {
        purpose: 'recap',
        value: { points: ['Tokens become vectors', 'Attention scores query against key'] },
      },
    ],
  );
}

async function preparedPack() {
  const onten = createOnten();
  const c = onten.compiler.startProgressiveCompilation({
    requestId: 'r',
    hostId: 'pen',
    canonicalKnowledgeId: 'en.how-transformers-work-in-llms',
    title: 'How Transformers Work in LLMs',
    scope: {
      conceptOrTopicBoundary: 'transformers',
      language: 'en',
      locale: 'en-US',
      domainBoundary: 'computing-data',
    },
    policy: onten.policy.expansion,
  });
  await c.addSource(doc);
  c.finishSources({
    development: [{ question: 'why divide by sqrt d', expectedUnitIds: [] }],
    negative: [{ question: 'bread', expectedUnitIds: [] }],
  });
  await c.background;
  return onten;
}

async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('qualifyIds', () => {
  it('prefixes ids and references with the thread', () => {
    const q = qualifyIds(board('b2', 'after:s3', 'x'), 'L1');
    expect(q.type === 'board' && q.id).toBe('L1.b2');
    expect(q.type === 'board' && q.anchor).toBe('after:L1.s3');
    expect(qualifyIds({ type: 'say', id: 's1', text: 'x', tone: 'warm' }, 't2')).toMatchObject({
      id: 't2.s1',
    });
  });
});

describe('SessionRoom', () => {
  it('teaches a prepared topic, handles an interrupt with a question, grades a check-in, and ends with a recap', async () => {
    const onten = await preparedPack();
    const transport = new MemoryTransport();
    const room = new SessionRoom({
      sessionId: 'sess-1',
      topic: 'How Transformers work in LLMs',
      host: { id: 'host-1234', name: 'Sam', plan: 'free' },
      expert,
      band: 'beginner',
      language: 'en',
      locale: 'en-US',
      onten,
      runtime: onten.newRuntime(),
      memo: onten.memo,
      model: fakeModel(),
      synthesizer: new SilentSynthesizer(),
      voice: 'v',
      sampleRate: 44100,
      transport,
      acquirer: null,
      targetMinutes: 2,
    });
    await room.start();
    expect(room.getState().phase).toBe('live');
    expect(room.getState().plan?.segments).toHaveLength(2);

    // Segment 1 streams; audio for its says arrives tagged with qualified ids.
    await until(() => transport.cues().filter((c) => c.segment === 0).length >= 3);
    const seg0 = transport.cues().filter((c) => c.segment === 0);
    expect(seg0[0]?.event).toMatchObject({ type: 'say', id: 'L0.s1' });
    expect(seg0[1]?.event).toMatchObject({ type: 'board', anchor: 'L0.s1' });
    await until(() => transport.audio.some((h) => h.sayId === 'L0.s1' && h.final));
    // Segment 2 is not generated until the host reports hearing segment 1.
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.cues().some((c) => c.segment === 1)).toBe(false);

    // Learner interrupts mid-sentence with a question.
    room.handle('host-1234', { kind: 'progress', seq: 0, clockMs: 2000 });
    room.handle('host-1234', { kind: 'interrupt', atSeq: 2, sayId: 'L0.s2', offsetMs: 900 });
    expect(room.getState().mode).toBe('listening');
    expect(room.getState().resume).toMatchObject({ sayId: 'L0.s2', offsetMs: 900 });
    room.handle('host-1234', {
      kind: 'transcript',
      utteranceId: 'u1',
      text: 'why do we divide by the square',
      final: false,
    });
    room.handle('host-1234', {
      kind: 'transcript',
      utteranceId: 'u1',
      text: 'Why do we divide by the square root of d?',
      final: true,
    });
    await until(() => transport.cues().some((c) => c.thread === 't1' && c.event.type === 'note'));
    const turnCues = transport.cues().filter((c) => c.thread === 't1');
    // Acknowledgement first (instant), then the note, then the answer sentences.
    expect(turnCues[0]?.event.type).toBe('say');
    expect(turnCues.map((c) => c.event.type)).toContain('note');
    await until(() => transport.audio.some((h) => h.sayId === 't1.s2' && h.final));
    expect(room.getState().mode).toBe('answering');
    // Host conductor finished playing the answer → lesson resumes from the interrupted sentence with a new take.
    await until(() => transport.messages.some((m) => m.kind === 'turn_done' && m.thread === 't1'));
    for (const c of transport.cues().filter((c) => c.thread === 't1' && c.event.type === 'say'))
      room.handle('host-1234', { kind: 'progress', seq: c.seq, clockMs: 3000 });
    room.handle('host-1234', { kind: 'resumed' });
    expect(room.getState().mode).toBe('teaching');
    expect(
      transport.messages.some((m) => m.kind === 'say_take' && m.sayId === 'L0.s2' && m.take === 1),
    ).toBe(true);
    await until(() => transport.audio.some((h) => h.sayId === 'L0.s2' && h.take === 1 && h.final));

    // Host hears segment 1 → segment 2 generates, including a check-in.
    room.handle('host-1234', { kind: 'progress', seq: 2, clockMs: 6000 });
    await until(() => transport.cues().some((c) => c.event.type === 'check'));
    const check = transport.cues().find((c) => c.event.type === 'check');
    expect(check?.event).toMatchObject({ id: 'L1.c1', askedBy: 'L1.s2' });
    room.handle('host-1234', { kind: 'progress', seq: check?.seq ?? 0, clockMs: 9000 });
    expect(room.getState().mode).toBe('checking');
    room.handle('host-1234', { kind: 'check_answer', checkId: 'L1.c1', text: 'a list of numbers' });
    await until(() => transport.messages.some((m) => m.kind === 'check_result'));
    expect(transport.messages.find((m) => m.kind === 'check_result')).toMatchObject({
      verdict: 'correct',
    });

    await room.end();
    expect(room.getState().phase).toBe('ended');
    expect(room.getState().recap).toEqual([
      'Tokens become vectors',
      'Attention scores query against key',
    ]);
    // The memo now holds the taught lesson for the next learner of this topic and band.
    const memo = await onten.memo.find('en.how-transformers-work-in-llms', 'beginner');
    expect(memo?.cuesBySegment.length).toBe(2);
  });

  it('refuses guests on the free plan and enforces host-only controls', async () => {
    const onten = await preparedPack();
    const transport = new MemoryTransport();
    const room = new SessionRoom({
      sessionId: 'sess-2',
      topic: 'How Transformers work in LLMs',
      host: { id: 'host-9999', name: 'Sam', plan: 'free' },
      expert,
      band: 'beginner',
      language: 'en',
      locale: 'en-US',
      onten,
      runtime: onten.newRuntime(),
      memo: onten.memo,
      model: fakeModel(),
      synthesizer: new SilentSynthesizer(),
      voice: 'v',
      sampleRate: 44100,
      transport,
      acquirer: null,
    });
    expect(room.join({ id: 'guest-0001', name: 'Kim' })).toMatchObject({
      ok: false,
      code: 'ENTITLEMENT_REQUIRED',
    });
    const classroom = new SessionRoom({
      sessionId: 'sess-3',
      topic: 'How Transformers work in LLMs',
      host: { id: 'host-9999', name: 'Sam', plan: 'professional' },
      expert,
      band: 'beginner',
      language: 'en',
      locale: 'en-US',
      onten,
      runtime: onten.newRuntime(),
      memo: onten.memo,
      model: fakeModel(),
      synthesizer: new SilentSynthesizer(),
      voice: 'v',
      sampleRate: 44100,
      transport,
      acquirer: null,
    });
    expect(classroom.join({ id: 'guest-0001', name: 'Kim' })).toMatchObject({ ok: true });
    await classroom.start();
    classroom.handle('guest-0001', { kind: 'control', action: 'pause' });
    expect(transport.messages.at(-1)).toMatchObject({ kind: 'error', code: 'NOT_HOST' });
    classroom.handle('host-9999', { kind: 'control', action: 'pause' });
    expect(classroom.getState().mode).toBe('paused');
    await classroom.end();
  });
});

describe('spokenText', () => {
  it('strips markdown before the voice hears it', async () => {
    const { spokenText } = await import('../src/speech.js');
    expect(spokenText('For example, `"Hello"` is text, while `42` is a **whole** number.')).toBe(
      'For example, "Hello" is text, while 42 is a whole number.',
    );
    expect(spokenText('See https://docs.swift.org/x for more.')).toBe(
      'See the link on the board for more.',
    );
  });
});
