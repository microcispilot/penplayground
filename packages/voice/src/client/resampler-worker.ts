/**
 * Utterance resampler worker. A complete utterance (up to 20 s of 48 kHz
 * float) is resampled off the main thread so the windowed-sinc pass can never
 * stall the UI or the capture acknowledgement loop.
 *
 * Protocol (one request in flight at a time, enforced by the microphone):
 *   request  → { id: number, sourceSampleRate: number, samples: Float32Array }
 *              (samples transferred)
 *   response → { id, pcmS16leBytes: Uint8Array }  (bytes transferred)
 *            | { id, error: 'PEN_RESAMPLER_FAILED' }
 *            | { id: null, error: 'PEN_RESAMPLER_PROTOCOL_FAILED' }
 *
 * The request's samples are zeroed after use regardless of outcome: raw
 * microphone audio never lingers in worker memory until garbage collection.
 *
 * Bundle as a module worker (Vite: `new Worker(new URL('./resampler-worker',
 * import.meta.url), { type: 'module' })` or `?worker&inline`), then hand the
 * factory to `Microphone` via `createResamplerWorker`.
 */

import { resampleMonoToPcmS16le } from './pcm-resampler.js';

interface ResampleRequest {
  readonly id: number;
  readonly sourceSampleRate: number;
  readonly samples: Float32Array;
}

/** The subset of DedicatedWorkerGlobalScope this worker touches. Declared
 * structurally so this file type-checks inside the package's DOM-lib program
 * (the `webworker` lib cannot coexist with `dom` in one tsconfig). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<unknown>) => {
  const value = event.data as Partial<ResampleRequest> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isInteger(value.id) ||
    typeof value.sourceSampleRate !== 'number' ||
    !(value.samples instanceof Float32Array)
  ) {
    scope.postMessage({ id: null, error: 'PEN_RESAMPLER_PROTOCOL_FAILED' });
    return;
  }
  const samples = value.samples;
  try {
    const pcmS16leBytes = resampleMonoToPcmS16le(samples, value.sourceSampleRate);
    scope.postMessage({ id: value.id, pcmS16leBytes }, [pcmS16leBytes.buffer]);
  } catch {
    scope.postMessage({ id: value.id, error: 'PEN_RESAMPLER_FAILED' });
  } finally {
    samples.fill(0);
  }
};

export {};
