import {
  CAPTURE_SAMPLE_RATE_HZ,
  MAX_UTTERANCE_PCM_BYTES,
  MIN_UTTERANCE_PCM_BYTES,
  STT_PCM_BYTES_PER_SECOND,
} from './constants.js';
import { UtteranceSegmenter } from './utterance-segmenter.js';

/** Name the capture processor registers itself under (see capture-processor.js). */
export const CAPTURE_PROCESSOR_NAME = 'pen-utterance-capture-v1';

export type MicrophoneState = 'idle' | 'starting' | 'listening' | 'denied' | 'error';

export interface MicrophoneOptions {
  /** Source text of `capture-processor.js` (import it with Vite `?raw`). It is
   * loaded from a `blob:` URL so the worklet never depends on the app's URL
   * scheme or bundler output layout. */
  readonly workletSource: string;
  /** Factory for the resampler worker (`resampler-worker.ts` bundled as a
   * module worker). The microphone owns and terminates the instance. */
  readonly createResamplerWorker: () => Worker;
  /** Confirmed speech (240 ms voiced, 120 ms harmonic) — the barge-in signal. */
  readonly onSpeechStart?: () => void;
  /** The confirmed utterance ended (800 ms silence, the 20 s cap, or mute). */
  readonly onSpeechEnd?: () => void;
  /** 160 ms blocks of 16 kHz s16le mono, streamed while speaking; the first
   * block carries the pre-roll catch-up. Only emitted between
   * `onSpeechStart` and `onSpeechEnd`. */
  readonly onUtteranceBlock?: (pcm16k: Uint8Array) => void;
  /** The whole utterance (pre-roll included) as 16 kHz s16le mono, after
   * `onSpeechEnd`. Absent only when the utterance was revoked (mute/stop)
   * or a failure was reported through `onError`. */
  readonly onUtteranceComplete?: (pcm16k: Uint8Array, durationMs: number) => void;
  /** Input RMS (0..1) for the UI meter, throttled to ~20 Hz; `0` on mute. */
  readonly onLevel?: (rms: number) => void;
  /** Every failure lands here exactly once, with its `PEN_MICROPHONE_*` /
   * `PEN_RESAMPLER_*` code and the underlying error when there is one. Fatal
   * failures also move `state` to `denied` or `error` and release the mic. */
  readonly onError: (code: string, error: unknown) => void;
  readonly onStateChange?: (state: MicrophoneState) => void;
  /** Sustained digital silence while the mic is on (wrong input device, dead
   * Bluetooth earphones): fired at most once per `start()`. */
  readonly onNoInputSignal?: () => void;
  /** Real signal returned after a no-input episode. */
  readonly onInputSignalRestored?: () => void;
  /** Pin a specific input device; default lets the browser choose. */
  readonly deviceId?: string;
  /** Platform seams (tests, Electron): default to the browser globals. */
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createAudioContext?: () => AudioContext;
}

interface CaptureResources {
  readonly stream: MediaStream | undefined;
  readonly context: AudioContext | undefined;
  readonly source: MediaStreamAudioSourceNode | undefined;
  readonly processor: AudioWorkletNode | undefined;
  readonly silentGain: GainNode | undefined;
  readonly segmenter: UtteranceSegmenter | undefined;
  readonly resampler: Worker | undefined;
}

/** UI meter cadence: 50 ms is smooth at 60 fps without flooding React. */
const LEVEL_INTERVAL_MS = 50;
/** True digital silence for this long is a dead input, not a quiet room. */
const NO_INPUT_SIGNAL_SECONDS = 12;
/** Only essentially exact zeros count — a working mic in a silent room still
 * carries a noise floor well above this. */
const NO_INPUT_PEAK = 0.0002;

function abortError(): DOMException {
  return new DOMException('Microphone start cancelled.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.onmute = null;
    track.stop();
  }
}

function zeroResponseBytes(value: unknown): void {
  if (
    typeof value === 'object' &&
    value !== null &&
    'pcmS16leBytes' in value &&
    value.pcmS16leBytes instanceof Uint8Array
  ) {
    value.pcmS16leBytes.fill(0);
  }
}

function workletSamples(value: unknown): Float32Array | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'samples' in value &&
    value.samples instanceof Float32Array
    ? value.samples
    : undefined;
}

