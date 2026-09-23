import type { ClientMessage } from '@pen/contracts';
import { SilentSynthesizer } from '@pen/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullMetrics } from '../src/metrics.js';
import { HAND_WAIT_MS, SessionRoom } from '../src/room.js';
import { expert, MemoryTransport, preparedPack, until } from './fixtures.js';
import { fakeModel } from './transformers-room.js';

/**
 * The floor in a room (ADR-0037), every row of the table: a hand is taken at
 * a sentence boundary, in the order raised; a guest who is not called on is
 * never heard; a called guest who says nothing, or changes their mind, is let
 * go with a sentence and the lesson carries on; the host's discussion stops
 * everything and hears nobody; the host is primary; removal is for good.
 */
const HOST = 'host-1234';
const TOM = 'guest-tom1';
const PRIYA = 'guest-pri1';

interface Harness {
  room: SessionRoom;
  transport: MemoryTransport;
  interactions: Array<{ who: string; event: string; props: Record<string, unknown> }>;
  /** Report every lesson sentence up to `seq` heard, as the host's conductor does. */
  heard(seq: number): void;
  /** Cues on the `floor` thread, as text. */
  floorLines(): string[];
  end(): Promise<void>;
}

async function classroom(): Promise<Harness> {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const interactions: Harness['interactions'] = [];
  const metrics = new NullMetrics();
  metrics.interaction = (who, event, props) => {
    interactions.push({ who, event, props: props ?? {} });
  };
  const room = new SessionRoom({
    sessionId: 'sess-hands',
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam Owner', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo,
    model: fakeModel(),
    synthesizer: new SilentSynthesizer(),
    voice: 'v',
    sampleRate: 44100,
    transport,
    acquirer: null,
    metrics,
    targetMinutes: 2,
  });
  expect(room.join({ id: TOM, name: 'Tom Ba' })).toMatchObject({ ok: true });
  expect(room.join({ id: PRIYA, name: 'Priya Ka' })).toMatchObject({ ok: true });
  await room.start();
  await until(() => transport.cues().filter((c) => c.segment === 0).length >= 3);
  return {
    room,
    transport,
    interactions,
    heard: (seq) => room.handle(HOST, { kind: 'progress', seq, clockMs: 1000 * (seq + 1) }),
    floorLines: () =>
      transport
        .cues()
        .filter((c) => c.thread === 'floor' && c.event.type === 'say')
        .map((c) => (c.event.type === 'say' ? c.event.text : '')),
    end: () => room.end(),
  };
}

const say = (who: string, text: string): ClientMessage => ({
  kind: 'transcript',
  utteranceId: `u-${who}-${text.length}`,
  text,
  final: true,
});

/** The invitation cue for the guest, once spoken. */
function invitationFor(h: Harness, name: string) {
  return h.transport
    .cues()
    .find((c) => c.thread === 'floor' && c.event.type === 'say' && c.event.text.includes(name));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a guest without the floor', () => {
  it('is never heard: no interrupt, no transcript, no turn, not a word from the expert', async () => {
    const h = await classroom();
    const cuesBefore = h.transport.cues().length;
    h.room.handle(TOM, { kind: 'interrupt', atSeq: 0, sayId: 'L0.s1', offsetMs: 400 });
    h.room.handle(TOM, say(TOM, 'Did you get that bit about the softmax?'));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.room.getState().mode).toBe('teaching');
    expect(h.room.getState().floor).toBeNull();
    expect(h.transport.cues().filter((c) => c.thread !== 'lesson')).toHaveLength(0);
    expect(h.transport.cues().length).toBe(cuesBefore);
    expect(h.transport.messages.some((m) => m.kind === 'error')).toBe(false);
    await h.end();
  });
});

