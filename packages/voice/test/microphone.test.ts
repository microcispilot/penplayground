import { describe, expect, it } from 'vitest';
import { Microphone } from '../src/client/microphone.js';

/**
 * The microphone's startup, on the one step that has already failed in
 * production without a word (ADR-0053): `audioWorklet.addModule` on a blob:
 * URL the page's Content-Security-Policy refuses. Chrome rejects that with a
 * bare `AbortError` — the same name a cancelled start() carries — and the
 * microphone read it as "the user stopped", set `idle`, and reported nothing.
 * The room then started the recognizer on top of a microphone that was not
 * listening, and every question during playback was dropped as echo.
 *
 * Everything below the seams is a fake: a stream with one live track, an
 * AudioContext whose worklet refuses the module. What is asserted is the
 * contract: `onError` exactly once, with a code of ours, and `state`
 * `error` — never a silent `idle`.
 */
class FakeTrack {
  readonly kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  enabled = true;
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  stop(): void {
    this.readyState = 'ended';
  }
}
function fakeStream(): MediaStream {
  const track = new FakeTrack();
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}
function refusingContext(reason: unknown): AudioContext {
  return {
    sampleRate: 48_000,
    state: 'suspended',
    audioWorklet: { addModule: () => Promise.reject(reason) },
    close: () => Promise.resolve(),
  } as unknown as AudioContext;
}

async function startAgainst(reason: unknown) {
  const errors: Array<{ code: string; error: unknown }> = [];
  const states: string[] = [];
  const mic = new Microphone({
    workletSource: 'registerProcessor("x", class extends AudioWorkletProcessor {})',
    createResamplerWorker: () => ({ terminate() {}, postMessage() {} }) as unknown as Worker,
    getUserMedia: () => Promise.resolve(fakeStream()),
    createAudioContext: () => refusingContext(reason),
    onError: (code, error) => errors.push({ code, error }),
    onStateChange: (state) => states.push(state),
  });
  await mic.start();
  return { mic, errors, states };
}

describe('a worklet the page refuses', () => {
  it("is reported as the microphone's own failure, never as the user stopping it", async () => {
    // What Chrome actually throws for a CSP-refused module: name only.
    const refusal = new DOMException(
      'Failed to load worklet module script: blob:http://x/y (a dependency or cross-origin script failed to load)',
      'AbortError',
    );
    const { mic, errors, states } = await startAgainst(refusal);
    const [first] = errors;
    expect(errors).toHaveLength(1);
    expect(first?.code).toBe('PEN_MICROPHONE_WORKLET_FAILED');
    expect((first?.error as Error | undefined)?.cause).toBe(refusal);
    expect(mic.state).toBe('error');
    expect(states).toEqual(['starting', 'error']);
  });

  it('a stop() during the module load is still a quiet idle, not an error', async () => {
    const errors: string[] = [];
    let release: (() => void) | undefined;
    const mic = new Microphone({
      workletSource: '',
      createResamplerWorker: () => ({ terminate() {}, postMessage() {} }) as unknown as Worker,
      getUserMedia: () => Promise.resolve(fakeStream()),
      createAudioContext: () =>
        ({
          sampleRate: 48_000,
          state: 'suspended',
          audioWorklet: {
            addModule: () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          },
          close: () => Promise.resolve(),
        }) as unknown as AudioContext,
      onError: (code) => errors.push(code),
    });
    const started = mic.start();
    // Let the grant resolve and the module load begin.
    await new Promise((r) => setTimeout(r, 0));
    mic.stop();
    release?.();
    await started;
    expect(errors).toEqual([]);
    expect(mic.state).toBe('idle');
  });
});
