import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  CONVERSATION_LIMIT,
  type ConversationMessage,
  expertSaid,
  learnerSaid,
  systemSaid,
} from '../src/room/conversation.js';

const EMPTY: ConversationMessage[] = [];

describe('the room conversation', () => {
  it('keeps the lesson and an answer apart by the cue thread they came from', () => {
    const lesson = expertSaid(EMPTY, {
      id: 'e1',
      speaker: 'Ada',
      text: 'Attention is a weighted average.',
      at: 1,
      thread: 'lesson',
    });
    const answer = expertSaid(lesson, {
      id: 'e2',
      speaker: 'Ada',
      text: 'Because the dot products grow with the dimension.',
      at: 2,
      thread: 't3',
    });
    expect(answer.map((m) => m.kind)).toEqual(['lesson', 'answer']);
    expect(answer.every((m) => m.role === 'expert' && !m.live)).toBe(true);
  });

  it('resolves a spoken question in place: one message, not one per partial', () => {
    let list = learnerSaid(EMPTY, { id: 'l1', speaker: 'You', text: 'why', final: false, at: 1 });
    list = learnerSaid(list, { id: 'l2', speaker: 'You', text: 'why do we', final: false, at: 2 });
    expect(list).toHaveLength(1);
    expect(list[0]?.live).toBe(true);

    list = learnerSaid(list, {
      id: 'l3',
      speaker: 'You',
      text: 'why do we divide by the square root of d?',
      final: true,
      at: 3,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.live).toBe(false);
    expect(list[0]?.text).toBe('why do we divide by the square root of d?');
    // The id is the one the line was born with, so React never remounts the row mid-sentence.
    expect(list[0]?.id).toBe('l1');
  });

  it('starts a new line once the last one is settled', () => {
    let list = learnerSaid(EMPTY, { id: 'l1', speaker: 'You', text: 'first', final: true, at: 1 });
    list = learnerSaid(list, { id: 'l2', speaker: 'You', text: 'second', final: true, at: 2 });
    expect(list.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('does not let a flapping socket write the same system line twice in a row', () => {
    let list = systemSaid(EMPTY, { id: 's1', text: 'The connection dropped — reconnecting.', at: 1 });
    list = systemSaid(list, { id: 's2', text: 'The connection dropped — reconnecting.', at: 2 });
    expect(list).toHaveLength(1);
    list = systemSaid(list, { id: 's3', text: 'Back.', at: 3 });
    list = systemSaid(list, { id: 's4', text: 'The connection dropped — reconnecting.', at: 4 });
    expect(list.map((m) => m.text)).toEqual([
      'The connection dropped — reconnecting.',
      'Back.',
      'The connection dropped — reconnecting.',
    ]);
    expect(list.every((m) => m.role === 'system' && m.kind === 'system')).toBe(true);
  });

  it('drops the oldest lines rather than growing without bound', () => {
    let list: ConversationMessage[] = [];
    for (let i = 0; i < CONVERSATION_LIMIT + 25; i += 1)
      list = appendMessage(list, {
        id: `e${i}`,
        role: 'expert',
        speaker: 'Ada',
        text: `line ${i}`,
        live: false,
        at: i,
        kind: 'lesson',
      });
    expect(list).toHaveLength(CONVERSATION_LIMIT);
    expect(list[0]?.text).toBe('line 25');
    expect(list[list.length - 1]?.text).toBe(`line ${CONVERSATION_LIMIT + 24}`);
  });
});
