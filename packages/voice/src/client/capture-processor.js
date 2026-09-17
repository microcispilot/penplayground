/**
 * Pen Academy microphone capture AudioWorkletProcessor.
 *
 * Plain JavaScript on purpose: this file is loaded as worklet SOURCE TEXT
 * (import it with Vite `?raw`, hand it to `Microphone` as `workletSource`)
 * and turned into a `blob:` URL at runtime, so it must not depend on a
 * bundler or a type-stripping step. Nothing is imported.
 *
 * Contract with the main thread (`microphone.ts`):
 *  - The processor is inert until it receives `{ microphoneInputEpoch }`.
 *  - It emits `{ sequence, microphoneInputEpoch, samples: Float32Array }`
 *    packets of 20 ms mono frames, one at a time: the next packet is sent
 *    only after `{ acknowledgeSequence, recycle? }` for the outstanding one.
 *  - `{ shutdown: true }` zeroes everything and stops the processor.
 *
 * Sequence numbers are consumed even for frames dropped under backpressure,
 * so a stall always surfaces as a visible gap that fails closed on the main
 * thread instead of silently skipping audio.
 */

const FRAME_SAMPLES = Math.max(128, Math.round(sampleRate * 0.02));
// One second of 20 ms mono frames is a hard memory/backpressure ceiling.
// Normal main-thread processing ACKs each frame in under one frame interval;
// a longer stall fails closed through the intentional sequence gap.
const MAX_PENDING_FRAMES = 50;
const MAX_RECYCLED_FRAMES = 8;

class PenUtteranceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.frameOffset = 0;
    this.nextSequence = 0;
    this.microphoneInputEpoch = undefined;
    this.outstandingSequence = undefined;
    this.pending = [];
    // Frame buffers come back from the main thread with each acknowledgement
    // and are reused, so steady-state capture allocates nothing per 20 ms.
    this.recycled = [];
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.shutdown === true) {
        this.stopAndZero();
        this.port.postMessage({ shutdownComplete: true });
        return;
      }
      if (
        typeof event.data === 'object' &&
        event.data !== null &&
        'microphoneInputEpoch' in event.data
      ) {
        const microphoneInputEpoch = event.data.microphoneInputEpoch;
        if (!Number.isSafeInteger(microphoneInputEpoch) || microphoneInputEpoch <= 0) {
          this.stopAndZero();
          this.port.postMessage({ protocolError: true });
          return;
        }
        if (
          this.microphoneInputEpoch === undefined ||
          microphoneInputEpoch > this.microphoneInputEpoch
        ) {
          this.microphoneInputEpoch = microphoneInputEpoch;
          // An epoch transition is a capture-custody boundary (mute/unmute).
          // A partial frame straddling mute must never be completed under
          // the new epoch, and queued old packets are zeroed and destroyed
          // immediately. Only a packet already transferred to the main
          // thread remains to be drained.
          this.frame.fill(0);
          this.frame = new Float32Array(FRAME_SAMPLES);
          this.frameOffset = 0;
          for (const packet of this.pending) packet.samples.fill(0);
          this.pending = [];
          if (this.outstandingSequence !== undefined) {
            // Sequence numbers for cleared queued frames were never observed
            // by the main thread and may be reused. The one transferred
            // packet remains outstanding under its producer-stamped old epoch.
            this.nextSequence = this.outstandingSequence + 1;
          }
        }
        return;
      }
      const acknowledgement = event.data?.acknowledgeSequence;
      const recycle = event.data?.recycle;
      if (
        recycle instanceof ArrayBuffer &&
        recycle.byteLength === FRAME_SAMPLES * 4 &&
        this.recycled.length < MAX_RECYCLED_FRAMES
      ) {
        this.recycled.push(recycle);
      }
      if (acknowledgement !== this.outstandingSequence) return;
      this.outstandingSequence = undefined;
      this.sendNext();
    };
  }

  stopAndZero() {
    this.stopped = true;
    this.frame.fill(0);
    for (const packet of this.pending) packet.samples.fill(0);
    this.pending = [];
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    if (this.microphoneInputEpoch === undefined) {
      for (const output of outputs[0] ?? []) output.fill(0);
      return true;
    }
    const channels = inputs[0] ?? [];
    const inputLength = channels[0]?.length ?? 0;
    if (inputLength > 0) {
      let inputOffset = 0;
      while (inputOffset < inputLength) {
        const length = Math.min(inputLength - inputOffset, this.frame.length - this.frameOffset);
        for (let index = 0; index < length; index += 1) {
          let mixed = 0;
          for (const channel of channels) mixed += channel[inputOffset + index] ?? 0;
          this.frame[this.frameOffset + index] = mixed / channels.length;
        }
        this.frameOffset += length;
        inputOffset += length;
        if (this.frameOffset === this.frame.length) this.completeFrame();
      }
    }
    // The processor is a sink: its output is always silence so wiring it to
    // the destination (required to keep it alive) never plays the mic back.
    for (const output of outputs[0] ?? []) output.fill(0);
    return true;
  }

  completeFrame() {
    const packet = {
      sequence: this.nextSequence,
      microphoneInputEpoch: this.microphoneInputEpoch,
      samples: this.frame,
    };
    this.nextSequence += 1;
    this.frame = this.nextFrameBuffer();
    this.frameOffset = 0;
    if (this.outstandingSequence === undefined) {
      this.send(packet);
      return;
    }
    if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(packet);
    else packet.samples.fill(0);
    // When full, this frame is deliberately dropped. Its consumed sequence
    // number makes the next delivered packet expose the gap and fail closed.
  }

  nextFrameBuffer() {
    const recycled = this.recycled.pop();
    if (recycled === undefined) return new Float32Array(FRAME_SAMPLES);
    const frame = new Float32Array(recycled);
    frame.fill(0);
    return frame;
  }

  sendNext() {
    const packet = this.pending.shift();
    if (packet !== undefined) this.send(packet);
  }

  send(packet) {
    this.outstandingSequence = packet.sequence;
    this.port.postMessage(packet, [packet.samples.buffer]);
  }
}

registerProcessor('pen-utterance-capture-v1', PenUtteranceCaptureProcessor);
