import { describe, expect, it } from 'vitest';
import { FallbackFont } from '../src/font.js';
import {
  DEFAULT_LINE_HEIGHT,
  layoutHandText,
  measureHandText,
  wrapHandText,
} from '../src/glyphs.js';
import { loadTestFont } from './helpers.js';

describe('glyph layout (Caveat via opentype.js)', () => {
  const font = loadTestFont();

  it('loads the WOFF and exposes metrics', () => {
    expect(font.unitsPerEm).toBe(1000);
    expect(font.ascent).toBeCloseTo(0.96, 2);
    expect(font.has('a')).toBe(true);
    expect(font.has('√')).toBe(false);
  });

  it('produces one outline path per visible glyph with kerning applied', () => {
    const l = layoutHandText(font, 'AV', {
      fontSize: 40,
      maxWidth: 1000,
      seed: 's',
      jitter: false,
    });
    const glyphs = l.lines[0]?.glyphs ?? [];
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]?.d.startsWith('M')).toBe(true);
    const a = glyphs[0];
    const v = glyphs[1];
    if (!a || !v) throw new Error('glyphs missing');
    // Kerning between A and V is negative in Caveat: V starts before A's advance ends.
    expect(v.x).toBeLessThan(a.x + a.advance);
    expect(measureHandText(font, 'AV', 40)).toBeCloseTo(v.x + v.advance, 6);
  });

  it('wraps at the max width by words and breaks very long words', () => {
    const lines = wrapHandText(font, 'the cat sat on the mat', 36, 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(measureHandText(font, line, 36)).toBeLessThanOrEqual(200 + 1e-6);
    expect(lines.join(' ')).toBe('the cat sat on the mat');
    const broken = wrapHandText(font, 'supercalifragilistic', 36, 120);
    expect(broken.length).toBeGreaterThan(1);
  });

  it('respects explicit newlines and reports height per line', () => {
    const l = layoutHandText(font, 'one\ntwo', { fontSize: 36, maxWidth: 1000, seed: 's' });
    expect(l.lines).toHaveLength(2);
    expect(l.height).toBeCloseTo(36 * DEFAULT_LINE_HEIGHT * 2, 6);
    expect(l.lines[1]?.baseline).toBeGreaterThan(l.lines[0]?.baseline ?? 0);
    expect(l.charCount).toBe(7);
  });

  it('jitter is deterministic per seed and within the stated bounds', () => {
    const a = layoutHandText(font, 'hello', { fontSize: 36, maxWidth: 1000, seed: 'b1' });
    const b = layoutHandText(font, 'hello', { fontSize: 36, maxWidth: 1000, seed: 'b1' });
    const c = layoutHandText(font, 'hello', { fontSize: 36, maxWidth: 1000, seed: 'b2' });
    expect(a).toEqual(b);
    expect(a.lines[0]?.glyphs.map((g) => g.rotation)).not.toEqual(
      c.lines[0]?.glyphs.map((g) => g.rotation),
    );
    const baseline = a.lines[0]?.baseline ?? 0;
    for (const g of a.lines[0]?.glyphs ?? []) {
      expect(Math.abs(g.rotation)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(g.y - baseline)).toBeLessThanOrEqual(1);
    }
  });

  it('synthesises pen strokes for √ and → and marks unknown symbols as fallback', () => {
    const l = layoutHandText(font, 'q·k / √d → ∮', { fontSize: 36, maxWidth: 1000, seed: 's' });
    const byChar = new Map((l.lines[0]?.glyphs ?? []).map((g) => [g.char, g]));
    expect(byChar.get('√')?.kind).toBe('stroke');
    expect(byChar.get('√')?.d).toMatch(/^M/);
    expect(byChar.get('→')?.kind).toBe('stroke');
    expect(byChar.get('·')?.kind).toBe('outline');
    expect(byChar.get('∮')?.kind).toBe('fallback');
    expect(byChar.get('∮')?.advance).toBeGreaterThan(0);
  });

  it('the fallback font lays text out without outlines', () => {
    const l = layoutHandText(new FallbackFont(), 'hello world', {
      fontSize: 36,
      maxWidth: 1000,
      seed: 's',
    });
    expect(l.width).toBeGreaterThan(0);
    expect((l.lines[0]?.glyphs ?? []).every((g) => g.kind === 'fallback' || g.char === ' ')).toBe(
      true,
    );
  });
});
