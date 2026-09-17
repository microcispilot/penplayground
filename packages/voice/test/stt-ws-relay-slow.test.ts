import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsRelayRecognizer } from '../src/server/ws-relay.js';
import { collect, type FakeSocket, fakeSockets, pcm } from './fake-socket.js';

/**
 * The Simurgh host decodes the closing segment after `stop`, which on the
 * founder's home link has been measured at > 6 s. Proves that a slow `end`
 * still hands the learner the best partial instead of an error, that silence
 * still reports a timeout, and that `warm()` never throws.
 */
describe('WsRelayRecognizer on a slow host', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function openSession() {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const relay = new WsRelayRecognizer({
      baseUrl: 'ws://relay.test:8320',
      sockets: factory,
      endTimeoutMs: 500,
    });
    const opening = relay.open({ language: 'en-US', sampleRate: 16000, ...c.handlers });
    const socket = sockets[0] as FakeSocket;
    socket.serverOpen();
    const session = await opening;
    return { session, socket, c, relay, sockets };
  }

  it('delivers the last partial as the final when `end` has not arrived by the timeout', async () => {
    const { session, socket, c } = await openSession();
    session.pushAudio(pcm(160));
    socket.serverJson({
      session_id: 's',
      segment_id: 'seg-1',
      text: "Let's start with a sentence.",
      is_final: false,
      confidence: 0.7,
      start_audio_ms: 0,
      end_audio_ms: 900,
    });
    session.endUtterance();
    expect(socket.controls.at(-1)).toEqual({ type: 'stop' });
    await vi.advanceTimersByTimeAsync(600);
    expect(c.finals).toEqual(["Let's start with a sentence."]);
    expect(c.errors).toEqual([]);
  });

  it('still reports a timeout when nothing was transcribed', async () => {
    const { session, c } = await openSession();
    session.pushAudio(pcm(160));
    session.endUtterance();
    await vi.advanceTimersByTimeAsync(600);
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_TIMEOUT']);
    expect(c.finals).toEqual([]);
  });

  it('warm() opens a throwaway socket, closes it on open, and resolves false on error or timeout', async () => {
    const { factory, sockets } = fakeSockets();
    const relay = new WsRelayRecognizer({
      baseUrl: 'ws://relay.test:8320',
      sockets: factory,
      connectTimeoutMs: 1000,
    });
    const first = relay.warm();
    const s1 = sockets[0] as FakeSocket;
    expect(s1.url).toContain('pen-warm-');
    s1.serverOpen();
    expect(await first).toBe(true);
    expect(s1.closedWith).toEqual({ code: 1000, reason: 'warm' });

    const second = relay.warm();
    (sockets[1] as FakeSocket).serverError(new Error('refused'));
    expect(await second).toBe(false);

    const third = relay.warm();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await third).toBe(false);
    expect((sockets[2] as FakeSocket).closedWith?.reason).toBe('warm timeout');
  });
});
