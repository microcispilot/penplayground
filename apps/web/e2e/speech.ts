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
 */

declare global {
  interface Window {
    /** Say one sentence as a final result. Returns false when nothing is listening. */
    __penSpeak?: (text: string) => boolean;
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
    window.__penSpeak = (text: string) => {
      const rec = active;
      if (!rec?.onresult) return false;
      const alternative = { transcript: text, confidence: 0.98 };
      const result = {
        0: alternative,
        length: 1,
        isFinal: true,
        item: () => alternative,
      };
      rec.onresult({
        resultIndex: 0,
        results: { 0: result, length: 1, item: () => result },
      });
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
  const heard = await page.evaluate((line) => window.__penSpeak?.(line) ?? false, text);
  expect(heard, 'a recognizer was running when the question was asked').toBe(true);
}