describe('raising a hand', () => {
  it('is taken at the end of the sentence at the speaker, by name, then the guest has the floor and is answered', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    expect(h.room.getState().hands).toEqual([{ participantId: TOM, at: expect.any(Number) }]);
    // Nothing is said yet: the lesson holds at the sentence the host is hearing.
    expect(h.floorLines()).toEqual([]);
    // The host reaches the boundary: the invitation, with Tom's first name.
    h.heard(2);
    const invite = invitationFor(h, 'Tom');
    expect(invite).toBeDefined();
    expect(h.room.getState().hands).toEqual([]);
    expect(h.room.getState().mode).toBe('teaching');
    // The invitation is heard: the floor is Tom's, and he is invited.
    h.heard(invite?.seq ?? 0);
    expect(h.room.getState().mode).toBe('listening');
    expect(h.room.getState().floor).toBe(TOM);
    expect(h.room.getState().invited).toBe(TOM);
    // Tom asks; the expert answers on a turn thread, and the lesson resumes.
    h.room.handle(TOM, say(TOM, 'Why do we divide by the square root of d?'));
    await until(() => h.transport.messages.some((m) => m.kind === 'turn_done'));
    expect(h.room.getState().invited).toBeNull();
    expect(h.transport.cues().some((c) => c.thread === 't1' && c.event.type === 'say')).toBe(true);
    expect(h.interactions.map((i) => i.event)).toEqual(
      expect.arrayContaining(['hand_raised', 'hand_called']),
    );
    await h.end();
  });

  it('is taken at once when the expert is already waiting on a check-in', async () => {
    const h = await classroom();
    // Reach segment 2's check-in the way the main room test does.
    h.heard(2);
    await until(() => h.transport.cues().some((c) => c.event.type === 'check'));
    const check = h.transport.cues().find((c) => c.event.type === 'check');
    h.heard(check?.seq ?? 0);
    expect(h.room.getState().mode).toBe('checking');
    h.room.handle(PRIYA, { kind: 'hand', raised: true });
    expect(invitationFor(h, 'Priya')).toBeDefined();
    await h.end();
  });

  it('queues in the order raised, one boundary each, and a lowered hand is simply gone', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(PRIYA, { kind: 'hand', raised: true });
    h.room.handle(TOM, { kind: 'hand', raised: true });
    expect(h.room.getState().hands?.map((x) => x.participantId)).toEqual([PRIYA, TOM]);
    // Priya changes her mind before being called: Tom is next, nothing is said about her.
    h.room.handle(PRIYA, { kind: 'hand', raised: false });
    expect(h.room.getState().hands?.map((x) => x.participantId)).toEqual([TOM]);
    h.heard(2);
    expect(invitationFor(h, 'Tom')).toBeDefined();
    expect(invitationFor(h, 'Priya')).toBeUndefined();
    await h.end();
  });
});

describe('a called hand that goes nowhere', () => {
  it('says nothing for the wait: the expert lets them go by name and the lesson carries on', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    h.heard(2);
    const invite = invitationFor(h, 'Tom');
    h.heard(invite?.seq ?? 0);
    expect(h.room.getState().mode).toBe('listening');
    await vi.advanceTimersByTimeAsync(HAND_WAIT_MS + 50);
    expect(h.floorLines().some((t) => /Take your time, Tom|No rush, Tom/.test(t))).toBe(true);
    expect(h.room.getState().mode).toBe('teaching');
    expect(h.room.getState().floor).toBeNull();
    expect(h.room.getState().invited).toBeNull();
    expect(h.interactions.some((i) => i.event === 'hand_unanswered')).toBe(true);
    await h.end();
  });

  it('lowers the hand after being called: "no problem", and the lesson carries on', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    h.heard(2);
    h.heard(invitationFor(h, 'Tom')?.seq ?? 0);
    h.room.handle(TOM, { kind: 'hand', raised: false });
    expect(h.floorLines().some((t) => /No problem, Tom|All good, Tom/.test(t))).toBe(true);
    expect(h.room.getState().mode).toBe('teaching');
    expect(h.interactions.some((i) => i.event === 'hand_withdrawn')).toBe(true);
    await h.end();
  });

  it('leaves after being called: silently gone, the lesson carries on', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    h.heard(2);
    h.heard(invitationFor(h, 'Tom')?.seq ?? 0);
    const lines = h.floorLines().length;
    h.room.leave(TOM);
    expect(h.floorLines().length).toBe(lines);
    expect(h.room.getState().mode).toBe('teaching');
    expect(h.room.getState().participants.some((p) => p.id === TOM)).toBe(false);
    await h.end();
  });
});

