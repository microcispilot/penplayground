import { describe, expect, it } from 'vitest';
import {
  AnswerContext,
  ClientMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  hasEntitlement,
  LessonEvent,
  LessonEventEnvelope,
} from '../src/index.js';

describe('LessonEvent', () => {
  it('accepts a say/board pair with a with-anchor', () => {
    const parsed = LessonEventEnvelope.parse({
      events: [
        { type: 'say', id: 's1', text: "Let's start with a sentence.", tone: 'warm' },
        {
          type: 'board',
          id: 'b1',
          anchor: 's1',
          op: 'write',
          text: 'the cat sat on the mat',
          lang: '',
          ref: '',
          ref2: '',
          place: 'flow',
          emphasis: 'ink',
        },
        { type: 'done' },
      ],
    });
    expect(parsed.events).toHaveLength(3);
  });
  it('rejects a malformed anchor', () => {
    expect(() =>
      LessonEvent.parse({
        type: 'board',
        id: 'b1',
        anchor: 'before:s1',
        op: 'write',
        text: '',
        lang: '',
        ref: '',
        ref2: '',
        place: 'flow',
        emphasis: 'ink',
      }),
    ).toThrow();
  });
});

describe('audio frames', () => {
  it('round-trips a downstream frame', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeAudioFrame(
      {
        dir: 'down',
        sayId: 's3',
        audioChunkId: 0,
        audioClockMs: 0,
        sampleRate: 44100,
        durationMs: 20,
        textSpan: null,
        final: false,
        take: 0,
      },
      pcm,
    );
    const back = decodeAudioFrame(frame);
    expect(back.header.dir).toBe('down');
    expect(Array.from(back.pcm)).toEqual([1, 2, 3, 4]);
  });
});

describe('AnswerContext', () => {
  it('rejects unknown fields (schema-v1 additionalProperties=false)', () => {
    expect(() => AnswerContext.parse({ schemaVersion: 1, extra: true })).toThrow();
  });
});

describe('entitlements', () => {
  it('rooms are classroom-only', () => {
    expect(hasEntitlement('free', 'rooms')).toBe(false);
    expect(hasEntitlement('plus', 'rooms')).toBe(false);
    expect(hasEntitlement('classroom', 'rooms')).toBe(true);
  });
});

describe('client messages', () => {
  it('parses an interrupt', () => {
    expect(
      ClientMessage.parse({ kind: 'interrupt', atSeq: 12, sayId: 's4', offsetMs: 1300 }).kind,
    ).toBe('interrupt');
  });
});
