import type { GlyphSource } from './font.js';
import { createRng, jitter } from './rng.js';
import { sanitisePathData } from './svg-path.js';
import { hasRtlChars } from './text-direction.js';

/**
 * Handwritten text layout: glyph outlines from the hand font, kerned, wrapped
 * at a max width, with a small deterministic per-glyph jitter (±1 px baseline,
 * ±1.5° rotation) so a line reads as a hand rather than a typeface.
 * Coordinates are relative to the layout's top-left corner, y-down.
 */

export type GlyphKind =
  /** Filled outline from the font. */
  | 'outline'
  /** Synthesised pen strokes for symbols the font lacks (√ → ≤ …); stroked, not filled. */
  | 'stroke'
  /** No outline at all: the renderer draws the character as text in the CSS hand font. */
  | 'fallback'
  /**
   * A whole line of right-to-left text (Arabic script, Hebrew). Its letters
   * join and run the other way, so the browser shapes the run as one `<text>`
   * element instead of the pen placing each glyph. `char` is the line.
   */
  | 'run';

export interface GlyphPlacement {
  char: string;
  /** Index of the character in the source text (spaces and newlines included). */
  index: number;
  kind: GlyphKind;
  /** SVG path data (empty for `fallback`). */
  d: string;
  /** Pen origin: x of the glyph's left side bearing, y of the baseline. */
  x: number;
  y: number;
  advance: number;
  /** Degrees, applied around (x, y). */
  rotation: number;
  /** `run` only: how many characters the run covers, so the reveal can pace it. */
  chars?: number;
  /** `run` only: the run is drawn right to left and anchored at its right edge. */
  rtl?: boolean;
}

export interface TextLine {
  text: string;
  glyphs: GlyphPlacement[];
  width: number;
  /** Baseline y relative to the layout top. */
  baseline: number;
}

export interface HandTextLayout {
  lines: TextLine[];
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  /** Characters the pen has to write (pacing unit). */
  charCount: number;
  /**
   * Characters whose path carried a non-finite coordinate and was sanitised.
   * Empty in practice; surfaced so the executor can report a broken font.
   */
  invalidGlyphs: string[];
}

export interface HandTextOptions {
  fontSize: number;
  maxWidth: number;
  /** Deterministic jitter seed (the shape id). */
  seed: string;
  align?: 'left' | 'center';
  /** Multiplier of fontSize; Caveat needs ~1.25 for descenders not to collide. */
  lineHeight?: number;
  jitter?: boolean;
  /**
   * Draw right-to-left lines as one shaped `<text>` run (default). The
   * thumbnail renderer turns this off: its SVG has to stand alone, with no
   * system font to shape a run, so it keeps its per-character squiggles.
   */
  runs?: boolean;
}

export const BASELINE_JITTER_PX = 1;
export const ROTATION_JITTER_DEG = 1.5;
export const DEFAULT_LINE_HEIGHT = 1.3;

/** Kerned single-line width in world units. */
export function measureHandText(font: GlyphSource, text: string, fontSize: number): number {
  let x = 0;
  let prev: string | null = null;
  for (const ch of text) {
    const missing = !font.has(ch);
    if (prev !== null && !missing) x += font.kerning(prev, ch, fontSize);
    x += glyphAdvance(font, ch, fontSize);
    prev = missing ? null : ch;
  }
  return x;
}

/**
 * A word gap is never narrower than this many ems. Patrick Hand's own space is
 * a hair over a fifth of an em, and "Int Double UInt" ran together on the board
 * (the owner, 2026-09-25); a hand leaves more room between words than that.
 */
export const WORD_GAP_MIN_EM = 0.32;

/** Advance for any character: the font's, a synthesised symbol's, or the fallback width. */
function glyphAdvance(font: GlyphSource, ch: string, fontSize: number): number {
  if (ch === ' ') return Math.max(font.advance(ch, fontSize), fontSize * WORD_GAP_MIN_EM);
  if (font.has(ch)) return font.advance(ch, fontSize);
  const synth = SYNTH[ch];
  if (synth) return synth.advance * fontSize;
  return font.advance(ch, fontSize) || fontSize * 0.55;
}

/** Greedy word wrap; a single word longer than the width breaks by character. */
export function wrapHandText(
  font: GlyphSource,
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const spaceW = glyphAdvance(font, ' ', fontSize);
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/ +/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    let lineW = 0;
    for (const word of words) {
      const wordW = measureHandText(font, word, fontSize);
      if (wordW > maxWidth) {
        // Break the long word by characters.
        for (const ch of word) {
          const chW = measureHandText(font, ch, fontSize);
          if (line && lineW + chW > maxWidth) {
            out.push(line);
            line = '';
            lineW = 0;
          }
          line += ch;
          lineW += chW;
        }
        continue;
      }
      const needed = line ? spaceW + wordW : wordW;
      if (line && lineW + needed > maxWidth) {
        out.push(line);
        line = word;
        lineW = wordW;
      } else {
        line = line ? `${line} ${word}` : word;
        lineW += needed;
      }
    }
    out.push(line);
  }
  return out;
}

