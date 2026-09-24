import type { LedgerEntry } from '@pen/contracts';
import { FakeLanguageModel } from '@pen/llm';
import { describe, expect, it } from 'vitest';
import type { LedgerSink } from '../src/room.js';
import { SessionRoom } from '../src/room.js';
import {
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
 * The host's socket going is the only goodbye a closed tab says (ADR-0049).
 * The room must stop buying audio for nobody, wait, and go on only when the
 * host is back — whatever it was doing when they went.
 */
const HOST = 'p_host_away_01';

class MemoryLedger implements LedgerSink {
  readonly entries: LedgerEntry[] = [];
  append(_sessionId: string, entry: LedgerEntry): void {
    this.entries.push(entry);
  }
  storeAudio(): string {
    return 'mem#0';
  }
}

const completed = (transport: MemoryTransport) =>
  transport.messages.filter((m) => m.kind === 'say_complete');

async function liveRoom() {
  const { onten, memo } = await preparedPack();
  const transport = new MemoryTransport();
  const synthesizer = new SpySynthesizer();
  const room = new SessionRoom({
    sessionId: 'sess-host-away',
    topic: 'How Transformers work in LLMs',
    host: { id: HOST, name: 'Sam', plan: 'professional' },
    expert,
    band: 'beginner',
    language: 'en-US',
    locale: 'en-US',
    onten,
    runtime: onten.newRuntime(),
    memo,
    model: new FakeLanguageModel(
      [segmentScript(1)],
      [planCompletion(1), { purpose: 'recap', value: { points: ['Tokens become vectors'] } }],
    ),
    synthesizer,
    voice: voiceFor('en'),
    voiceFor,
    sampleRate: 44100,
    transport,
    acquirer: null,
    ledger: new MemoryLedger(),
    targetMinutes: 1,
  });
  return { room, transport, synthesizer };
}

describe('the host’s tab closes', () => {
  it('pauses a teaching room at once and throws the banked sentences away', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => completed(transport).length >= 1);
    expect(room.getState().mode).toBe('teaching');
    const bought = synthesizer.requests.length;
    room.leave(HOST);
    expect(room.getState().mode).toBe('paused');
    // Nothing more is synthesised while nobody is there.
    await new Promise((r) => setTimeout(r, 150));
    expect(synthesizer.requests.length).toBe(bought);
    // The host is still the host: the seat is kept, and a rejoin resumes on their word.
    expect(room.join({ id: HOST, name: 'Sam' })).toMatchObject({ ok: true });
    room.handle(HOST, { kind: 'control', action: 'resume' });
    expect(room.getState().mode).toBe('teaching');
    await room.end();
  });

  it('lets a turn in flight finish, then pauses instead of teaching on', async () => {
    const { room, transport, synthesizer } = await liveRoom();
    await room.start();
    await until(() => completed(transport).length >= 1);
    // The host takes the floor, and their tab closes before the room has
    // decided what they said. The floor is released the way it always is —
    // and into a pause, not into more lesson.
    room.handle(HOST, { kind: 'interrupt', atSeq: 0, sayId: null, offsetMs: 0 });
    expect(room.getState().mode).toBe('listening');
    room.leave(HOST);
    // An empty final is the surest backchannel there is: no classifier is asked.
    room.handle(HOST, { kind: 'transcript', utteranceId: 'u1', text: '', final: true });
    // `handle` marks the host present again; the tab is gone for good here.
    room.leave(HOST);
    await until(() => room.getState().mode === 'paused', 8000);
    expect(room.getState().mode).toBe('paused');
    const afterTurn = synthesizer.requests.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(synthesizer.requests.length).toBe(afterTurn);
    await room.end();
  });
});
