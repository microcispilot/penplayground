/// <reference path="./types/opentype.d.ts" />
import { type Font, type Glyph, parse } from 'opentype.js';
import { commandsToPathData } from './svg-path.js';

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

export function parseHandFont(bytes: ArrayBuffer | Uint8Array): HandFont {
  const buffer =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes;
  return new HandFont(parse(buffer as ArrayBuffer));
}

let current: HandFont | null = null;
let pending: Promise<HandFont> | null = null;
const waiters: Array<(f: HandFont) => void> = [];

export function getHandFont(): HandFont | null {
  return current;
}

export function setHandFont(font: HandFont | null): void {
  current = font;
  if (font) {
    const list = waiters.splice(0, waiters.length);
    for (const w of list) w(font);
  }
}

/** Resolves as soon as a hand font is available (immediately if it already is). */
export function whenHandFont(): Promise<HandFont> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  return new Promise<HandFont>((resolve) => waiters.push(resolve));
}

/**
 * Load once; concurrent callers share the promise. A failed load clears the
 * memo so the next call retries (a network blip must not kill handwriting for
 * the whole session).
 */
export function loadHandFont(loader: () => Promise<ArrayBuffer>): Promise<HandFont> {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  pending = loader()
    .then((bytes) => {
      const font = parseHandFont(bytes);
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