export function layoutHandText(
  font: GlyphSource,
  text: string,
  opts: HandTextOptions,
): HandTextLayout {
  const fontSize = opts.fontSize;
  const lineHeight = fontSize * (opts.lineHeight ?? DEFAULT_LINE_HEIGHT);
  const useJitter = opts.jitter ?? true;
  const rng = createRng(`${opts.seed}:${text}`);
  const lines = wrapHandText(font, text, fontSize, Math.max(fontSize, opts.maxWidth));

  // Measure first so centred lines know the block width.
  const widths = lines.map((l) => measureHandText(font, l, fontSize));
  const width = widths.reduce((m, w) => Math.max(m, w), 0);
  const ascent = fontSize * font.ascent;

  const outLines: TextLine[] = [];
  const invalidGlyphs: string[] = [];
  let index = 0;
  lines.forEach((line, li) => {
    const baseline = li * lineHeight + ascent;
    const lineW = widths[li] ?? 0;
    let x = opts.align === 'center' ? (width - lineW) / 2 : 0;
    const glyphs: GlyphPlacement[] = [];
    // Arabic script and Hebrew: one shaped run, anchored at its right edge. Drawing them
    // glyph by glyph would disconnect the letters and reverse the word.
    if ((opts.runs ?? true) && hasRtlChars(line)) {
      glyphs.push({
        char: line,
        index,
        kind: 'run',
        d: '',
        x: x + lineW,
        y: baseline,
        advance: lineW,
        rotation: 0,
        chars: [...line].length,
        rtl: true,
      });
      index += line.length + 1;
      outLines.push({ text: line, glyphs, width: lineW, baseline });
      return;
    }
    let prev: string | null = null;
    for (const ch of line) {
      const missing = !font.has(ch);
      if (prev !== null && !missing) x += font.kerning(prev, ch, fontSize);
      const rot = useJitter ? jitter(rng, ROTATION_JITTER_DEG) : 0;
      const dy = useJitter ? jitter(rng, BASELINE_JITTER_PX) : 0;
      const y = baseline + dy;
      const rawAdvance = glyphAdvance(font, ch, fontSize);
      // A font reporting a non-finite advance must not poison every glyph after it.
      const advance = Number.isFinite(rawAdvance) ? rawAdvance : fontSize * 0.5;
      if (!Number.isFinite(x)) x = 0;
      if (missing) {
        const synth = ch === ' ' ? null : synthGlyph(ch, x, y, fontSize);
        glyphs.push({
          char: ch,
          index,
          kind: synth ? 'stroke' : 'fallback',
          d: safePath(synth?.d ?? '', ch, invalidGlyphs),
          x,
          y,
          advance,
          rotation: rot,
        });
        prev = null;
      } else {
        glyphs.push({
          char: ch,
          index,
          kind: 'outline',
          d: ch === ' ' ? '' : safePath(font.path(ch, x, y, fontSize), ch, invalidGlyphs),
          x,
          y,
          advance,
          rotation: rot,
        });
        prev = ch;
      }
      x += advance;
      index += 1;
    }
    index += 1; // the newline / wrap boundary
    outLines.push({ text: line, glyphs, width: lineW, baseline });
  });

  return {
    lines: outLines,
    width,
    height: lines.length * lineHeight,
    fontSize,
    lineHeight,
    charCount: text.length,
    invalidGlyphs,
  };
}

/** Guard every path string that leaves the layout; records the character when something was dropped. */
function safePath(d: string, ch: string, invalid: string[]): string {
  const s = sanitisePathData(d);
  if (s.dropped > 0) invalid.push(ch);
  return s.d;
}

// ── synthesised symbols ───────────────────────────────────────────────────
// Caveat has no √, →, ≤ … which lessons use constantly. Rather than dropping
// to a system font, draw them as pen strokes in a unit box: x in em, y from 0
// (top of the x-height-ish band, 0.72 em above the baseline) to 1 (baseline).

interface Synth {
  advance: number;
  /** Path in unit coordinates. */
  d: string;
}

