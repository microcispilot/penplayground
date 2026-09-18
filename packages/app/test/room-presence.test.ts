import { describe, expect, it } from 'vitest';
import {
  expertPresence,
  participantPresence,
  SELF_SPEAKING_RMS,
} from '../src/room/presence.js';
import { audioUi, HOST_ID, participant, roomState } from './room-fixtures.js';

const quiet = {
  micState: 'idle' as const,
  micLevel: 0,
};

describe('who the panel may animate', () => {
  it('rings the participant the media server says is audible, and nobody else', () => {
    const state = roomState(3);
    const audio = audioUi({ speaking: ['p_guest_000001'], participants: { p_guest_000001: { muted: false }, p_guest_000002: { muted: false } } });
    const of = (id: string) =>
      participantPresence({
        participant: state.participants.find((p) => p.id === id) ?? participant(9),
        selfId: HOST_ID,
        state,
        audio,
        ...quiet,
      });
    expect(of('p_guest_000001')).toBe('speaking');
    expect(of('p_guest_000002')).toBe('listening');
    expect(of(HOST_ID)).toBe('listening');
  });

  it('never animates a silent participant, however loud the room is', () => {
    const state = roomState(2);
    const audio = audioUi({ participants: { p_guest_000001: { muted: false } } });
    expect(
      participantPresence({
        participant: state.participants[1] as never,
        selfId: HOST_ID,
        state,
        audio,
        micState: 'listening',
        // Our own level says nothing about somebody else.
        micLevel: 1,
      }),
    ).toBe('listening');
  });

  it('reads our own microphone level in a solo session, where there is no media server', () => {
    const state = roomState(1);
    const self = state.participants[0] as never;
    const loud = participantPresence({
      participant: self,
      selfId: HOST_ID,
      state,
      audio: null,
      micState: 'listening',
      micLevel: SELF_SPEAKING_RMS + 0.01,
    });
    const soft = participantPresence({
      participant: self,
      selfId: HOST_ID,
      state,
      audio: null,
      micState: 'listening',
      micLevel: SELF_SPEAKING_RMS,
    });
    const off = participantPresence({
      participant: self,
      selfId: HOST_ID,
      state,
      audio: null,
      micState: 'idle',
      micLevel: 1,
    });
    expect([loud, soft, off]).toEqual(['speaking', 'quiet', 'quiet']);
  });

  it('marks the floor holder without pretending they are making a sound', () => {
    const state = roomState(2, { mode: 'thinking', floor: 'p_guest_000001' });
    expect(
      participantPresence({
        participant: state.participants[1] as never,
        selfId: HOST_ID,
        state,
        audio: null,
        ...quiet,
      }),
    ).toBe('floor');
    // …and the floor is only the floor while somebody actually holds it.
    const teaching = roomState(2, { mode: 'teaching', floor: 'p_guest_000001' });
    expect(
      participantPresence({
        participant: teaching.participants[1] as never,
        selfId: HOST_ID,
        state: teaching,
        audio: null,
        ...quiet,
      }),
    ).toBe('quiet');
  });

  it("gives the AI human the conductor's own presence, and idle once the room is not live", () => {
    expect(expertPresence(roomState(1), true)).toBe('speaking');
    expect(expertPresence(roomState(1), false)).toBe('idle');
    expect(expertPresence(roomState(1, { mode: 'listening' }), false)).toBe('listening');
    expect(expertPresence(roomState(1, { mode: 'thinking' }), true)).toBe('thinking');
    expect(expertPresence(roomState(1, { mode: 'paused' }), true)).toBe('paused');
    expect(expertPresence(roomState(1, { phase: 'ended' }), true)).toBe('idle');
    expect(expertPresence(null, true)).toBe('idle');
  });
});
