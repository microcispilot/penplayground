import { type Font, type Glyph, parse } from 'opentype.js';

/**
 * The handwriting font (Caveat, OFL) loaded once with opentype.js so we can
 * take real glyph outlines and reveal them like a pen. The browser side gets
 * the bytes from `@fontsource/caveat` (WOFF; opentype.js 2 parses WOFF, not
 * WOFF2 — verified in Node), tests read the same file from disk.
 *
 * The registry is a module singleton: shapes render from whatever font is
 * loaded, the executor waits for it before creating ink-text shapes, and the
 * Board component kicks the load off on mount.
 */
export class HandFont {
  constructor(readonly font: Font) {}

  get unitsPerEm(): number {
    return this.font.unitsPerEm;
  }

  /** Ascender in em (0..1), e.g. 0.96 for Caveat. */
  get ascent(): number {
    return this.font.ascender / this.font.unitsPerEm;
  }

  /** Descender in em as a positive number, e.g. 0.30 for Caveat. */
  get descent(): number {
    return Math.abs(this.font.descender) / this.font.unitsPerEm;
  }

  glyph(char: string): Glyph {
    return this.font.charToGlyph(char);
  }

  /** False for `.notdef` (index 0): the font has no outline for the character. */
  hasGlyph(char: string): boolean {
    return this.font.charToGlyph(char).index !== 0;
  }

  advance(glyph: Glyph, fontSize: number): number {
    return ((glyph.advanceWidth ?? 0) * fontSize) / this.font.unitsPerEm;
  }

  kerning(left: Glyph, right: Glyph, fontSize: number): number {
    return (this.font.getKerningValue(left, right) * fontSize) / this.font.unitsPerEm;
  }

  /** SVG path data for a glyph with its origin at (x, baselineY), y-down. */
  path(glyph: Glyph, x: number, baselineY: number, fontSize: number): string {
    return glyph.getPath(x, baselineY, fontSize).toPathData(2);
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
 * memo so the next call retries (network blips must not kill handwriting for
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
