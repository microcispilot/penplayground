import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramRecognizer } from '../src/server/deepgram.js';
import { collect, type FakeSocket, fakeSockets, pcm } from './fake-socket.js';

/** Shapes from developers.deepgram.com/reference/speech-to-text/listen-streaming. */
const results = (
  transcript: string,
  flags: Partial<Record<'is_final' | 'speech_final' | 'from_finalize', boolean>>,
) => ({
  type: 'Results',
  channel_index: [0, 1],
  duration: 1.02,
  start: 0,
  is_final: false,
  speech_final: false,
  channel: { alternatives: [{ transcript, confidence: 0.98, words: [] }] },
  metadata: { request_id: 'r', model_info: {}, model_uuid: 'm' },
  ...flags,
});
const utteranceEnd = { type: 'UtteranceEnd', channel: [0, 1], last_word_end: 3.1 };

async function openSession(
  overrides: Partial<ConstructorParameters<typeof DeepgramRecognizer>[0]> = {},
) {
  const { factory, sockets } = fakeSockets();
  const c = collect();
  const dg = new DeepgramRecognizer({ apiKey: 'dg-key', sockets: factory, ...overrides });
  const opening = dg.open({ language: 'en-US', sampleRate: 16000, ...c.handlers });
  const socket = sockets[0] as FakeSocket;
  socket.serverOpen();
  const session = await opening;
  return { session, socket, c };
}

describe('DeepgramRecognizer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects with the documented URL, Token header and streams linear16 frames', async () => {
    const { session, socket } = await openSession();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      language: 'en-US',
    });
    expect(socket.init.headers).toEqual({ Authorization: 'Token dg-key' });

    session.pushAudio(pcm(600));
    expect(socket.sentBinary.map((f) => f.length)).toEqual([8000, 8000, 3200]);
    session.close();
    expect(socket.controls.at(-1)).toEqual({ type: 'CloseStream' });
    expect(socket.closedWith?.code).toBe(1000);
  });

  it('sends KeepAlive while idle and stops after close', async () => {
    const { session, socket } = await openSession({ keepAliveMs: 4000 });
    vi.advanceTimersByTime(12_500);
    expect(socket.controls.filter((m) => m.type === 'KeepAlive')).toHaveLength(3);
    session.close();
    vi.advanceTimersByTime(20_000);
    expect(socket.controls.filter((m) => m.type === 'KeepAlive')).toHaveLength(3);
  });

  it('folds interim and is_final Results into one running partial', async () => {
    const { socket, c } = await openSession();
    socket.serverJson(results('what is', { is_final: false }));
    socket.serverJson(results('what is the', { is_final: false }));
    socket.serverJson(results('what is the capital', { is_final: true }));
    socket.serverJson(results('of', { is_final: false }));
    socket.serverJson(results('of france', { is_final: true, speech_final: true }));
    expect(c.partials).toEqual([
      'what is',
      'what is the',
      'what is the capital',
      'what is the capital of',
      'what is the capital of france',
    ]);
    expect(c.finals).toEqual([]);
  });

  it('delivers the final at once on endUtterance when speech_final already closed the segment', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson(results('hello there', { is_final: true, speech_final: true }));
    session.endUtterance();
    expect(c.finals).toEqual(['hello there']);
    expect(socket.controls.some((m) => m.type === 'Finalize')).toBe(false);
  });

  it('sends Finalize when interim text is pending and finalises on the from_finalize Results', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson(results('hello', { is_final: true }));
    socket.serverJson(results('there fri', { is_final: false }));
    session.endUtterance();
    expect(socket.controls.at(-1)).toEqual({ type: 'Finalize' });
    expect(c.finals).toEqual([]);
    socket.serverJson(results('there friend', { is_final: true, from_finalize: true }));
    expect(c.finals).toEqual(['hello there friend']);
    // The next utterance starts clean.
    socket.serverJson(results('second', { is_final: true }));
    socket.serverJson(utteranceEnd);
    session.endUtterance();
    expect(c.finals).toEqual(['hello there friend', 'second']);
  });

  it('treats UtteranceEnd as the closing marker', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson(results('one two', { is_final: true }));
    socket.serverJson(results('three', { is_final: false }));
    session.endUtterance();
    socket.serverJson(results('three', { is_final: true }));
    socket.serverJson(utteranceEnd);
    expect(c.finals).toEqual(['one two three']);
  });

  it('delivers what it heard when Finalize is not answered in time', async () => {
    const { session, socket, c } = await openSession({ finalizeTimeoutMs: 1000 });
    socket.serverJson(results('partial only', { is_final: false }));
    session.endUtterance();
    vi.advanceTimersByTime(1000);
    expect(c.finals).toEqual(['partial only']);
    expect(c.errors).toEqual([]);
  });

  it('delivers an empty final, not an error, when a silent utterance gets no answer', async () => {
    const { session, socket, c } = await openSession({ finalizeTimeoutMs: 500 });
    session.pushAudio(pcm(200));
    session.endUtterance();
    expect(socket.controls.at(-1)).toEqual({ type: 'Finalize' });
    vi.advanceTimersByTime(500);
    expect(c.errors).toEqual([]);
    expect(c.finals).toEqual(['']);
  });

  it('maps close-frame error payloads to stable codes', async () => {
    const { socket, c } = await openSession();
    socket.serverClose(1011, 'NET-0001');
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_UPSTREAM_ERROR']);
  });

  it('rejects open when the upgrade is refused', async () => {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const dg = new DeepgramRecognizer({ apiKey: 'bad', sockets: factory });
    const opening = dg.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    (sockets[0] as FakeSocket).serverClose(1008, 'Unauthorized');
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_UNAUTHORIZED' });
  });

  it('rejects open when the upgrade never completes', async () => {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const dg = new DeepgramRecognizer({ apiKey: 'k', sockets: factory, connectTimeoutMs: 2000 });
    const opening = dg.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    vi.advanceTimersByTime(2000);
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_CONNECT_FAILED' });
    expect((sockets[0] as FakeSocket).closedWith?.reason).toBe('connect timeout');
  });

  it('flags malformed Results as a protocol error and stops', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson({ type: 'Results', channel: {} });
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_PROTOCOL']);
    session.endUtterance();
    expect(c.finals).toEqual([]);
  });
});
