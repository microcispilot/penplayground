import { expect, type Page } from '@playwright/test';

/**
 * Asking the expert something is **speaking**. There is no typed route to
 * them any more — the panel's composer goes to the other people in the room —
 * so every spec that used to fill the composer and press send now has to make
 * a sound.
 *
 * The honest way to do that in a browser is to give the product the
 * recognizer it already knows how to drive. `apps/web/src/speech.web.ts` reads
 * `window.SpeechRecognition ?? window.webkitSpeechRecognition`, sets
 * `continuous`/`interimResults`, and turns an `onresult` with `isFinal` into
 * `handlers.onFinal(...)` → `Conductor.onTranscript(id, text, true)` → a final
 * `transcript` frame. Everything from the recognizer inwards is the product's
 * own code; only the recognizer is ours.
 *
 * It has to be ours. Real Chrome's recognizer sends audio to Google, needs a
 * network, and would never return "Why do we divide by the square root of d?"
 * from a `--use-fake-device-for-media-stream` sine wave.
 *
 * And a learner who speaks makes a **sound**. Since ADR-0046 the room believes
 * the recognizer's words, while any voice is playing, only if its own
 * microphone heard someone start speaking at the same time — that is what
 * keeps the expert's voice from interrupting the lesson through the speakers.
 * So the harness owns the microphone too: `getUserMedia` for audio hands the
 * product a stream this file controls, silent but for a working microphone's
 * noise floor, and saying a sentence plays a voiced tone into it (a periodic
 * wave in the pitch band the presence detector admits) for long enough to be
 * confirmed as speech before the recognizer's final lands. Everything the
 * product does with that — the harmonic VAD, the barge-in, the witness — is
 * the product's own code on a real signal.
 */

declare global {
  interface Window {
    /**
     * Say one sentence: voice it into the microphone, then hand the words to
     * the recognizer as a final result. Resolves once the words have landed,
     * false when nothing is listening.
     */
    __penSpeak?: (text: string) => Promise<boolean>;
    /** Whether a recognizer is running right now. */
    __penListening?: () => boolean;
  }
}

/**
 * Install the fake recognizer. Must be called **before** `page.goto`: the app
 * reads the constructor off `window` when the room turns the microphone on.
 */
