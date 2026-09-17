import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyAIRecognizer } from '../src/server/assemblyai.js';
import { collect, type FakeSocket, fakeSockets, pcm } from './fake-socket.js';

/** Shapes from assemblyai.com/docs/api-reference/streaming-api/streaming-api. */
const begin = {
  type: 'Begin',
  id: '9a4b1c2d',
  expires_at: 1772570132,
  configuration: { model: 'universal-3-5-pro', mode: 'balanced', api_version: '2025-05-12' },
};
const turn = (transcript: string, o: { order: number; end?: boolean; formatted?: boolean }) => ({
  type: 'Turn',
  turn_order: o.order,
  turn_is_formatted: o.formatted ?? false,
  end_of_turn: o.end ?? false,
  transcript,
  end_of_turn_confidence: o.end ? 0.97 : 0.1,
  words: transcript
    .split(' ')
    .filter(Boolean)
    .map((text, i) => ({
      text,
      start: i * 300,
      end: i * 300 + 250,
      confidence: 0.9,
      word_is_final: o.end ?? false,
    })),
});

async function openSession(
  overrides: Partial<ConstructorParameters<typeof AssemblyAIRecognizer>[0]> = {},
  language = 'en-GB',
) {
  const { factory, sockets } = fakeSockets();
  const c = collect();
  const aai = new AssemblyAIRecognizer({ apiKey: 'aai-key', sockets: factory, ...overrides });
  const opening = aai.open({ language, sampleRate: 16000, ...c.handlers });
  const socket = sockets[0] as FakeSocket;
  socket.serverOpen();
  socket.serverJson(begin);
  const session = await opening;
  return { session, socket, c };
}

describe('AssemblyAIRecognizer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects with the v3 URL, the raw API key header and language_codes for 3.5 Pro', async () => {
    const { session, socket } = await openSession();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      speech_model: 'universal-3-5-pro',
      language_codes: '["en"]',
    });
    expect(socket.init.headers).toEqual({ Authorization: 'aai-key' });
    session.pushAudio(pcm(300));
    expect(socket.sentBinary.map((f) => f.length)).toEqual([8000, 1600]);
    session.close();
    expect(socket.controls.at(-1)).toEqual({ type: 'Terminate' });
  });

  it('omits language_codes for languages 3.5 Pro does not list, and asks universal-streaming models for formatted turns', () => {
    const pro = new AssemblyAIRecognizer({ apiKey: 'k' });
    expect(new URL(pro.buildUrl('fa-IR')).searchParams.has('language_codes')).toBe(false);
    const legacy = new AssemblyAIRecognizer({ apiKey: 'k', model: 'universal-streaming-english' });
    const params = new URL(legacy.buildUrl('en-US')).searchParams;
    expect(params.get('format_turns')).toBe('true');
    expect(params.has('language_codes')).toBe(false);
  });

  it('emits partials for in-progress turns and one formatted final on end_of_turn (3.5 Pro)', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson(turn('what is', { order: 0 }));
    socket.serverJson(turn('what is a closure', { order: 0 }));
    session.endUtterance();
    expect(socket.controls.at(-1)).toEqual({ type: 'ForceEndpoint' });
    socket.serverJson(turn('What is a closure?', { order: 0, end: true, formatted: true }));
    expect(c.partials).toEqual(['what is', 'what is a closure']);
    expect(c.finals).toEqual(['What is a closure?']);
  });

  it('joins turns the provider ended before the client did', async () => {
    const { session, socket, c } = await openSession();
    socket.serverJson(turn('Okay.', { order: 0, end: true, formatted: true }));
    socket.serverJson(turn('so how', { order: 1 }));
    socket.serverJson(turn('So how does it work?', { order: 1, end: true, formatted: true }));
    expect(c.finals).toEqual([]);
    session.endUtterance();
    expect(c.finals).toEqual(['Okay. So how does it work?']);
    expect(socket.controls.some((m) => m.type === 'ForceEndpoint')).toBe(false);
  });

  it('waits for the formatted twin of an end-of-turn Turn on universal-streaming models', async () => {
    const { session, socket, c } = await openSession({ model: 'universal-streaming-english' });
    socket.serverJson(turn('hello world', { order: 0, end: true, formatted: false }));
    socket.serverJson(turn('Hello, world.', { order: 0, end: true, formatted: true }));
    session.endUtterance();
    expect(c.finals).toEqual(['Hello, world.']);
  });

  it('falls back to the unformatted text when the formatted twin never arrives', async () => {
    const { session, socket, c } = await openSession({
      model: 'universal-streaming-english',
      formatTimeoutMs: 400,
    });
    session.pushAudio(pcm(300));
    session.endUtterance();
    socket.serverJson(turn('hello world', { order: 0, end: true, formatted: false }));
    vi.advanceTimersByTime(400);
    expect(c.finals).toEqual(['hello world']);
  });

  it('delivers what it heard if ForceEndpoint is not answered in time', async () => {
    const { session, socket, c } = await openSession({ endpointTimeoutMs: 800 });
    socket.serverJson(turn('half a sentence', { order: 0 }));
    session.endUtterance();
    vi.advanceTimersByTime(800);
    expect(c.finals).toEqual(['half a sentence']);
  });

  it('surfaces in-band Error frames and close codes', async () => {
    const { socket, c } = await openSession();
    socket.serverJson({ type: 'Error', error_code: 3005, error: 'Session Cancelled' });
    expect(c.errors.map((e) => e.code)).toEqual(['PEN_STT_UPSTREAM_ERROR']);

    const second = await openSession();
    second.socket.serverClose(3009, 'Too many concurrent sessions');
    expect(second.c.errors.map((e) => e.code)).toEqual(['PEN_STT_UNAUTHORIZED']);
  });

  it('rejects open when Begin never arrives', async () => {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const aai = new AssemblyAIRecognizer({ apiKey: 'k', sockets: factory, connectTimeoutMs: 2000 });
    const opening = aai.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    (sockets[0] as FakeSocket).serverOpen();
    vi.advanceTimersByTime(2000);
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_CONNECT_FAILED' });
  });

  it('rejects open when the key is refused before Begin', async () => {
    const { factory, sockets } = fakeSockets();
    const c = collect();
    const aai = new AssemblyAIRecognizer({ apiKey: 'bad', sockets: factory });
    const opening = aai.open({ language: 'en', sampleRate: 16000, ...c.handlers });
    const socket = sockets[0] as FakeSocket;
    socket.serverOpen();
    socket.serverClose(1008, 'Unauthorized Connection: Missing Authorization header');
    await expect(opening).rejects.toMatchObject({ code: 'PEN_STT_UNAUTHORIZED' });
  });
});