function frameRms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Map a getUserMedia rejection to a state and a stable code. */
function classifyUserMediaError(error: unknown): { state: MicrophoneState; code: string } {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { state: 'denied', code: 'PEN_MICROPHONE_DENIED' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { state: 'error', code: 'PEN_MICROPHONE_NOT_FOUND' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { state: 'error', code: 'PEN_MICROPHONE_NOT_READABLE' };
    default:
      return { state: 'error', code: 'PEN_MICROPHONE_START_FAILED' };
  }
}

async function addWorkletFromSource(context: AudioContext, source: string): Promise<void> {
  // Loaded from a blob: URL built from the SOURCE TEXT. Loading over the
  // app's own scheme is not an option: Electron routes worklet module
  // requests through a loader path that bypasses custom protocol handlers
  // (Simurgh: addModule() aborted with "Unable to load a worklet's module"
  // in packaged builds and the AI human could never hear). A blob works in
  // every host.
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

/**
 * Owns one explicit microphone grant and every resource derived from it:
 * the MediaStream, a 48 kHz AudioContext, the capture worklet, the
 * utterance segmenter and the resampler worker.
 *
 * Per utterance the callbacks fire in exactly this order:
 * `onSpeechStart` → `onUtteranceBlock`* → `onSpeechEnd` → `onUtteranceComplete`.
 *
 * Mute is a custody boundary, not track gain: on every `setMuted` transition
 * the capture epoch advances, the worklet fences frames produced under the
 * old epoch, the segmenter drops its buffers and an in-flight resample is
 * invalidated, so audio captured before mute can never surface after unmute.
 */
export class Microphone {
  readonly #options: MicrophoneOptions;
  #state: MicrophoneState = 'idle';
  #stream: MediaStream | undefined;
  #context: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #processor: AudioWorkletNode | undefined;
  #silentGain: GainNode | undefined;
  #segmenter: UtteranceSegmenter | undefined;
  #resampler: Worker | undefined;
  #resampleInFlight = false;
  #resampleRequestId = 0;
  #resampleEpoch: number | undefined;
  #microphoneInputEpoch = 1;
  #muted = false;
  #playbackActive = false;
  #currentUtteranceEpoch: number | undefined;
  #generation = 0;
  #expectedSequence = 0;
  #startupAbort: AbortController | undefined;
  #silentInputSamples = 0;
  #noInputSignalFired = false;
  // Once per capture: the notice is a diagnosis, not a nag.
  #noInputSignalSpent = false;
  #levelPeak = 0;
  #levelLastEmitMs = 0;

  constructor(options: MicrophoneOptions) {
    this.#options = options;
  }

  get state(): MicrophoneState {
    return this.#state;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Request the microphone and begin listening. Resolves once the pipeline
   * is live or once the failure has been reported: this method never
   * rejects, `onError` is the single failure channel and `state` tells the
   * outcome (`listening`, `denied`, `error`, or `idle` if `stop()` raced).
   */
  async start(): Promise<void> {
    if (this.#state === 'starting' || this.#state === 'listening') return;
    this.#setState('starting');
    const generation = this.#generation + 1;
    this.#generation = generation;
    const startupAbort = new AbortController();
    this.#startupAbort = startupAbort;

    let stream: MediaStream;
    try {
      const getUserMedia =
        this.#options.getUserMedia ??
        ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
      stream = await this.#awaitStartupStep(
        getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            ...(this.#options.deviceId === undefined
              ? {}
              : { deviceId: { exact: this.#options.deviceId } }),
          },
          video: false,
        }),
        startupAbort.signal,
      );
    } catch (error: unknown) {
      if (isAbortError(error) && startupAbort.signal.aborted) {
        // stop() during the permission prompt: not a failure.
        if (this.#generation === generation) this.#setState('idle');
        return;
      }
      const { state, code } = classifyUserMediaError(error);
      if (this.#generation === generation) {
        this.#startupAbort = undefined;
        this.#setState(state);
      }
      this.#options.onError(code, error);
      return;
    }
    if (generation !== this.#generation) {
      // stop() won the race after the grant resolved: release it immediately.
      stopTracks(stream);
      return;
    }
    this.#stream = stream;
    for (const track of stream.getTracks()) {
      track.onended = () =>
        this.#fail(generation, 'PEN_MICROPHONE_TRACK_ENDED', new Error('track ended'));
      track.onmute = () =>
        this.#fail(generation, 'PEN_MICROPHONE_TRACK_MUTED', new Error('track muted by platform'));
      if (track.readyState !== 'live' || track.muted) {
        this.#fail(
          generation,
          track.readyState !== 'live' ? 'PEN_MICROPHONE_TRACK_ENDED' : 'PEN_MICROPHONE_TRACK_MUTED',
          new Error(`track unavailable: readyState=${track.readyState} muted=${track.muted}`),
        );
        return;
      }
      track.enabled = !this.#muted;
    }

    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: AudioWorkletNode | undefined;
    let silentGain: GainNode | undefined;
    let segmenter: UtteranceSegmenter | undefined;
    let resampler: Worker | undefined;
    try {
      context =
        this.#options.createAudioContext?.() ??
        new AudioContext({ latencyHint: 'interactive', sampleRate: CAPTURE_SAMPLE_RATE_HZ });
      this.#context = context;
      await this.#awaitStartupStep(
        addWorkletFromSource(context, this.#options.workletSource),
        startupAbort.signal,
      );
      this.#assertGeneration(generation);

      source = context.createMediaStreamSource(stream);
      this.#source = source;
      processor = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.#processor = processor;
      processor.port.postMessage({ microphoneInputEpoch: this.#microphoneInputEpoch });
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      this.#silentGain = silentGain;
      resampler = this.#options.createResamplerWorker();
      this.#resampler = resampler;
      this.#resampleInFlight = false;
      this.#expectedSequence = 0;
      this.#silentInputSamples = 0;
      this.#noInputSignalFired = false;
      this.#noInputSignalSpent = false;
      this.#levelPeak = 0;
      this.#levelLastEmitMs = 0;

      this.#wireResampler(generation, resampler);
      segmenter = this.#createSegmenter(generation, context.sampleRate, resampler);
      this.#segmenter = segmenter;
      this.#wireProcessor(generation, processor, segmenter, context.sampleRate);

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      await this.#awaitStartupStep(context.resume(), startupAbort.signal);
      this.#assertGeneration(generation);
      if (context.state !== 'running') {
        throw new Error('PEN_MICROPHONE_AUDIO_CONTEXT_SUSPENDED');
      }
      if (this.#startupAbort === startupAbort) this.#startupAbort = undefined;
      this.#setState('listening');
    } catch (error: unknown) {
      const aborted = isAbortError(error);
      if (generation === this.#generation) {
        // Still ours: release what this attempt created. When stop() or a
        // fatal callback already advanced the generation, teardown covered
        // these same resources (every one is assigned to a field the moment
        // it is created), so a second pass would only report false errors.
        this.#cleanupGeneration(generation, {
          stream,
          context,
          source,
          processor,
          silentGain,
          segmenter,
          resampler,
        });
      }
      if (aborted) {
        if (this.#state === 'starting') this.#setState('idle');
        return;
      }
      this.#setState('error');
      const code =
        error instanceof Error && error.message.startsWith('PEN_')
          ? error.message
          : 'PEN_MICROPHONE_START_FAILED';
      this.#options.onError(code, error);
    }
  }

  /** Release the microphone and every derived resource. Safe to call in any
   * state, including mid-`start()`. */
  stop(): void {
    this.#teardown();
    this.#setState('idle');
  }

  /** Mute is a custody boundary: pre-mute audio is dropped everywhere and
   * can never be admitted after unmute (see class doc). */
  setMuted(muted: boolean): void {
    if (muted === this.#muted) return;
    this.#muted = muted;
    this.#microphoneInputEpoch += 1;
    const epoch = this.#microphoneInputEpoch;
    if (this.#stream !== undefined) {
      for (const track of this.#stream.getAudioTracks()) track.enabled = !muted;
    }
    this.#segmenter?.clear();
    this.#currentUtteranceEpoch = undefined;
    this.#silentInputSamples = 0;
    this.#resampleEpoch = undefined;
    if (this.#resampleInFlight) {
      this.#resampleInFlight = false;
      this.#resampleRequestId += 1;
    }
    if (muted) {
      this.#levelPeak = 0;
      this.#options.onLevel?.(0);
    }
    if (this.#processor !== undefined) {
      try {
        this.#processor.port.postMessage({ microphoneInputEpoch: epoch });
      } catch (error: unknown) {
        this.#fail(this.#generation, 'PEN_MICROPHONE_WORKLET_PROTOCOL_FAILED', error);
      }
    }
  }

  /** While the expert's voice plays the segmenter raises its bar so speaker
   * bleed cannot open the mic; confirmed words still barge in. */
  setPlaybackActive(active: boolean): void {
    this.#playbackActive = active;
  }

  #setState(state: MicrophoneState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }

  #wireResampler(generation: number, resampler: Worker): void {
    resampler.onmessage = (event: MessageEvent<unknown>) => {
      if (generation !== this.#generation || this.#resampler !== resampler) {
        zeroResponseBytes(event.data);
        return;
      }
      const value = event.data;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        !Number.isSafeInteger(value.id)
      ) {
        zeroResponseBytes(value);
        this.#fail(generation, 'PEN_RESAMPLER_PROTOCOL_FAILED', value);
        return;
      }
      const responseId = value.id as number;
      if (responseId < this.#resampleRequestId) {
        // Mute invalidated a request already running in the worker. Its late
        // output is expected revoked data, not a protocol failure.
        zeroResponseBytes(value);
        return;
      }
      if (responseId !== this.#resampleRequestId) {
        zeroResponseBytes(value);
        this.#fail(generation, 'PEN_RESAMPLER_PROTOCOL_FAILED', value);
        return;
      }
      this.#resampleInFlight = false;
      if (
        'error' in value ||
        !('pcmS16leBytes' in value) ||
        !(value.pcmS16leBytes instanceof Uint8Array) ||
        value.pcmS16leBytes.byteLength < MIN_UTTERANCE_PCM_BYTES ||
        value.pcmS16leBytes.byteLength > MAX_UTTERANCE_PCM_BYTES ||
        value.pcmS16leBytes.byteLength % 2 !== 0
      ) {
        zeroResponseBytes(value);
        this.#fail(generation, 'PEN_RESAMPLER_FAILED', value);
        return;
      }
      const epoch = this.#resampleEpoch;
      this.#resampleEpoch = undefined;
      if (epoch === undefined || epoch !== this.#microphoneInputEpoch) {
        value.pcmS16leBytes.fill(0);
        return;
      }
      const bytes = value.pcmS16leBytes;
      const durationMs = Math.round((bytes.byteLength * 1_000) / STT_PCM_BYTES_PER_SECOND);
      try {
        this.#options.onUtteranceComplete?.(bytes, durationMs);
      } catch (error: unknown) {
        this.#options.onError('PEN_MICROPHONE_CALLBACK_FAILED', error);
      }
    };
    resampler.onerror = (event) => this.#fail(generation, 'PEN_RESAMPLER_FAILED', event);
  }

  #createSegmenter(
    generation: number,
    sourceSampleRate: number,
    resampler: Worker,
  ): UtteranceSegmenter {
    return new UtteranceSegmenter({
      sourceSampleRate,
      playbackActive: () => this.#playbackActive,
      onSpeechStart: () => {
        this.#currentUtteranceEpoch = this.#microphoneInputEpoch;
        this.#options.onSpeechStart?.();
      },
      onSpeechEnd: () => {
        this.#options.onSpeechEnd?.();
      },
      onUtteranceStreamOpen: () => undefined,
      onUtteranceStreamChunk: (_utteranceId, bytes) => {
        if (this.#currentUtteranceEpoch !== this.#microphoneInputEpoch) {
          bytes.fill(0);
          return;
        }
        this.#options.onUtteranceBlock?.(bytes);
      },
      onUtteranceStreamEnd: () => undefined,
      // Never reached: onUtteranceSamples takes precedence in the segmenter.
      onUtterance: (bytes) => bytes.fill(0),
      onUtteranceSamples: (samples, rate) => {
        if (
          generation !== this.#generation ||
          this.#resampleInFlight ||
          this.#resampler !== resampler
        ) {
          samples.fill(0);
          this.#fail(generation, 'PEN_RESAMPLER_BACKPRESSURE', undefined);
          return;
        }
        const epoch = this.#currentUtteranceEpoch;
        this.#currentUtteranceEpoch = undefined;
        if (epoch === undefined || epoch !== this.#microphoneInputEpoch) {
          samples.fill(0);
          return;
        }
        this.#resampleInFlight = true;
        this.#resampleRequestId += 1;
        this.#resampleEpoch = epoch;
        try {
          resampler.postMessage(
            { id: this.#resampleRequestId, sourceSampleRate: rate, samples },
            [samples.buffer],
          );
        } catch (error: unknown) {
          samples.fill(0);
          this.#fail(generation, 'PEN_RESAMPLER_FAILED', error);
        }
      },
    });
  }

  #wireProcessor(
    generation: number,
    processor: AudioWorkletNode,
    segmenter: UtteranceSegmenter,
    sampleRate: number,
  ): void {
    processor.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      const samples = workletSamples(data);
      if (generation !== this.#generation || this.#processor !== processor) {
        samples?.fill(0);
        return;
      }
      if (typeof data === 'object' && data !== null && 'protocolError' in data) {
        this.#fail(generation, 'PEN_MICROPHONE_WORKLET_PROTOCOL_FAILED', data);
        return;
      }
      if (
        typeof data !== 'object' ||
        data === null ||
        !('sequence' in data) ||
        !Number.isInteger(data.sequence) ||
        !('microphoneInputEpoch' in data) ||
        !Number.isSafeInteger(data.microphoneInputEpoch) ||
        (data.microphoneInputEpoch as number) <= 0 ||
        samples === undefined
      ) {
        samples?.fill(0);
        this.#fail(generation, 'PEN_MICROPHONE_WORKLET_PROTOCOL_FAILED', data);
        return;
      }
      const sequence = data.sequence as number;
      if (sequence !== this.#expectedSequence) {
        samples.fill(0);
        this.#fail(
          generation,
          'PEN_MICROPHONE_WORKLET_SEQUENCE_GAP',
          new Error(`expected ${this.#expectedSequence}, received ${sequence}`),
        );
        return;
      }
      const epoch = data.microphoneInputEpoch as number;
      if (epoch !== this.#microphoneInputEpoch) {
        samples.fill(0);
        if (epoch > this.#microphoneInputEpoch) {
          this.#fail(
            generation,
            'PEN_MICROPHONE_WORKLET_PROTOCOL_FAILED',
            new Error(`worklet epoch ${epoch} ahead of ${this.#microphoneInputEpoch}`),
          );
          return;
        }
        // The worklet stamps authority when samples are produced. A packet
        // queued before mute may arrive after rapid unmute; drain its exact
        // sequence slot, but never relabel or admit its old audio.
        this.#acknowledgeFrame(generation, processor, sequence);
        return;
      }
      if (this.#muted) {
        // Disabled tracks produce digital-zero frames. Mute is an inert
        // custody state: drain producer backpressure without feeding VAD or
        // the dead-input watchdog and without retaining raw samples.
        samples.fill(0);
        this.#acknowledgeFrame(generation, processor, sequence, samples);
        return;
      }
      try {
        segmenter.push(samples);
        this.#observeLevel(samples);
        this.#watchDeadInput(samples, sampleRate);
        samples.fill(0);
        this.#acknowledgeFrame(generation, processor, sequence, samples);
      } catch (error: unknown) {
        samples.fill(0);
        this.#fail(generation, 'PEN_MICROPHONE_WORKLET_PROCESSING_FAILED', error);
      }
    };
    processor.onprocessorerror = (event) =>
      this.#fail(generation, 'PEN_MICROPHONE_WORKLET_FAILED', event);
  }

  #observeLevel(samples: Float32Array): void {
    if (this.#options.onLevel === undefined) return;
    const level = frameRms(samples);
    if (level > this.#levelPeak) this.#levelPeak = level;
    const now = performance.now();
    if (now - this.#levelLastEmitMs < LEVEL_INTERVAL_MS) return;
    this.#levelLastEmitMs = now;
    const peak = this.#levelPeak;
    this.#levelPeak = 0;
    this.#options.onLevel(Math.min(1, peak));
  }

  /** Dead-input watchdog: a mic that is "on" but delivering TRUE digital
   * silence (wrong default input, Bluetooth earphones in their case) never
   * trips VAD, so nothing downstream would ever notice. The discriminator is
   * strict so a quiet room is NEVER called a broken mic. */
  #watchDeadInput(samples: Float32Array, sampleRate: number): void {
    let peak = 0;
    for (let index = 0; index < samples.length; index += 8) {
      const magnitude = Math.abs(samples[index] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
    if (peak < NO_INPUT_PEAK) {
      this.#silentInputSamples += samples.length;
      if (
        !this.#noInputSignalFired &&
        !this.#noInputSignalSpent &&
        this.#silentInputSamples > sampleRate * NO_INPUT_SIGNAL_SECONDS
      ) {
        this.#noInputSignalFired = true;
        this.#noInputSignalSpent = true;
        this.#options.onNoInputSignal?.();
      }
      return;
    }
    this.#silentInputSamples = 0;
    if (this.#noInputSignalFired) {
      this.#noInputSignalFired = false;
      this.#options.onInputSignalRestored?.();
    }
  }

  #acknowledgeFrame(
    generation: number,
    processor: AudioWorkletNode,
    sequence: number,
    samples?: Float32Array,
  ): void {
    this.#expectedSequence += 1;
    try {
      // Hand the (already zeroed) frame buffer back with the acknowledgement
      // so the worklet reuses it instead of allocating one per 20 ms frame.
      const buffer = samples?.buffer;
      if (
        buffer instanceof ArrayBuffer &&
        samples !== undefined &&
        samples.byteOffset === 0 &&
        samples.byteLength === buffer.byteLength
      ) {
        processor.port.postMessage({ acknowledgeSequence: sequence, recycle: buffer }, [buffer]);
      } else {
        processor.port.postMessage({ acknowledgeSequence: sequence });
      }
    } catch (error: unknown) {
      this.#fail(generation, 'PEN_MICROPHONE_WORKLET_PROTOCOL_FAILED', error);
    }
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation || this.#stream === undefined) throw abortError();
  }

  async #awaitStartupStep<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      step.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }

  /** A fatal failure of the live generation: report once, release the mic,
   * and leave `state` at `error` so the UI can offer a retry. */
  #fail(generation: number, code: string, error: unknown): void {
    if (generation !== this.#generation || this.#stream === undefined) return;
    this.#teardown();
    this.#setState('error');
    this.#options.onError(code, error);
  }

  #teardown(): void {
    this.#generation += 1;
    this.#startupAbort?.abort();
    this.#startupAbort = undefined;
    const resources: CaptureResources = {
      stream: this.#stream,
      context: this.#context,
      source: this.#source,
      processor: this.#processor,
      silentGain: this.#silentGain,
      segmenter: this.#segmenter,
      resampler: this.#resampler,
    };
    this.#clearFields();
    this.#cleanupResources(resources);
  }

  #cleanupGeneration(generation: number, resources: CaptureResources): void {
    if (generation === this.#generation) {
      this.#generation += 1;
      this.#startupAbort?.abort();
      this.#startupAbort = undefined;
      this.#clearFields();
    }
    this.#cleanupResources(resources);
  }

  #clearFields(): void {
    this.#stream = undefined;
    this.#context = undefined;
    this.#source = undefined;
    this.#processor = undefined;
    this.#silentGain = undefined;
    this.#segmenter = undefined;
    this.#resampler = undefined;
    this.#resampleInFlight = false;
    this.#resampleEpoch = undefined;
    this.#currentUtteranceEpoch = undefined;
    this.#levelPeak = 0;
  }

  #cleanupResources(resources: CaptureResources): void {
    if (resources.processor !== undefined) {
      try {
        resources.processor.port.postMessage({ shutdown: true });
      } catch {
        // Closing the context remains the final privacy boundary.
      }
      // Transferred worklet packets may already be queued in this document.
      // Keep a zero-only consumer installed after revocation so a late event
      // cannot leave raw microphone samples resident until garbage collection.
      resources.processor.port.onmessage = (event: MessageEvent<unknown>) => {
        workletSamples(event.data)?.fill(0);
      };
      resources.processor.onprocessorerror = null;
      try {
        resources.processor.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    try {
      resources.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      resources.silentGain?.disconnect();
    } catch {
      // Already disconnected.
    }
    resources.segmenter?.clear();
    if (resources.resampler !== undefined) {
      // terminate() prevents new worker output, but an event already queued on
      // this document can still dispatch. Its only permitted late action is to
      // scrub the transferred PCM response.
      resources.resampler.onmessage = (event: MessageEvent<unknown>) => {
        zeroResponseBytes(event.data);
      };
      resources.resampler.onerror = null;
      resources.resampler.terminate();
    }
    if (resources.stream !== undefined) stopTracks(resources.stream);
    if (resources.context !== undefined && resources.context.state !== 'closed') {
      resources.context.close().catch((error: unknown) => {
        this.#options.onError('PEN_MICROPHONE_AUDIO_CONTEXT_CLOSE_FAILED', error);
      });
    }
  }
}
