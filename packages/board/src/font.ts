/// <reference path="./types/opentype.d.ts" />

import type { Font, Glyph } from 'opentype.js';
import * as opentype from 'opentype.js';
import { commandsToPathData } from './svg-path.js';

/**
 * opentype.js 2.0 ships an ESM build for bundlers and a UMD `main` for Node.
 * Node's named-export detection cannot see `parse` through the UMD wrapper
 * (the API renders thumbnails with this module under plain Node), so it is
 * reached through the namespace's `default` there.
 */
type ParseFont = (buffer: ArrayBuffer) => Font;
const parseFont: ParseFont | undefined =
  (opentype as { parse?: ParseFont }).parse ??
  (opentype as { default?: { parse?: ParseFont } }).default?.parse;

/**
 * The handwriting font (Caveat, OFL) loaded once with opentype.js so we can
 * take real glyph outlines and reveal them like a pen. The browser side gets
 * the bytes from `@fontsource/caveat` (WOFF; opentype.js 2 parses WOFF, not
 * WOFF2 — verified in Node), tests read the same file from disk.
 *
 * `GlyphSource` is the seam the layout engine uses: `HandFont` implements it
 * with real outlines; `FallbackFont` implements it with average metrics so
 * text can still be laid out and revealed (as CSS-font text) if the font
 * fails to load. The lesson never stalls on a font.
 */
export interface GlyphSource {
  /** Ascender in em (0..1). */
  readonly ascent: number;
  /** Descender in em, positive. */
  readonly descent: number;
  /** True when a real outline exists for the character. */
  has(ch: string): boolean;
  advance(ch: string, fontSize: number): number;
  kerning(prev: string, ch: string, fontSize: number): number;
  /** SVG path data with the pen origin at (x, baselineY), y-down; '' when `has` is false. */
  path(ch: string, x: number, baselineY: number, fontSize: number): string;
}

export class HandFont implements GlyphSource {
  private readonly cache = new Map<string, Glyph>();

  constructor(readonly font: Font) {}

  get unitsPerEm(): number {
    return this.font.unitsPerEm;
  }

  get ascent(): number {
    return this.font.ascender / this.font.unitsPerEm;
  }

  get descent(): number {
    return Math.abs(this.font.descender) / this.font.unitsPerEm;
  }

  glyph(ch: string): Glyph {
    let g = this.cache.get(ch);
    if (!g) {
      g = this.font.charToGlyph(ch);
      this.cache.set(ch, g);
    }
    return g;
  }

  has(ch: string): boolean {
    return this.glyph(ch).index !== 0;
  }

  advance(ch: string, fontSize: number): number {
    const adv = this.glyph(ch).advanceWidth;
    if (typeof adv !== 'number' || !Number.isFinite(adv)) return 0;
    return (adv * fontSize) / this.font.unitsPerEm;
  }

  kerning(prev: string, ch: string, fontSize: number): number {
    const a = this.glyph(prev);
    const b = this.glyph(ch);
    if (a.index === 0 || b.index === 0) return 0;
    const k = this.font.getKerningValue(a, b);
    return Number.isFinite(k) ? (k * fontSize) / this.font.unitsPerEm : 0;
  }

  /**
   * Serialised from `path.commands`, never via opentype's `toPathData()`,
   * whose number formatter emits "NaN" for some finite values (see svg-path.ts).
   */
  path(ch: string, x: number, baselineY: number, fontSize: number): string {
    const g = this.glyph(ch);
    if (g.index === 0) return '';
    return commandsToPathData(g.getPath(x, baselineY, fontSize).commands).d;
  }
}

/**
 * Metrics-only stand-in (Caveat-ish proportions) used when the font is not
 * available. Every character reports `has() === false`, so the renderer draws
 * it as text in the CSS hand font (which the design package ships) instead of
 * an outline; the pen reveal still works through the clip.
 */
