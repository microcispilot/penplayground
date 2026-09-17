import type { LessonEvent } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { LessonEventParser } from '../src/event-parser.js';

const board = (id: string, anchor: string, text: string) =>
  `{"type":"board","id":"${id}","anchor":"${anchor}","op":"write","text":"${text}","lang":"","ref":"","ref2":"","place":"flow","emphasis":"ink"}`;

describe('LessonEventParser', () => {
  it('emits each event as soon as its closing brace arrives, across arbitrary chunk boundaries', () => {
    const events: LessonEvent[] = [];
    const invalid: unknown[] = [];
    const parser = new LessonEventParser({
      onEvent: (e) => events.push(e),
      onInvalid: (r) => invalid.push(r),
    });
    const full = `{"events":[{"type":"say","id":"s1","text":"Let's start.","tone":"warm"},${board('b1', 's1', 'the cat sat')},{"type":"done"}]}`;
    // feed in 7-char chunks, checking the first say arrives before the board text is even seen
    let sawFirstAt = -1;
    for (let i = 0; i < full.length; i += 7) {
      parser.write(full.slice(i, i + 7));
      if (events.length === 1 && sawFirstAt < 0) sawFirstAt = i;
    }
    parser.end();
    expect(events.map((e) => e.type)).toEqual(['say', 'board', 'done']);
    expect(sawFirstAt).toBeLessThan(full.indexOf('"board"'));
    expect(invalid).toHaveLength(0);
  });

  it('splits an over-long say into sentences instead of dropping it', () => {
    const events: LessonEvent[] = [];
    const parser = new LessonEventParser({
      onEvent: (e) => events.push(e),
      onInvalid: () => undefined,
    });
    const long = Array.from(
      { length: 12 },
      (_, i) => `This is sentence number ${i + 1} and it keeps going for a while.`,
    ).join(' ');
    parser.write(`{"events":[{"type":"say","id":"s1","text":"${long}","tone":"neutral"}]}`);
    parser.end();
    expect(events.length).toBeGreaterThan(1);
    for (const e of events) if (e.type === 'say') expect(e.text.length).toBeLessThanOrEqual(400);
  });

  it('reports invalid elements without breaking the stream', () => {
    const events: LessonEvent[] = [];
    const invalid: unknown[] = [];
    const parser = new LessonEventParser({
      onEvent: (e) => events.push(e),
      onInvalid: (r) => invalid.push(r),
    });
    parser.write(
      `{"events":[{"type":"board","id":"nope"},{"type":"say","id":"s2","text":"ok","tone":"warm"}]}`,
    );
    parser.end();
    expect(invalid).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('keeps already-emitted events when the JSON is truncated', () => {
    const events: LessonEvent[] = [];
    const parser = new LessonEventParser({
      onEvent: (e) => events.push(e),
      onInvalid: () => undefined,
    });
    parser.write(
      `{"events":[{"type":"say","id":"s1","text":"Hello.","tone":"warm"},{"type":"say","id":"s2","text":"Trunc`,
    );
    parser.end();
    expect(events).toHaveLength(1);
  });
});
