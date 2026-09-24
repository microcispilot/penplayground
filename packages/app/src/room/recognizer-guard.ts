/**
 * Whether words from the platform's speech recognizer are the learner's
 * (ADR-0046).
 *
 * The browser's recognizer listens through a capture of its own, with no
 * echo cancellation against what the page plays. With the speakers on it
 * transcribes the expert as faithfully as the learner, and a lesson then
 * interrupts itself with its own sentences — and answers them. Our own
 * microphone is echo-cancelled, raises its bar while anything plays, and
 * confirms speech harmonically (`Microphone`); that is the witness this
 * guard asks for. While a voice is coming out of the speakers, a transcript
 * counts only if the microphone heard someone start speaking inside the same
 * stretch of time. When nothing is playing there is no echo to mistake, and
 * the recognizer is believed on its own: the microphone can miss a quiet
 * learner, and in a silent room there is nothing else the words could be.
 *
 * Time is the caller's (`performance.now()` or `Date.now()`, as long as it is
 * one of them throughout), so the rules are testable to the millisecond.
 */
export class RecognizerGuard {
  /**
   * How long before a recognizer's first partial the confirming speech may
   * have started. The microphone confirms after ~360 ms of voiced, harmonic
   * signal; the recognizer's first partial arrives a few hundred ms after
   * onset too, in either order. 1.5 s covers both with room to spare.
   */
  static readonly LEAD_MS = 1500;
  /**
   * With no partial on record, how far back a final's utterance is assumed
   * to reach. Chrome's continuous recognizer finalises a phrase within a few
   * seconds of its last word; a final for anything older is not a phrase we
   * can place, and it is measured against this much history.
   */
  static readonly SPAN_MS = 6000;
  /** A partial older than this belongs to an utterance the recognizer abandoned. */
  private static readonly FORGET_MS = 60_000;

  private vadOpen = false;
  private lastVadStart = Number.NEGATIVE_INFINITY;
  private playing = false;
  private playedUntil = Number.NEGATIVE_INFINITY;
  private readonly firstPartialAt = new Map<string, number>();

  /** The microphone confirmed someone speaking. */
  speechStart(now: number): void {
    this.vadOpen = true;
    this.lastVadStart = now;
  }

  /** The confirmed utterance ended. */
  speechEnd(): void {
    this.vadOpen = false;
  }

  /** A voice is (or is no longer) coming out of the speakers: the expert's or another participant's. */
  playback(active: boolean, now: number): void {
    if (this.playing && !active) this.playedUntil = now;
    this.playing = active;
  }

  /**
   * Whether to believe this transcript. A final closes the utterance's
   * record; a partial opens it if it is the first.
   */
  believes(utteranceId: string, now: number, final: boolean): boolean {
    const begun = this.firstPartialAt.get(utteranceId);
    if (final) this.firstPartialAt.delete(utteranceId);
    else if (begun === undefined) {
      this.forgetStale(now);
      this.firstPartialAt.set(utteranceId, now);
    }
    const from = (begun ?? now - RecognizerGuard.SPAN_MS) - RecognizerGuard.LEAD_MS;
    const echoPossible = this.playing || this.playedUntil >= from;
    if (!echoPossible) return true;
    return this.vadOpen || this.lastVadStart >= from;
  }

  private forgetStale(now: number): void {
    for (const [id, at] of this.firstPartialAt)
      if (now - at > RecognizerGuard.FORGET_MS) this.firstPartialAt.delete(id);
  }
}