export class FallbackFont implements GlyphSource {
  readonly ascent = 0.96;
  readonly descent = 0.3;
  has(): boolean {
    return false;
  }
  advance(ch: string, fontSize: number): number {
    if (ch === ' ') return fontSize * 0.22;
    if (/[iljtf.,:;'|!]/.test(ch)) return fontSize * 0.24;
    if (/[mwMW]/.test(ch)) return fontSize * 0.62;
    if (/[A-Z]/.test(ch)) return fontSize * 0.5;
    return fontSize * 0.42;
  }
  kerning(): number {
    return 0;
  }
  path(): string {
    return '';
  }
}

/**
 * Two fonts, one hand: the primary for every glyph it has, a second for the
 * rest.
 *
 * Eraser is the board's hand and it has 100 glyphs. It has no `<`, `>`, `[`,
 * `]`, `}`, `\u00d7`, `\u00f7`, `\u2192`, `\u00b0`, `\u2026` and no accented letters — and this
 * product teaches maths and renders code, so it meets all of them. Without a
 * fallback each one draws as `.notdef`, which on a board is a blank or a box
 * in the middle of an equation. The owner: *"use another font for things it's
 * not able to handle."*
 *
 * CSS does this per glyph automatically; outlines do not, because the board
 * takes its glyphs from parsed font bytes rather than from the cascade. So the
 * cascade is reproduced here, deliberately and in one place.
 *
 * Two details that are easy to get wrong:
 *
 *   **Metrics come from the primary, always.** Ascent and descent set the
 *   baseline grid for the whole line; taking them per glyph would make a line
 *   containing one `\u2192` sit differently from the line above it.
 *
 *   **Kerning only applies within one font.** A kerning pair is a fact about
 *   two glyphs in the same design; asking Eraser how it kerns against a Caveat
 *   bracket is meaningless, and opentype would answer 0 anyway. Returning 0
 *   explicitly says so rather than relying on that.
 */
export class LayeredFont implements GlyphSource {
  constructor(
    private readonly primary: GlyphSource,
    private readonly fallback: GlyphSource,
  ) {}

  get ascent(): number {
    return this.primary.ascent;
  }

  get descent(): number {
    return this.primary.descent;
  }

  /** Whichever font actually draws this character. */
  private source(ch: string): GlyphSource {
    return this.primary.has(ch) ? this.primary : this.fallback;
  }

  has(ch: string): boolean {
    return this.primary.has(ch) || this.fallback.has(ch);
  }

  advance(ch: string, fontSize: number): number {
    return this.source(ch).advance(ch, fontSize);
  }

  kerning(prev: string, ch: string, fontSize: number): number {
    const a = this.source(prev);
    return a === this.source(ch) ? a.kerning(prev, ch, fontSize) : 0;
  }

  path(ch: string, x: number, baselineY: number, fontSize: number): string {
    return this.source(ch).path(ch, x, baselineY, fontSize);
  }
}

export function parseHandFont(bytes: ArrayBuffer | Uint8Array): HandFont {
  const buffer =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes;
  if (!parseFont) throw new Error('opentype.js: parse() is not available in this runtime');
  return new HandFont(parseFont(buffer as ArrayBuffer));
}

// A `GlyphSource`, not a `HandFont`: once a fallback is supplied this holds a
// `LayeredFont`, and every consumer only ever asked for the interface.
let current: GlyphSource | null = null;
let pending: Promise<GlyphSource> | null = null;
const waiters: Array<(f: GlyphSource) => void> = [];

export function getHandFont(): GlyphSource | null {
  return current;
}

export function setHandFont(font: GlyphSource | null): void {
  current = font;
  if (font) {
    const list = waiters.splice(0, waiters.length);
    for (const w of list) w(font);
  }
}

/** Resolves as soon as a hand font is available (immediately if it already is). */
export function whenHandFont(): Promise<GlyphSource> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  return new Promise<GlyphSource>((resolve) => waiters.push(resolve));
}

/**
 * Load once; concurrent callers share the promise. A failed load clears the
 * memo so the next call retries (a network blip must not kill handwriting for
 * the whole session).
 */
export function loadHandFont(
  loader: () => Promise<ArrayBuffer>,
  /**
   * Bytes for the glyphs the primary lacks. Optional, and a failure here is
   * not a failure: a board in one font with a few blanks is still a lesson,
   * where no board at all is not. So the fallback is awaited but never allowed
   * to reject the primary.
   */
  fallbackLoader?: () => Promise<ArrayBuffer>,
): Promise<GlyphSource> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  pending = loader()
    .then(async (bytes) => {
      const primary = parseHandFont(bytes);
      const second = fallbackLoader
        ? await fallbackLoader()
            .then((b) => parseHandFont(b))
            .catch(() => null)
        : null;
      const font = second ? new LayeredFont(primary, second) : primary;
      pending = null;
      setHandFont(font);
      return font;
    })
    .catch((err: unknown) => {
      pending = null;
      throw err;
    });
  return pending;
}

/** Test hook. */
export function resetHandFontForTests(): void {
  current = null;
  pending = null;
  waiters.length = 0;
}
