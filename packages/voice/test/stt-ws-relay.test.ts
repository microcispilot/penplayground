import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsRelayRecognizer } from '../src/server/ws-relay.js';
import { collect, type FakeSocket, fakeSockets, pcm } from './fake-socket.js';

/** STTPartial as defined in simurgh_schemas (no `type` key). */
const partial = (segment_id: string, text: string, is_final: boolean) => ({
  session_id: 's',
  segment_id,
  text,
  is_final,
  confidence: 0.9,
  start_audio_ms: 0,
  end_audio_ms: 1200,
});

async function openSession(
  overrides: Partial<ConstructorParameters<typeof WsRelayRecognizer>[0]> = {},
) {
  const { factory, sockets } = fakeSockets();
  const c = collect();
  const relay = new WsRelayRecognizer({
    baseUrl: 'ws://127.0.0.1:8320/',
    sockets: factory,
    ...overrides,
  });
  const opening = relay.open({ language: 'fa-IR', sampleRate: 16000, ...c.handlers });
  const socket = sockets[0] as FakeSocket;
  socket.serverOpen();
  const session = await opening;
  return { session, socket, sockets, c };
}

describe('WsRelayRecognizer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens /stream with a valid session id, 16 kHz and the Whisper language, then sends start', async () => {
    const { socket } = await openSession();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('ws://127.0.0.1:8320/stream');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('language')).toBe('fa');
    expect(url.searchParams.get('session_id')).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(socket.controls).toEqual([{ type: 'start' }]);
  });

  it('streams ≤ 250 ms frames, sends stop, folds finals and partials, and finishes on end', async () => {
    const { session, socket, c } = await openSession();
    session.pushAudio(pcm(500));
    session.pushAudio(pcm(100));
    expect(socket.sentBinary.map((f) => f.length)).toEqual([8000, 8000, 3200]);
    socket.serverJson({ type: 'speaking_state', state: 'SPEECH_START', audio_ms: 120 });
    socket.serverJson(partial('seg-1', 'سلام', false));
    socket.serverJson(partial('seg-1', 'سلام دنیا', true));
    socket.serverJson(partial('seg-2', 'چطوری', false));
    session.endUtterance();
    expect(socket.controls.at(-1)).toEqual({ type: 'stop' });
    socket.serverJson({
      type: 'language',
      segment_id: 'seg-2',
      language: 'fa',
      probability: 0.99,
      source: 'requested',
    });
    socket.serverJson(partial('seg-2', 'چطوری؟', true));
    socket.serverJson({ type: 'end', reason: 'stop', audio_ms: 600, finals: 2 });
    socket.serverClose(1000);
    expect(c.partials).toEqual(['سلام', 'سلام دنیا', 'سلام دنیا چطوری', 'سلام دنیا چطوری؟']);
    expect(c.finals).toEqual(['سلام دنیا چطوری؟']);
    expect(c.errors).toEqual([]);
  });

  it('opens a fresh socket for the next utterance and buffers audio until it is open', async () => {
    const { session, socket, sockets, c } = await openSession();
    session.pushAudio(pcm(100));
    session.endUtterance();
    socket.serverJson(partial('a', 'first', true));
    socket.serverJson({ type: 'end', reason: 'stop', audio_ms: 100, finals: 1 });
    socket.serverClose(1000);

    session.pushAudio(pcm(160));
    session.pushAudio(pcm(160));
    expect(sockets).toHaveLength(2);
    const next = sockets[1] as FakeSocket;
    expect(next.sentBinary).toHaveLength(0);
    next.serverOpen();
    expect(next.controls[0]).toEqual({ type: 'start' });
    expect(next.sentBinary.map((f) => f.length)).toEqual([5120, 5120]);
    session.endUtterance();
    next.serverJson(partial('b', 'second', true));
    next.serverJson({ type: 'end', reason: 'stop', audio_ms: 320, finals: 1 });
    next.serverClose(1000);
    expect(c.finals).toEqual(['first', 'second']);
  });

  it('sends stop as soon as the socket opens when the utterance ended while connecting', async () => {
    const { session, socket, sockets } = await openSession();
    session.endUtterance();
    socket.serverJson({ type: 'end', reason: 'stop', audio_ms: 0, finals: 0 });
    socket.serverClose(1000);
    session.pushAudio(pcm(100));
    session.endUtterance();
    const next = sockets[1] as FakeSocket;
    next.serverOpen();
    expect(next.controls).toEqual([{ type: 'start' }, { type: 'stop' }]);
  });

  it('reports the host error frame with its code and does not treat the close as abnormal', async () => {
    const { socket, c } = await openSession();
    socket.serverJson({
      type: 'error',
      code: 'decode_failed',
      message: 'transcription failed',
      recoverable: false,
    });
    socket.serverClose(1011, 'decode_failed');
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_UPSTREAM_ERROR']);
    expect(c.errors.map((e) => String((e.error as Error).message))[0]).toContain('decode_failed');
  });

  it('reports a close without a terminal frame as abnormal', async () => {
    const { session, socket, c } = await openSession();
    session.pushAudio(pcm(100));
    session.endUtterance();
    socket.serverJson(partial('a', 'lost', true));
    socket.serverClose(1006);
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_CLOSED_UNEXPECTEDLY']);
    expect(c.finals).toEqual([]);
  });

  it('times out when end never arrives after stop', async () => {
    const { session, c } = await openSession({ endTimeoutMs: 3000 });
    session.pushAudio(pcm(100));
    session.endUtterance();
    vi.advanceTimersByTime(3000);
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_TIMEOUT']);
  });

  it('rejects open when the host never answers the upgrade', async () => {
    const { factory } = fakeSockets();
    const c = collect();
    const relay = new WsRelayRecognizer({
      baseUrl: 'ws://127.0.0.1:8320',
      sockets: factory,
      connectTimeoutMs: 2000,
    });
    const opening = relay.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    vi.advanceTimersByTime(2000);
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_CONNECT_FAILED' });
  });

  it('rejects open when the host refuses the stream (1013 busy)', async () => {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const relay = new WsRelayRecognizer({ baseUrl: 'ws://127.0.0.1:8320', sockets: factory });
    const opening = relay.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    (sockets[0] as FakeSocket).serverClose(1013);
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_CONNECT_FAILED' });
  });
});
