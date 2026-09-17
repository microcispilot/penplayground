import type {
  RecognizerOpenOptions,
  RecognizerSession,
  SpeechRecognizerFactory,
  SttErrorCode,
} from '@pen/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecognizerRouter, type RecognizerRouterOptions } from '../src/recognizer-router.js';

class FakeSession implements RecognizerSession {
  readonly pushed: number[] = [];
  ends = 0;
  closed = false;
  constructor(readonly o: RecognizerOpenOptions) {}
  pushAudio(pcm: Uint8Array): void {
    this.pushed.push(pcm.length);
  }
  endUtterance(): void {
    this.ends += 1;
  }
  close(): void {
    this.closed = true;
  }
}

/** A factory whose `open` the test settles by hand. */
function fakeFactory() {
  const sessions: FakeSession[] = [];
  const opens: { resolve(): void; reject(e: unknown): void }[] = [];
  const factory: SpeechRecognizerFactory = {
    id: 'fake',
    open: (o) =>
      new Promise<RecognizerSession>((resolve, reject) => {
        const s = new FakeSession(o);
        sessions.push(s);
        opens.push({ resolve: () => resolve(s), reject });
      }),
  };
  return { factory, sessions, opens };
}

function harness(overrides: Partial<ConstructorParameters<typeof RecognizerRouter>[0]> = {}) {
  const f = fakeFactory();
  const transcripts: [string, string, boolean][] = [];
  const errors: { code: SttErrorCode; utteranceId: string | null }[] = [];
  const events: string[] = [];
  const router = new RecognizerRouter({
    factory: f.factory,
    language: () => 'de-DE',
    onTranscript: (id, text, final) => transcripts.push([id, text, final]),
    onError: (code, _e, ctx) => errors.push({ code, utteranceId: ctx.utteranceId }),
    onEvent: (name) => events.push(name),
    ...overrides,
  });
  return { ...f, router, transcripts, errors, events };
}

const pcm = (bytes: number) => new Uint8Array(bytes);

describe('RecognizerRouter', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('opens one session with the room language, buffers audio until open, then replays in order', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.router.audio('u1', pcm(5120));
    h.router.audio('u1', pcm(5120));
    h.router.utteranceEnd('u1');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.o.language).toBe('de-DE');
    expect(h.sessions[0]?.pushed).toEqual([]);
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions[0]?.pushed).toEqual([5120, 5120]);
    expect(h.sessions[0]?.ends).toBe(1);
    expect(h.events).toContain('stt.session_open');
  });

  it('maps partials and finals onto the client utterance ids and drops empty finals', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.audio('u1', pcm(3200));
    s.o.onPartial('hal');
    s.o.onPartial('hallo');
    h.router.utteranceEnd('u1');
    s.o.onFinal('Hallo Welt');
    h.router.utteranceStart('u2');
    h.router.audio('u2', pcm(3200));
    h.router.utteranceEnd('u2');
    s.o.onFinal('');
    expect(h.sessions).toHaveLength(1);
    expect(s.pushed).toEqual([3200, 3200]);
    expect(h.transcripts).toEqual([
      ['u1', 'hal', false],
      ['u1', 'hallo', false],
      ['u1', 'Hallo Welt', true],
    ]);
  });

  it('ignores audio for an utterance that is not current or already ended', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.audio('stale', pcm(100));
    h.router.utteranceEnd('u1');
    h.router.audio('u1', pcm(100));
    expect(s.pushed).toEqual([]);
    expect(s.ends).toBe(1);
  });

  it('caps an utterance at the byte budget and ends it for the client', async () => {
    const h = harness({ maxUtteranceBytes: 10_000 });
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.audio('u1', pcm(8000));
    h.router.audio('u1', pcm(8000));
    h.router.audio('u1', pcm(8000));
    expect(s.pushed).toEqual([8000, 2000]);
    expect(s.ends).toBe(1);
    expect(h.events).toContain('stt.utterance_capped');
    // The client's own utterance_end after the cap is a no-op.
    h.router.utteranceEnd('u1');
    expect(s.ends).toBe(1);
  });

  it('reports provider errors with the utterance in flight, drops the session and reopens on the next utterance', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.sessions[0] as FakeSession;
    first.o.onError('PEN_STT_UPSTREAM_ERROR', new Error('boom'));
    expect(h.errors).toEqual([{ code: 'PEN_STT_UPSTREAM_ERROR', utteranceId: 'u1' }]);
    expect(first.closed).toBe(true);
    // Late callbacks from the dead session are ignored.
    first.o.onFinal('ghost');
    expect(h.transcripts).toEqual([]);

    h.router.utteranceStart('u2');
    expect(h.sessions).toHaveLength(2);
    h.opens[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    h.router.audio('u2', pcm(64));
    expect(h.sessions[1]?.pushed).toEqual([64]);
  });

  it('surfaces a failed open as an error', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.opens[0]?.reject(Object.assign(new Error('refused'), { code: 'PEN_STT_UNAUTHORIZED' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.errors).toEqual([{ code: 'PEN_STT_UNAUTHORIZED', utteranceId: 'u1' }]);
  });

  it('closes an idle session after the idle window and reopens for the next utterance', async () => {
    const h = harness({ idleCloseMs: 5000 });
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.utteranceEnd('u1');
    s.o.onFinal('done');
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.closed).toBe(true);
    expect(h.events).toContain('stt.session_idle_close');
    h.router.utteranceStart('u2');
    expect(h.sessions).toHaveLength(2);
  });

  it('closes the session with the socket, even while it is still opening', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.router.close();
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions[0]?.closed).toBe(true);
    h.router.utteranceStart('u2');
    expect(h.sessions).toHaveLength(1);
  });

  it('reports endpoint-to-final latency and recognised audio per utterance', async () => {
    vi.setSystemTime(10_000);
    const done: Parameters<NonNullable<RecognizerRouterOptions['onUtteranceDone']>>[0][] = [];
    const h = harness({ onUtteranceDone: (info) => done.push(info) });
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.audio('u1', pcm(32_000)); // 1000 ms of 16 kHz s16le
    vi.setSystemTime(11_000);
    h.router.utteranceEnd('u1');
    vi.setSystemTime(11_340);
    s.o.onFinal('Hallo Welt');
    expect(done).toEqual([
      { utteranceId: 'u1', finalMs: 340, audioMs: 1000, chars: 10, startedAt: 10_000 },
    ]);
    // A final that lands before the endpoint has no endpoint latency.
    h.router.utteranceStart('u2');
    h.router.audio('u2', pcm(3200));
    s.o.onFinal('early');
    expect(done[1]).toMatchObject({ utteranceId: 'u2', finalMs: null, audioMs: 100, chars: 5 });
  });

  it('ends a still-open utterance when the client starts the next one', async () => {
    const h = harness();
    h.router.utteranceStart('u1');
    h.opens[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const s = h.sessions[0] as FakeSession;
    h.router.utteranceStart('u2');
    expect(s.ends).toBe(1);
    s.o.onFinal('first');
    s.o.onFinal('second');
    expect(h.transcripts).toEqual([
      ['u1', 'first', true],
      ['u2', 'second', true],
    ]);
  });
});
