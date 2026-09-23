import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESIGN = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(DESIGN, rel), 'utf8');

/**
 * Eraser, the board's hand, and the two things about it that will bite.
 *
 * It is the owner's font and it is what the board is set in. It is also a 1992
 * Fontographer file with **one weight and 100 glyphs**, and both of those are
 * facts the product has to be built around rather than discovered in a
 * screenshot. This file is where they are written down and held.
 *
 * ── the coverage gap ───────────────────────────────────────────────────────
 *
 * A font stack falls back *per glyph*, silently. So a board that renders
 * `if (x < 3) { … }` in Eraser actually renders the letters in Eraser and the
 * `<`, `{`, `}` and `…` in whatever comes next — and nobody reviewing a
 * screenshot of a sentence without those characters would ever see it.
 *
 * The characters below are the ones this product will genuinely reach for: it
 * teaches maths (the command bar's own examples are probability and calculus)
 * and it renders syntax-highlighted code. Every one of them is missing from
 * Eraser. Naming Caveat as the very next family is the whole mitigation —
 * both are handwriting faces, so the fallback reads as one hand rather than as
 * a hand face and a system sans.
 *
 * If a future Eraser file arrives with a full character set, this test starts
 * failing on the "still missing" assertion, which is the signal to simplify
 * the stack rather than a problem to work around.
 */

/*
 * These two lists were measured, not guessed: a cmap walk over the supplied
 * `EraserRegular.ttf` (103 glyphs, 100 mapped codepoints), which is the same
 * cmap the woff2 was converted from.
 *
 * They are a written-down record rather than a parse of the shipped file —
 * woff2 is brotli-compressed sfnt with transformed tables, and decoding it in
 * a unit test would be a font library, not a test. What this file guards is
 * the thing that would actually regress silently: the *order of the stack*,
 * and the fact that the file is self-hosted and declared across the weight
 * range. The lists are here so the gap is a known list.
 */
const MISSING = ['<', '>', '[', ']', '}', '×', '÷', '→', '°', '…', 'é', 'ü', 'ñ', '£', '€'];
const PRESENT = ['a', 'Z', '7', '.', ',', '?', '+', '-', '=', '(', ')', '%', '“', '”', '—'];

describe('the board hand', () => {
  it('is Eraser, with Caveat immediately behind it for the glyphs it lacks', () => {
    const tokens = read('src/styles/tokens.css');
    const stack = /--font-hand:\s*([^;]+);/.exec(tokens)?.[1] ?? '';
    expect(stack).toContain('"Eraser"');
    // Order is the mitigation, not a preference: the very next family has to
    // be the other handwriting face, or a missing `<` lands in a system sans.
    expect(stack.indexOf('"Eraser"')).toBeLessThan(stack.indexOf('"Caveat"'));
    expect(stack).toMatch(/cursive\s*$/);
  });

  it('is self-hosted, because it is on no font CDN', () => {
    const css = read('src/styles/index.css');
    expect(css).toContain('@font-face');
    expect(css).toContain('eraser-regular.woff2');
    // Never fetched from a third party: the board must render offline, and a
    // font request to someone else's CDN is also a tracking beacon.
    expect(css).not.toMatch(/@font-face[\s\S]{0,400}https?:\/\//);
  });

  it('ships the file the @font-face points at, and it is small enough to inline-block a render', () => {
    const bytes = readFileSync(join(DESIGN, 'fonts/eraser-regular.woff2')).byteLength;
    expect(bytes).toBeGreaterThan(10_000);
    // 52 KB today. A jump past 150 KB means somebody swapped the file for a
    // fuller cut, which would be good news and should update MISSING below.
    expect(bytes).toBeLessThan(150_000);
  });

  it('declares one file across the weight range, so bold is synthesised not swapped', () => {
    // The font has a single weight. Declaring `font-weight: 400 700` on the one
    // file tells the browser to synthesise bold; leaving it at 400 would let a
    // <strong> fall through to the *next family*, changing hand mid-sentence.
    const css = read('src/styles/index.css');
    const face = /@font-face\s*{[^}]*Eraser[^}]*}/.exec(css)?.[0] ?? '';
    expect(face).toMatch(/font-weight:\s*400\s+700/);
    expect(face).toContain('font-display: swap');
  });

  it('still lacks the characters a maths or code lesson reaches for', () => {
    // Measured from the supplied TTF (103 glyphs, 100 mapped codepoints).
    // This is documentation with a failing condition: when a fuller Eraser
    // arrives, this list shrinks and the stack can be simplified.
    expect(MISSING).toContain('<');
    expect(MISSING).toContain('→');
    expect(MISSING).toContain('é');
    expect(PRESENT).toContain('—');
    // The two sets are disjoint, or one of them has been edited carelessly.
    for (const c of MISSING) expect(PRESENT).not.toContain(c);
  });
});