describe('the host', () => {
  it('is primary: speaking while a hand is being called puts the hand back at the front', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    // Before the boundary the host cuts in.
    h.room.handle(HOST, { kind: 'interrupt', atSeq: 1, sayId: 'L0.s2', offsetMs: 300 });
    expect(h.room.getState().floor).toBe(HOST);
    expect(h.room.getState().hands?.map((x) => x.participantId)).toEqual([TOM]);
    await h.end();
  });

  it('can take the floor from a guest who holds it', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    h.heard(2);
    h.heard(invitationFor(h, 'Tom')?.seq ?? 0);
    expect(h.room.getState().floor).toBe(TOM);
    h.room.handle(HOST, { kind: 'interrupt', atSeq: 3, sayId: null, offsetMs: 0 });
    expect(h.room.getState().floor).toBe(HOST);
    expect(h.room.getState().invited).toBeNull();
    await h.end();
  });

  it('opens a discussion: the lesson stops, the expert waits, nobody is heard — then resumes', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(HOST, { kind: 'control', action: 'discuss' });
    expect(h.room.getState().mode).toBe('discussing');
    const cues = h.transport.cues().length;
    h.room.handle(HOST, { kind: 'interrupt', atSeq: 1, sayId: 'L0.s2', offsetMs: 100 });
    h.room.handle(HOST, say(HOST, 'What do you all think?'));
    h.room.handle(TOM, say(TOM, 'I think it is the scaling.'));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.room.getState().mode).toBe('discussing');
    // The lesson keeps being *written* one segment ahead, as under a pause;
    // nothing is answered and nothing is spoken to the room.
    expect(
      h.transport
        .cues()
        .slice(cues)
        .every((c) => c.thread === 'lesson'),
    ).toBe(true);
    // A hand raised meanwhile waits.
    h.room.handle(PRIYA, { kind: 'hand', raised: true });
    expect(h.floorLines()).toEqual([]);
    h.room.handle(HOST, { kind: 'control', action: 'resume' });
    expect(h.room.getState().mode).toBe('teaching');
    expect(h.interactions.map((i) => i.event)).toEqual(
      expect.arrayContaining(['discussion_started', 'discussion_ended']),
    );
    // Guests cannot open one.
    h.room.handle(TOM, { kind: 'control', action: 'discuss' });
    expect(h.transport.messages.at(-1)).toMatchObject({ kind: 'error', code: 'NOT_HOST' });
    await h.end();
  });

  it('removes a guest for good: told once, seat closed, hand and floor gone, no way back in', async () => {
    const h = await classroom();
    h.heard(0);
    h.room.handle(TOM, { kind: 'hand', raised: true });
    h.room.handle(HOST, { kind: 'remove_participant', participantId: TOM });
    expect(h.transport.messages.some((m) => m.kind === 'error' && m.code === 'REMOVED')).toBe(true);
    expect(h.room.getState().participants.some((p) => p.id === TOM)).toBe(false);
    expect(h.room.getState().hands).toEqual([]);
    expect(h.room.join({ id: TOM, name: 'Tom Ba' })).toMatchObject({ ok: false, code: 'REMOVED' });
    // A guest cannot remove anyone, and nobody removes the host.
    h.room.handle(PRIYA, { kind: 'remove_participant', participantId: HOST });
    expect(h.transport.messages.at(-1)).toMatchObject({ kind: 'error', code: 'NOT_HOST' });
    h.room.handle(HOST, { kind: 'remove_participant', participantId: HOST });
    expect(h.room.getState().participants.some((p) => p.id === HOST)).toBe(true);
    await h.end();
  });
});
