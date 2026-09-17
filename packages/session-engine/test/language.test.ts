import { FakeLanguageModel, type FakeScript } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import { acknowledgement, bridgeBack } from '../src/brain.js';
import { SessionRoom } from '../src/room.js';
import {
  expert,
  MemoryTransport,
  planCompletion,
  preparedPack,
  SpySynthesizer,
  say,
  segmentScript,
  until,
  voiceFor,
} from './fixtures.js';

const HOST = 'host-1234';
const SPANISH_ACKS = /^(Buena pregunta\.|Ah, muy buena\.|Claro, te lo explico\.)$/;
const SPANISH_BRIDGES = /volvamos a donde estábamos|Sigamos donde lo dejamos/;
const ENGLISH_BRIDGES = /back to where we were|picking up where we stopped|Back to it/;

/** One-segment lesson; the turn answers with a `note` in `noteLanguage` (or no turn script at all). */
function model(noteLanguage: string | null) {
  const scripts: FakeScript[] = [segmentScript(1)];
  if (noteLanguage)
    scripts.push({
      match: (r) => r.purpose === 'turn',
      gapMs: 2,
      events: [
        {
          type: 'note',
          language: noteLanguage,
          question: 'why divide by √d?',
          headline: 'keeps scores in range',
          detail: 'dot products grow with length',
        },
        say('s1', 'Without it the dot products get huge.'),
        { type: 'done' },
      ],
    });
  return new FakeLanguageModel(scripts, [
    planCompletion(1),
    { purpose: 'recap', value: { points: ['Tokens become vectors'] } },
  ]);
}

async function liveRoom(opts: { detected: string | null; noteLanguage: string | null }) {
  const { onten } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const room = new SessionRoom({
    sessionId: 'sess-lang',
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'free' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo: onten.memo,
    model: model(opts.noteLanguage),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    languageOf: () => opts.detected,
    sampleRate: 44100,
    transport,
    acquirer: null,
    targetMinutes: 1,
  });
  await room.start();
  expect(room.getState().phase).toBe('live');
  await until(() => transport.cues().filter((c) => c.segment === 0).length >= 2);
  return { room, transport, synthesizer };
}

/** Barge in on the second lesson sentence and ask `text`. */
function ask(room: SessionRoom, text: string) {
  room.handle(HOST, { kind: 'progress', seq: 0, clockMs: 1000 });
  room.handle(HOST, { kind: 'interrupt', atSeq: 1, sayId: 'L0.s2', offsetMs: 300 });
  expect(room.getState().mode).toBe('listening');
  room.handle(HOST, { kind: 'transcript', utteranceId: 'u1', text, final: true });
}

describe('acknowledgement()', () => {
  it('speaks in the learner language, cycles by seed and ignores the region', () => {
    expect(acknowledgement('question', 1, 'es-ES')).toMatch(SPANISH_ACKS);
    expect(acknowledgement('question', 1, 'es')).toBe(acknowledgement('question', 1, 'ES-mx'));
    expect(acknowledgement('question', 0, 'es')).not.toBe(acknowledgement('question', 1, 'es'));
    expect(acknowledgement('question', 3, 'es')).toBe(acknowledgement('question', 0, 'es'));
    expect(acknowledgement('clarify', 0, 'fa-IR')).toBe('حتماً.');
    expect(acknowledgement('answer', 1)).toBe('Let me see.');
  });

  it('returns null for a language without a table instead of an English line', () => {
    expect(acknowledgement('question', 1, 'sw-KE')).toBeNull();
    expect(acknowledgement('clarify', 0, 'xx')).toBeNull();
    expect(acknowledgement('answer', 2, 'tlh')).toBeNull();
  });
});

describe('bridgeBack()', () => {
  it('is localised, cycles by seed, tolerates negative seeds and falls back to English', () => {
    expect(bridgeBack(0, 'es-ES')).toMatch(SPANISH_BRIDGES);
    expect(bridgeBack(1, 'es-ES')).toMatch(SPANISH_BRIDGES);
    expect(bridgeBack(0, 'es-ES')).not.toBe(bridgeBack(1, 'es-ES'));
    expect(bridgeBack(2, 'es-ES')).toBe(bridgeBack(0, 'es-ES'));
    expect(bridgeBack(-1, 'es-ES')).toBe(bridgeBack(1, 'es-ES'));
    expect(bridgeBack(7, 'fa-IR')).toBe('خب، برگردیم به جایی که بودیم.');
    expect(bridgeBack(0)).toMatch(ENGLISH_BRIDGES);
    expect(bridgeBack(4, 'sw-KE')).toMatch(ENGLISH_BRIDGES);
    expect(bridgeBack(4, 'sw-KE')).toBe(bridgeBack(4, 'en'));
  });
});