const SYNTH: Record<string, Synth> = {
  '√': { advance: 1.05, d: 'M0.05 0.55 L0.24 0.98 L0.5 0.02 L1 0.02' },
  '→': { advance: 1.1, d: 'M0.05 0.55 L1 0.55 M0.74 0.3 L1 0.55 L0.74 0.8' },
  '←': { advance: 1.1, d: 'M1 0.55 L0.05 0.55 M0.31 0.3 L0.05 0.55 L0.31 0.8' },
  '↔': {
    advance: 1.2,
    d: 'M0.05 0.55 L1.1 0.55 M0.3 0.3 L0.05 0.55 L0.3 0.8 M0.85 0.3 L1.1 0.55 L0.85 0.8',
  },
  '⇒': {
    advance: 1.1,
    d: 'M0.05 0.45 L0.85 0.45 M0.05 0.65 L0.85 0.65 M0.72 0.25 L1 0.55 L0.72 0.85',
  },
  '≤': { advance: 0.95, d: 'M0.8 0.1 L0.15 0.45 L0.8 0.75 M0.15 0.95 L0.8 0.95' },
  '≥': { advance: 0.95, d: 'M0.15 0.1 L0.8 0.45 L0.15 0.75 M0.15 0.95 L0.8 0.95' },
  '≠': { advance: 0.95, d: 'M0.12 0.42 L0.85 0.42 M0.12 0.68 L0.85 0.68 M0.65 0.1 L0.32 1' },
  '≈': {
    advance: 0.95,
    d: 'M0.1 0.45 C0.3 0.25 0.5 0.6 0.85 0.4 M0.1 0.75 C0.3 0.55 0.5 0.9 0.85 0.7',
  },
  '∑': { advance: 0.95, d: 'M0.85 0.12 L0.15 0.1 L0.55 0.52 L0.15 0.95 L0.85 0.95' },
  '∞': {
    advance: 1.15,
    d: 'M0.55 0.55 C0.42 0.3 0.05 0.35 0.08 0.55 C0.05 0.78 0.42 0.8 0.55 0.55 C0.68 0.3 1.05 0.35 1.02 0.55 C1.05 0.78 0.68 0.8 0.55 0.55',
  },
  π: {
    advance: 0.95,
    d: 'M0.05 0.32 C0.3 0.25 0.6 0.28 0.9 0.3 M0.3 0.32 L0.26 0.98 M0.68 0.32 C0.7 0.6 0.66 0.85 0.82 0.98',
  },
  λ: { advance: 0.8, d: 'M0.12 0.05 C0.3 0.12 0.4 0.4 0.72 0.98 M0.5 0.5 L0.1 0.98' },
  μ: {
    advance: 0.85,
    d: 'M0.12 0.35 L0.1 1.1 M0.12 0.35 L0.15 0.85 C0.2 0.98 0.55 0.98 0.62 0.8 L0.66 0.35 M0.62 0.8 C0.66 0.98 0.78 0.98 0.85 0.9',
  },
  '∈': { advance: 0.9, d: 'M0.8 0.18 C0.2 0.05 0.15 0.95 0.8 0.92 M0.25 0.55 L0.78 0.55' },
  '·': { advance: 0.35, d: 'M0.15 0.6 L0.18 0.62' },
  '≡': { advance: 0.95, d: 'M0.12 0.3 L0.85 0.3 M0.12 0.55 L0.85 0.55 M0.12 0.8 L0.85 0.8' },
  '±': { advance: 0.9, d: 'M0.45 0.15 L0.45 0.7 M0.12 0.42 L0.8 0.42 M0.12 0.95 L0.8 0.95' },
  '∂': {
    advance: 0.8,
    d: 'M0.2 0.15 C0.5 0.05 0.75 0.2 0.7 0.55 C0.68 0.85 0.5 1 0.3 0.95 C0.05 0.85 0.12 0.5 0.45 0.5 C0.6 0.5 0.68 0.6 0.7 0.55',
  },
  '∇': { advance: 0.9, d: 'M0.1 0.1 L0.8 0.1 L0.45 0.95 Z' },
};

const SYNTH_BAND = 0.72;

/** Pen strokes for a symbol the font lacks, positioned at (x, baseline). */
export function synthGlyph(
  ch: string,
  x: number,
  baseline: number,
  fontSize: number,
): Synth | null {
  const s = SYNTH[ch];
  if (!s) return null;
  const d = s.d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_m, ux: string, uy: string) => {
    const px = x + Number(ux) * fontSize;
    const py = baseline - (1 - Number(uy)) * SYNTH_BAND * fontSize;
    return `${px.toFixed(2)} ${py.toFixed(2)}`;
  });
  return { advance: s.advance * fontSize, d };
}

export function hasSynthGlyph(ch: string): boolean {
  return Boolean(SYNTH[ch]);
}
