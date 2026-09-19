/**
 * What this device does while an ad is on the learner's screen (ADR-0014).
 *
 * The rule is small and the consequences are not, so it lives in one place:
 * an ad takes the board, and for as long as it is up this client asks nothing
 * and hears nothing — the microphone is muted at its custody boundary, the
 * on-device recognizer's words are dropped, and the composer is off. Every way
 * an ad can end (skipped, completed, timed out, blocked, the socket dropping)
 * arrives here as the same `set(false)`, so the learner always gets everything
 * back on one line rather than on four.
 *
 * The room refuses the same input independently (`SessionRoom.adShowing`);
 * this is the half the learner can feel.
 */
export class AdInputGate {
  #paused = false;

  /** `onChange` is told once per transition, never per frame. */
  constructor(private readonly onChange: (paused: boolean) => void) {}

  /** Whether an ad is holding this device's voice and keyboard right now. */
  get paused(): boolean {
    return this.#paused;
  }

  /** The overlay came up, or went away. */
  set(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    this.onChange(paused);
  }

  /** Whether an input that just arrived — a word, a transcript, a submit — must be dropped. */
  refuses(): boolean {
    return this.#paused;
  }
}
