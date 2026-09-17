import { describe, expect, it } from 'vitest';
import { FallbackFont, type GlyphSource } from '../src/font.js';
import { layoutHandText } from '../src/glyphs.js';
import { outlineToPath } from '../src/primitives.js';
import {
  commandsToPathData,
  formatCoord,
  hasNonFinite,
  sanitisePathData,
} from '../src/svg-path.js';
import { loadTestFont } from './helpers.js';

/** The sentences from the browser bug report, laid out through the real pipeline. */
const SENTENCES = [
  "Hi — I'm Ada. Let's start with a sentence, because that's all a language model ever sees.",
  'token → vector  [0.2, -1.1, 0.7 …]',
  'the cat sat on the mat',
  'Hi — I’m Ada. “Quotes” and ‘more’ — ellipsis… → arrow ≤ ≥ ≠ √d',
];

function allPaths(text: string, fontSize: number, seed: string): string[] {
  const l = layoutHandText(loadTestFont(), text, { fontSize, maxWidth: 640, seed });
  return l.lines.flatMap((line) => line.glyphs.map((g) => g.d));
}

describe('glyph paths are always finite (opentype.js toPathData NaN regression)', () => {
  it('opentype.js 2.0.0 toPathData itself emits NaN for some finite values (the bug we route around)', () => {
    const font = loadTestFont();
    const d = font.glyph('H').getPath(0, 0, 36).toPathData(2);
    expect(d).toMatch(/NaN/);
  });

  it.each(SENTENCES)('no NaN/Infinity in any emitted path for %j', (text) => {
    for (const seed of ['b1', 'b2', 'L2.b7']) {
      for (const size of [26, 36, 58]) {
        const paths = allPaths(text, size, seed);
        expect(paths.length).toBeGreaterThan(0);
        for (const d of paths) {
          expect(d).not.toMatch(/NaN|Infinity/);
          expect(d === '' || /^M/.test(d)).toBe(true);
        }
        const l = layoutHandText(loadTestFont(), text, { fontSize: size, maxWidth: 640, seed });
        expect(l.invalidGlyphs).toEqual([]);
        for (const line of l.lines)
          for (const g of line.glyphs) {
            expect(Number.isFinite(g.x)).toBe(true);
            expect(Number.isFinite(g.y)).toBe(true);
            expect(Number.isFinite(g.advance)).toBe(true);
          }
      }
    }
  });

  it('the em dash, curly quotes and ellipsis are real outlines in the latin subset', () => {
    const font = loadTestFont();
    for (const ch of ['—', '’', '“', '”', '…', "'"]) expect(font.has(ch)).toBe(true);
    expect(font.has('→')).toBe(false);
  });
});

describe('svg-path helpers', () => {
  it('formatCoord trims and never prints -0', () => {
    expect(formatCoord(18.000000000000004)).toBe('18');
    expect(formatCoord(-10.638000000000002)).toBe('-10.64');
    expect(formatCoord(-0.001)).toBe('0');
    expect(formatCoord(5)).toBe('5');
  });

  it('commandsToPathData drops non-finite commands and counts them', () => {
    const r = commandsToPathData([
      { type: 'M', x: 1, y: 2 },
      { type: 'Q', x1: Number.NaN, y1: 0, x: 3, y: 4 },
      { type: 'L', x: 5, y: 6 },
      { type: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: Number.POSITIVE_INFINITY, y: 3 },
      { type: 'Z' },
    ]);
    expect(r).toEqual({ d: 'M1 2L5 6Z', dropped: 2 });
  });

  it('sanitisePathData strips broken segments and keeps the rest well-formed', () => {
    const d = 'M1 2L3 4Q262.33 35.89 NaN 38.67L259.96 40QNaN 17 5 5Z';
    expect(hasNonFinite(d)).toBe(true);
    expect(sanitisePathData(d)).toEqual({ d: 'M1 2L3 4L259.96 40Z', dropped: 2 });
    expect(sanitisePathData('MNaN 3L1 2L3 4')).toEqual({ d: '', dropped: 3 });
    expect(sanitisePathData('M1 1L2 2')).toEqual({ d: 'M1 1L2 2', dropped: 0 });
  });

  it('layout sanitises a glyph source that returns non-finite path data and reports the character', () => {
    const base = new FallbackFont();
    const evil: GlyphSource = {
      ascent: base.ascent,
      descent: base.descent,
      has: () => true,
      advance: (ch, size) => (ch === 'x' ? Number.NaN : size * 0.5),
      kerning: () => Number.NaN,
      path: (ch, x, y) =>
        ch === 'b' ? `M${x} ${y}L${x + 5} NaNL${x + 10} ${y}` : `M${x} ${y}L${x + 5} ${y - 5}`,
    };
    const l = layoutHandText(evil, 'abxc', { fontSize: 36, maxWidth: 640, seed: 's' });
    const glyphs = l.lines[0]?.glyphs ?? [];
    for (const g of glyphs) {
      expect(g.d).not.toMatch(/NaN/);
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.advance)).toBe(true);
    }
    expect(l.invalidGlyphs).toEqual(['b']);
  });

  it('outlineToPath skips non-finite points', () => {
    const d = outlineToPath([
      [0, 0],
      [Number.NaN, 5],
      [10, 0],
      [10, 10],
    ]);
    expect(d).not.toMatch(/NaN/);
    expect(d.startsWith('M0.00 0.00')).toBe(true);
  });
});
