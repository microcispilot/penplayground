import type { SpeechRecognizerHandlers } from '@pen/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSpeechRecognizer } from '../src/speech.web.js';

/**
 * A stand-in for the browser's recognizer that records what was asked of it and
 * lets a test decide what the device does: a machine with a microphone, or one
 * without, which fails the instant it is started.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  /** How many times the page asked this recognizer to listen. */
  starts = 0;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  /** Set by a test: the error the device raises as soon as it is started. */
  static failWith: string | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.starts += 1;
    if (FakeRecognition.failWith) {
      const code = FakeRecognition.failWith;
      queueMicrotask(() => {
        this.onerror?.({ error: code });
        this.onend?.();
      });
    }
  }

  stop(): void {
    this.onend?.();
  }
}

function install(): void {
  FakeRecognition.instances = [];
  FakeRecognition.failWith = null;
  (globalThis as { window?: unknown }).window = {
    SpeechRecognition: FakeRecognition as unknown,
  };
}

function handlers(): SpeechRecognizerHandlers & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onError: (code) => {
      errors.push(code);
    },
  };
}

/** Let every queued microtask and every pending timer run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

describe('the browser recognizer on a device with no microphone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    install();
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { window?: unknown }).window = undefined;
  });

  it('says so once and stops, instead of restarting into the same failure', async () => {
    FakeRecognition.failWith = 'audio-capture';
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    await rec.start();
    await settle();

    // One report, not one per frame: this is what floods Sentry and the
    // session's error list when a laptop has no microphone attached.
    expect(h.errors).toEqual(['audio-capture']);
    // And nothing restarted: the first attempt is the only attempt.
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0]?.starts).toBe(1);
    rec.stop();
  });

  it('reports permission refusal once as well', async () => {
    FakeRecognition.failWith = 'not-allowed';
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    await rec.start();
    await settle();
    expect(h.errors).toEqual(['not-allowed']);
    rec.stop();
  });
});

describe('the browser recognizer when the device works', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    install();
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { window?: unknown }).window = undefined;
  });

  it('comes back after the browser ends a quiet stretch, with a growing pause', async () => {
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    await rec.start();
    const only = FakeRecognition.instances[0];
    expect(only).toBeDefined();
    if (!only) return;
    expect(only.starts).toBe(1);

    // Chrome ends continuous recognition after silence. The first restart is
    // immediate, so a real pause in speech costs the learner nothing.
    only.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(only.starts).toBe(2);

    // A recognizer that keeps ending at once is backed off rather than spun.
    only.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(only.starts, 'the second restart waits').toBe(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(only.starts).toBe(3);

    expect(h.errors).toEqual([]);
    rec.stop();
  });

  it('never makes a learner who simply went quiet wait for the backoff', async () => {
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    await rec.start();
    const only = FakeRecognition.instances[0];
    if (!only) throw new Error('no recognizer');

    // Two quick ends in a row put the backoff up.
    only.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    only.onend?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(only.starts).toBe(3);

    // Then a real run: the learner listened, said nothing, and Chrome ended it
    // after its own silence timeout. The next restart must be immediate.
    await vi.advanceTimersByTimeAsync(30_000);
    only.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(only.starts, 'a healthy run clears the backoff').toBe(4);
    rec.stop();
  });

  it('stops restarting once the room stops it', async () => {
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    await rec.start();
    const only = FakeRecognition.instances[0];
    if (!only) throw new Error('no recognizer');
    only.onend?.();
    rec.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(only.starts).toBe(1);
  });
});

describe('the browser recognizer where there is none', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {};
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = undefined;
  });

  it('is not available, and says so once', async () => {
    const h = handlers();
    const rec = new WebSpeechRecognizer(h, 'en-US');
    expect(rec.available).toBe(false);
    await rec.start();
    await rec.start();
    expect(h.errors).toEqual(['unavailable']);
  });
});
