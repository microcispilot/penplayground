import { describe, expect, it } from 'vitest';
import { type GlyphSource, LayeredFont } from '../src/font.js';

describe('LayeredFont: two fonts, one hand', () => {
  /**
   * Eraser has 100 glyphs and this product teaches maths and renders code, so
   * it meets `<`, `[`, `→` and accents constantly. CSS falls back per glyph on
   * its own; outlines do not, because the board takes its glyphs from parsed
   * bytes rather than from the cascade — so a missing character draws as
   * `.notdef`, a blank in the middle of an equation.
   */
  const primary: GlyphSource = {
    ascent: 0.9,
    descent: 0.25,
    has: (ch) => /[a-z]/i.test(ch),
    advance: () => 10,
    kerning: () => 3,
    path: (ch) => `PRIMARY:${ch}`,
  };
  const fallback: GlyphSource = {
    ascent: 0.5,
    descent: 0.9,
    has: () => true,
    advance: () => 7,
    kerning: () => 5,
    path: (ch) => `FALLBACK:${ch}`,
  };
  const layered = new LayeredFont(primary, fallback);

  it('draws each character with whichever font actually has it', () => {
    expect(layered.path('a', 0, 0, 20)).toBe('PRIMARY:a');
    expect(layered.path('<', 0, 0, 20)).toBe('FALLBACK:<');
    expect(layered.advance('a', 20)).toBe(10);
    expect(layered.advance('<', 20)).toBe(7);
    // `has` is the union: the layered font can draw anything either can.
    expect(layered.has('a')).toBe(true);
    expect(layered.has('<')).toBe(true);
  });

  it('takes its metrics from the primary, so the baseline never moves', () => {
    // Per-glyph metrics would make a line containing one arrow sit differently
    // from the line above it.
    expect(layered.ascent).toBe(primary.ascent);
    expect(layered.descent).toBe(primary.descent);
  });

  it('kerns within a font and never across two', () => {
    // A kerning pair is a fact about two glyphs in one design; asking Eraser
    // how it kerns against a Caveat bracket is meaningless.
    expect(layered.kerning('a', 'b', 20)).toBe(3);
    expect(layered.kerning('<', '>', 20)).toBe(5);
    expect(layered.kerning('a', '<', 20)).toBe(0);
    expect(layered.kerning('<', 'a', 20)).toBe(0);
  });
});
