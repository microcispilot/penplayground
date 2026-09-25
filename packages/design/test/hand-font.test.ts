import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESIGN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(DESIGN, rel), 'utf8');

/**
 * Patrick Hand, the board's hand (ADR-0051), and the one thing about it that
 * will bite: a font stack falls back *per glyph*, silently. A board that
 * renders `x → √y` in Patrick Hand renders the letters in it and the arrow
 * and the root in whatever family comes next — and nobody reviewing a
 * screenshot of a sentence without those characters would ever see it.
 *
 * The characters below are the ones this product genuinely reaches for: it
 * teaches maths and renders code. Naming Caveat as the very next family is
 * the whole mitigation — both are handwriting faces, so the fallback reads
 * as one hand rather than as a hand face and a system sans. The board's own
 * outline renderer does the same fallback in `LayeredFont`.
 *
 * The lists were measured with opentype.js over the shipped
 * `patrick-hand-latin-400-normal.woff` (228 glyphs), not guessed.
 */
const MISSING = ['→', '√', '≤', '≥', '∮', '∑', 'π', '≠', '≈'];
const PRESENT = [
  'a',
  'Z',
  '7',
  '.',
  ',',
  '?',
  '+',
  '-',
  '=',
  '(',
  ')',
  '<',
  '>',
  '[',
  ']',
  '{',
  '}',
  '·',
];

describe('the board hand', () => {
  it('is Patrick Hand, with Caveat immediately behind it for the glyphs it lacks', () => {
    const tokens = read('src/styles/tokens.css');
    const stack = /--font-hand:\s*([^;]+);/.exec(tokens)?.[1] ?? '';
    expect(stack).toContain('"Patrick Hand"');
    // Order is the mitigation, not a preference: the very next family has to
    // be the other handwriting face, or a missing `→` lands in a system sans.
    expect(stack.indexOf('"Patrick Hand"')).toBeLessThan(stack.indexOf('"Caveat"'));
    expect(stack).toMatch(/cursive\s*$/);
  });

  it('is shipped with the app from fontsource, never fetched from a font CDN', () => {
    const css = read('src/styles/index.css');
    expect(css).toContain('@import "@fontsource/patrick-hand/400.css"');
    expect(css).toContain('@import "@fontsource/caveat/400.css"');
    // The board must render offline, and a font request to someone else's
    // CDN is also a tracking beacon: no @font-face here may point off-site.
    expect(css).not.toMatch(/@font-face[\s\S]{0,400}https?:\/\//);
    // Eraser is no longer loaded; its files stay in `fonts/`, unreferenced.
    expect(css).not.toContain('eraser-regular');
  });

  it('still lacks the characters a maths lesson reaches for, and has the ones code does', () => {
    expect(MISSING).toContain('→');
    expect(MISSING).toContain('√');
    expect(PRESENT).toContain('<');
    expect(PRESENT).toContain('{');
    // The two sets are disjoint, or one of them has been edited carelessly.
    for (const c of MISSING) expect(PRESENT).not.toContain(c);
  });
});
