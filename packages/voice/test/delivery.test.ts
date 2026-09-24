import { describe, expect, it } from 'vitest';
import { deliveryText, splitDelivery, withoutDelivery } from '../src/server/delivery.js';

/**
 * Delivery cues (ADR-0047): what is shown never carries a bracket, what is
 * spoken carries only the cues we named, and the tone goes in front.
 */
describe('splitDelivery', () => {
  it('keeps a known cue for the voice and removes it from the shown text', () => {
    const r = splitDelivery('The [emphasis] value is what the program keeps.');
    expect(r.text).toBe('The value is what the program keeps.');
    expect(r.spoken).toBe('The [emphasis] value is what the program keeps.');
  });

  it('drops a cue the vocabulary does not name from both texts', () => {
    const r = splitDelivery('[laughs maniacally] Ready? [break] Here it comes [pause].');
    expect(r.text).toBe('Ready? Here it comes.');
    expect(r.spoken).toBe('Ready? [break] Here it comes.');
  });

  it('forgives case and spaces inside the brackets, and tidies the seams', () => {
    const r = splitDelivery('One [ Soft Tone ] small aside , then on.');
    expect(r.spoken).toBe('One [soft tone] small aside, then on.');
    expect(r.text).toBe('One small aside, then on.');
  });

  it('leaves a sentence with no cue exactly as it was', () => {
    const r = splitDelivery('Plain sentence.');
    expect(r).toEqual({ text: 'Plain sentence.', spoken: 'Plain sentence.' });
    // Square brackets in code or maths are not cues: too long, or with a newline.
    const code = splitDelivery('An array is written [1, 2, 3] in Swift.');
    expect(code.text).toBe('An array is written in Swift.');
  });
});

describe('deliveryText', () => {
  it('prefixes the tone as a sentence-level cue, and none for neutral', () => {
    expect(deliveryText('Look at this.', 'warm')).toBe('[warm] Look at this.');
    expect(deliveryText('Look at this.', 'encouraging')).toBe(
      '[encouraging and empathetic] Look at this.',
    );
    expect(deliveryText('Look at this.', 'neutral')).toBe('Look at this.');
    expect(deliveryText('Look at this.')).toBe('Look at this.');
    expect(deliveryText('Look at this.', 'not-a-tone')).toBe('Look at this.');
  });
});

describe('withoutDelivery', () => {
  it('removes every cue, known or not, for an engine that cannot read them', () => {
    expect(withoutDelivery('[emphasis] This [break] matters [excited].')).toBe('This matters.');
  });
});