describe('SessionRoom language following', () => {
  it('switches to Spanish before the acknowledgement, says it in Spanish with the es voice', async () => {
    const { room, transport, synthesizer } = await liveRoom({
      detected: 'es-ES',
      noteLanguage: 'es-ES',
    });
    ask(room, '¿Por qué dividimos por la raíz cuadrada de d?');
    await until(() => transport.cues().some((c) => c.thread === 't1' && c.event.type === 'say'));

    const messages = transport.messages;
    const switchedAt = messages.findIndex(
      (m) => m.kind === 'state' && m.state.language === 'es-ES',
    );
    const ackAt = messages.findIndex((m) => m.kind === 'cue' && m.cue.thread === 't1');
    expect(switchedAt).toBeGreaterThanOrEqual(0);
    expect(switchedAt).toBeLessThan(ackAt);
    expect(room.getState().language).toBe('es-ES');

    const ack = transport.cues().find((c) => c.thread === 't1');
    if (ack?.event.type !== 'say') throw new Error('first turn cue is not the acknowledgement');
    expect(ack.event.id).toBe('t1.s0');
    expect(ack.event.text).toBe(acknowledgement('question', 1, 'es-ES'));
    expect(ack.event.text).toMatch(SPANISH_ACKS);

    await until(
      () => synthesizer.voicesFor(ack.event.type === 'say' ? ack.event.text : '').length > 0,
    );
    expect(synthesizer.voicesFor(ack.event.text)).toEqual([voiceFor('es-ES')]);
    expect(voiceFor('es-ES')).toBe('voice-es');
    await room.end();
  });

  it("follows the model's note language: fa voice for the answer and for the resumed lesson", async () => {
    const { room, transport, synthesizer } = await liveRoom({
      detected: null,
      noteLanguage: 'fa-IR',
    });
    // The lesson so far was voiced in English.
    await until(() => synthesizer.voicesFor('Segment 1, first sentence.').length > 0);
    expect(synthesizer.voicesFor('Segment 1, first sentence.')).toEqual(['voice-en']);

    ask(room, 'Why do we divide by the square root of d?');
    await until(() => transport.messages.some((m) => m.kind === 'turn_done' && m.thread === 't1'));
    expect(room.getState().language).toBe('fa-IR');
    expect(transport.states().some((s) => s.language === 'fa-IR')).toBe(true);

    // The acknowledgement was spoken before the note arrived, so it kept the English voice.
    const turnSays = transport
      .cues()
      .filter((c) => c.thread === 't1')
      .flatMap((c) => (c.event.type === 'say' ? [c.event] : []));
    const ack = turnSays.find((s) => s.id === 't1.s0');
    const answer = turnSays.find((s) => s.id === 't1.s1');
    if (!ack || !answer) throw new Error('turn cues missing');
    expect(ack.text).toBe(acknowledgement('question', 1, 'en-US'));
    await until(() => synthesizer.voicesFor(answer.text).length > 0);
    expect(synthesizer.voicesFor(ack.text)).toEqual(['voice-en']);
    expect(synthesizer.voicesFor(answer.text)).toEqual(['voice-fa']);

    // Host finished hearing the answer → the lesson resumes from L0.s2, now in the fa voice.
    for (const c of transport.cues().filter((c) => c.thread === 't1' && c.event.type === 'say'))
      room.handle(HOST, { kind: 'progress', seq: c.seq, clockMs: 3000 });
    room.handle(HOST, { kind: 'resumed' });
    expect(room.getState().mode).toBe('teaching');
    await until(() => synthesizer.voicesFor('Segment 1, second sentence.').includes('voice-fa'));
    expect(synthesizer.voicesFor('Segment 1, second sentence.').at(-1)).toBe('voice-fa');
    expect(
      transport.messages.some((m) => m.kind === 'say_take' && m.sayId === 'L0.s2' && m.take === 1),
    ).toBe(true);
    await room.end();
  });

  it('stays silent instead of acknowledging in English when the language has no table', async () => {
    const { room, transport, synthesizer } = await liveRoom({
      detected: 'sw-KE',
      noteLanguage: 'sw-KE',
    });
    ask(room, 'Kwa nini tunagawanya kwa mzizi wa d?');
    await until(() => transport.messages.some((m) => m.kind === 'turn_done' && m.thread === 't1'));
    expect(room.getState().language).toBe('sw-KE');
    const turn = transport.cues().filter((c) => c.thread === 't1');
    expect(turn[0]?.event.type).toBe('note');
    expect(turn.some((c) => c.event.type === 'say' && c.event.id === 't1.s0')).toBe(false);
    const said = turn.flatMap((c) => (c.event.type === 'say' ? [c.event.text] : []));
    expect(said).toEqual(['Without it the dot products get huge.']);
    // Nothing but the answer reached the voice on this turn (no English "Good question.").
    const turnVoiced = synthesizer.requests.filter((r) => !r.text.startsWith('Segment 1'));
    expect(turnVoiced.map((r) => r.text)).toEqual(['Without it the dot products get huge.']);
    await room.end();
  });

  it('localises the recovery bridge when the answer fails', async () => {
    const { room, transport } = await liveRoom({ detected: 'es-ES', noteLanguage: null });
    ask(room, '¿Por qué dividimos por la raíz cuadrada de d?');
    await until(() => transport.messages.some((m) => m.kind === 'turn_done' && m.thread === 't1'));
    const recovery = transport
      .cues()
      .find((c) => c.thread === 't1' && c.event.type === 'say' && c.event.id === 't1.s98');
    if (recovery?.event.type !== 'say') throw new Error('no recovery sentence');
    expect(recovery.event.text).toContain(bridgeBack(1, 'es-ES'));
    expect(recovery.event.text).toMatch(SPANISH_BRIDGES);
    await room.end();
  });
});