export async function installFakeSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // ── the microphone ──────────────────────────────────────────────────────
    // Sample rate matches the product's capture context so nothing resamples.
    const RATE = 48_000;
    // A 140 Hz fundamental with its second and third harmonics, all sines:
    // inside the detector's 60–450 Hz pitch band, a normalised
    // autocorrelation peak near 1, a handful of zero crossings a period, and
    // nothing above 420 Hz to alias when the detector decimates to 8 kHz —
    // read as voiced speech, never as a click or hiss.
    const VOICE_HZ = 140;
    const PARTIALS = [0.6, 0.3, 0.2];
    // RMS ≈ 0.07, well over the raised bar the segmenter sets while a voice
    // plays (0.02).
    const VOICE_GAIN = 0.15;
    // The words land once the tone has demonstrably reached the product's
    // pipeline — its own level meter reads it — plus the segmenter's
    // confirmation window (240 ms voiced, 120 ms harmonic) with margin. A
    // fixed delay was not enough on real Chrome, whose audio thread can take
    // longer to start: the words arrived before the confirmation, were
    // dropped as echo, and the confirmation then interrupted the lesson with
    // nothing to say.
    const LEVEL_HEARD = 0.02;
    const LEVEL_WAIT_MS = 2500;
    const CONFIRM_MS = 500;
    const WORDS_TAIL_MS = 300;
    // A working microphone in a silent room is not digital silence: peak
    // 0.0008 clears the dead-input floor (0.0002) and its RMS (~0.0005) sits
    // far under the speech gate (0.008) and the detector's window floor.
    const NOISE_GAIN = 0.0008;
    // One mouth. React's StrictMode opens the microphone twice at mount and
    // disposes the first; every grant hangs off the same source so the
    // sentence is voiced into whichever stream the room kept.
    let voice: { context: AudioContext; gain: GainNode; floor: GainNode } | null = null;
    const mouth = () => {
      if (voice) return voice;
      const context = new AudioContext({ sampleRate: RATE });
      const gain = context.createGain();
      gain.gain.value = 0;
      PARTIALS.forEach((amplitude, index) => {
        const tone = context.createOscillator();
        tone.type = 'sine';
        tone.frequency.value = VOICE_HZ * (index + 1);
        const partial = context.createGain();
        partial.gain.value = amplitude;
        tone.connect(partial).connect(gain);
        tone.start();
      });
      const seconds = 2;
      const buffer = context.createBuffer(1, RATE * seconds, RATE);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const floor = context.createGain();
      floor.gain.value = NOISE_GAIN;
      noise.connect(floor);
      noise.start();
      voice = { context, gain, floor };
      return voice;
    };
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints?.audio || constraints.video) return realGetUserMedia(constraints);
      // A destination of its own per grant, on the one graph: stopping one
      // grant's track cannot silence another's, and no track is a clone.
      const m = mouth();
      const out = m.context.createMediaStreamDestination();
      m.gain.connect(out);
      m.floor.connect(out);
      await m.context.resume().catch(() => undefined);
      return out.stream;
    };

    // ── the recognizer ──────────────────────────────────────────────────────
    let active: {
      onresult: ((e: unknown) => void) | null;
      onend: ((e: unknown) => void) | null;
    } | null = null;

    class FakeSpeechRecognition {
      lang = 'en-US';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: ((e: unknown) => void) | null = null;
      private running = false;

      start(): void {
        // The real one throws on a double start, and `speech.web.ts` catches
        // exactly that; behave the same so the backoff path is the same path.
        if (this.running) throw new Error('recognition already started');
        this.running = true;
        active = this;
      }

      stop(): void {
        if (!this.running) return;
        this.running = false;
        if (active === this) active = null;
        this.onend?.(new Event('end'));
      }

      abort(): void {
        this.stop();
      }
    }

    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = FakeSpeechRecognition;
    w.webkitSpeechRecognition = FakeSpeechRecognition;

    window.__penListening = () => active !== null;
    window.__penSpeak = async (text: string) => {
      const rec = active;
      if (!rec?.onresult) return false;
      const words = () => {
        // The recognizer running when the words land; the one that was
        // running when the mouth opened if it has since been restarted.
        const target = active ?? rec;
        if (!target.onresult) return;
        const alternative = { transcript: text, confidence: 0.98 };
        const result = {
          0: alternative,
          length: 1,
          isFinal: true,
          item: () => alternative,
        };
        target.onresult({
          resultIndex: 0,
          results: { 0: result, length: 1, item: () => result },
        });
      };
      const v = voice;
      if (!v) {
        // The room never opened the microphone (server STT, or a spec that
        // speaks before the mic is on): words alone, as before.
        words();
        return true;
      }
      const at = v.context.currentTime;
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(VOICE_GAIN, at);
      const level = () =>
        (
          window as unknown as { __penRoomStore?: { getState(): { micLevel?: number } } }
        ).__penRoomStore?.getState().micLevel ?? 0;
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const w = window as unknown as { __penSpeakLog?: string[] };
      w.__penSpeakLog ??= [];
      const log = w.__penSpeakLog;
      const t0 = Date.now();
      const until = t0 + LEVEL_WAIT_MS;
      while (level() < LEVEL_HEARD && Date.now() < until) await sleep(50);
      log.push(`heard@${Date.now() - t0}ms level=${level().toFixed(3)} ctx=${v.context.state}`);
      await sleep(CONFIRM_MS);
      log.push(`words@${Date.now() - t0}ms active=${active !== null} rec=${active === rec}`);
      words();
      await sleep(WORDS_TAIL_MS);
      v.gain.gain.setValueAtTime(0, v.context.currentTime);
      return true;
    };
  });
}

/**
 * Say something to the expert, out loud, the way a learner would.
 *
 * Two things have to be true first, and both are the product's own rules:
 *
 *  - The microphone has to be on. It is by default (`pen.mic`), but a room can
 *    reach this point with it off, so the control is pressed if its own label
 *    says it is not listening.
 *  - No ad may be on the board. While one is, `AdInputGate` drops the
 *    recognizer's words **silently** — that is the whole point of
 *    `ad-input.ts`, and timeline.spec.ts asserts it — so a question asked into
 *    that window reaches nobody. The bar's microphone is disabled for exactly
 *    that window, so waiting for it is waiting for the gate to open.
 *
 * On a pair with ads an overlay can still take the board between the wait and
 * the sentence. A caller that can see whether the room heard (a final
 * `transcript` frame) should say it again, the way a person talked over by an
 * advert repeats themselves; timeline.spec.ts does.
 */
export async function askByVoice(page: Page, text: string): Promise<void> {
  const mic = page.getByTestId('mic-toggle');
  await expect(mic).toBeVisible({ timeout: 45_000 });
  await expect(mic, 'the inputs are the learner\u2019s again').toBeEnabled({ timeout: 60_000 });
  if ((await mic.getAttribute('aria-label')) === 'Unmute microphone') await mic.click();
  await expect
    .poll(() => page.evaluate(() => window.__penListening?.() ?? false), { timeout: 45_000 })
    .toBe(true);
  const heard = await page.evaluate(
    async (line) => (await window.__penSpeak?.(line)) ?? false,
    text,
  );
  expect(heard, 'a recognizer was running when the question was asked').toBe(true);
}
