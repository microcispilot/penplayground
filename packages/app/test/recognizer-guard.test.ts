import { describe, expect, it } from 'vitest';
import { RecognizerGuard } from '../src/room/recognizer-guard.js';

/**
 * The recognizer needs a witness while a voice plays (ADR-0046).
 *
 * The case that shipped: the expert's own sentence came back through the
 * speakers, the browser's recognizer transcribed it, and the lesson
 * interrupted itself and "answered". The guard's job is to drop exactly
 * that — a transcript with nobody speaking into the microphone while the
 * speakers are on — and nothing else.
 */
describe('RecognizerGuard', () => {
  it('drops a final that arrives while the expert plays and the microphone heard nobody', () => {
    const g = new RecognizerGuard();
    g.playback(true, 0);
    expect(g.believes('w1', 4_000, true)).toBe(false);
  });

  it('drops the partials of the same echo, so nothing of it is captioned', () => {
    const g = new RecognizerGuard();
    g.playback(true, 0);
    expect(g.believes('w1', 1_000, false)).toBe(false);
    expect(g.believes('w1', 1_600, false)).toBe(false);
    expect(g.believes('w1', 2_400, true)).toBe(false);
  });

  it('believes a transcript the microphone confirmed inside the same stretch', () => {
    const g = new RecognizerGuard();
    g.playback(true, 0);
    g.speechStart(1_000);
    expect(g.believes('w1', 1_300, false)).toBe(true);
    g.speechEnd();
    // The recognizer's final lags the microphone's end by up to a second or so.
    expect(g.believes('w1', 3_900, true)).toBe(true);
  });

  it('believes a final whose utterance began (first partial) after the microphone opened, within the lead', () => {
    // The microphone confirmed 1.2 s before the first partial: the same onset, heard twice.
    const g2 = new RecognizerGuard();
    g2.playback(true, 0);
    g2.speechStart(3_800);
    g2.speechEnd();
    g2.believes('w1', 5_000, false);
    expect(g2.believes('w1', 6_000, true)).toBe(true);
    // Too long before it is a different utterance, and this one is unwitnessed.
    const g3 = new RecognizerGuard();
    g3.playback(true, 0);
    g3.speechStart(3_000);
    g3.speechEnd();
    g3.believes('w1', 5_000, false);
    expect(g3.believes('w1', 6_000, true)).toBe(false);
  });

  it('believes the recognizer alone when nothing has played for the utterance’s span', () => {
    const g = new RecognizerGuard();
    // Never played: a quiet learner the VAD missed is still heard.
    expect(g.believes('w1', 4_000, true)).toBe(true);
    // Played, stopped, and the utterance began well after the last sound.
    g.playback(true, 0);
    g.playback(false, 1_000);
    g.believes('w2', 3_000, false);
    expect(g.believes('w2', 4_000, true)).toBe(true);
  });

  it('still requires the witness when playback ended inside the utterance’s reach', () => {
    const g = new RecognizerGuard();
    g.playback(true, 0);
    g.playback(false, 2_000);
    // First partial at 3 s: the window opens at 1.5 s, and the expert was still audible then.
    g.believes('w1', 3_000, false);
    expect(g.believes('w1', 4_000, true)).toBe(false);
    // With no partial on record the final reaches SPAN + LEAD back.
    expect(g.believes('w2', 9_000, true)).toBe(false);
    expect(g.believes('w3', 9_600, true)).toBe(true);
  });

  it('forgets an utterance on its final and prunes partials the recognizer abandoned', () => {
    const g = new RecognizerGuard();
    g.playback(true, 0);
    g.speechStart(100);
    g.speechEnd();
    g.believes('w1', 500, false);
    expect(g.believes('w1', 1_000, true)).toBe(true);
    // The same id again, long after, is a fresh utterance with no witness.
    expect(g.believes('w1', 30_000, true)).toBe(false);
    // An abandoned partial from a minute ago does not anchor a later final,
    // even one the microphone witnessed at the time.
    g.speechStart(39_000);
    g.speechEnd();
    g.believes('w9', 40_000, false);
    g.believes('w10', 101_000, false);
    expect(g.believes('w9', 101_500, true)).toBe(false);
  });
});
