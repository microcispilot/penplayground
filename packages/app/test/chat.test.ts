import { describe, expect, it } from 'vitest';
import {
  appendChat,
  CHAT_GROUP_GAP_MS,
  CHAT_LIMIT,
  type ChatLine,
  groupChat,
} from '../src/room/chat.js';

const EMPTY: ChatLine[] = [];

function line(over: Partial<ChatLine> = {}): ChatLine {
  return {
    id: 'c1',
    participantId: 'p1',
    name: 'Sam',
    text: 'can you see the board?',
    at: 1_800_000_000_000,
    own: false,
    ...over,
  };
}

describe('the room chat list', () => {
  it('keeps what was said in the order the room stamped it', () => {
    let list = appendChat(EMPTY, line({ id: 'a', text: 'first' }));
    list = appendChat(list, line({ id: 'b', participantId: 'p2', name: 'Kim', text: 'second' }));
    expect(list.map((c) => [c.name, c.text])).toEqual([
      ['Sam', 'first'],
      ['Kim', 'second'],
    ]);
  });

  it('drops the oldest rather than growing without bound', () => {
    let list: ChatLine[] = [];
    for (let i = 0; i < CHAT_LIMIT + 25; i += 1)
      list = appendChat(list, line({ id: `c${i}`, text: `line ${i}`, at: i }));
    expect(list).toHaveLength(CHAT_LIMIT);
    expect(list[0]?.text).toBe('line 25');
    expect(list[list.length - 1]?.text).toBe(`line ${CHAT_LIMIT + 24}`);
  });
});

describe('chat groups the way a chat between people groups', () => {
  it('puts a run of lines from one person under one name', () => {
    const at = 1_800_000_000_000;
    const list = [
      line({ id: 'a', text: 'wait' }),
      line({ id: 'b', text: 'which slide?', at: at + 2_000 }),
      line({ id: 'c', participantId: 'p2', name: 'Kim', text: 'the second one', at: at + 4_000 }),
    ];
    const groups = groupChat(list);
    expect(groups.map((g) => [g.name, g.lines.map((l) => l.text)])).toEqual([
      ['Sam', ['wait', 'which slide?']],
      ['Kim', ['the second one']],
    ]);
    // A run is keyed by the line it began with, so appending never remounts it.
    expect(groups[0]?.id).toBe('a');
  });

  it('breaks a run once the gap is wide enough for the name to be worth repeating', () => {
    const at = 1_800_000_000_000;
    const groups = groupChat([
      line({ id: 'a', text: 'earlier' }),
      line({ id: 'b', text: 'much later', at: at + CHAT_GROUP_GAP_MS + 1 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.at)).toEqual([at, at + CHAT_GROUP_GAP_MS + 1]);
  });

  it('tells two people with the same name apart, because the id is what is unique', () => {
    const at = 1_800_000_000_000;
    const groups = groupChat([
      line({ id: 'a', participantId: 'p1', name: 'Sam', text: 'mine' }),
      line({ id: 'b', participantId: 'p2', name: 'Sam', text: 'theirs', at: at + 1_000 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.participantId)).toEqual(['p1', 'p2']);
  });

  it('carries whose line it is through to the group', () => {
    const groups = groupChat([line({ id: 'a', own: true, name: 'You' })]);
    expect(groups[0]?.own).toBe(true);
  });

  it('has nothing to group before anybody has said anything', () => {
    expect(groupChat(EMPTY)).toEqual([]);
  });
});

describe('words to the expert in a room (ADR-0035)', () => {
  it('sit in their own run, apart from the same person’s messages, so who asked what is readable', () => {
    const list = [
      line({ id: 'a', text: 'hi all', at: 1_000 }),
      line({ id: 'q', text: 'Why divide by the root of d?', at: 2_000, kind: 'question' }),
      line({ id: 'b', text: 'thanks', at: 3_000 }),
    ];
    const groups = groupChat(list);
    expect(groups.map((g) => [g.kind, g.lines.length])).toEqual([
      ['message', 1],
      ['question', 1],
      ['message', 1],
    ]);
  });
});
