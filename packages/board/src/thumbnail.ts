import {
  SKETCH_GRID,
  type SketchElement,
  type SketchInk,
  type SketchLabelSize,
  type SketchSpec,
} from '@pen/contracts';
import type { PathCommand } from 'opentype.js';
import { getStroke } from 'perfect-freehand';
import type { GlyphSource, HandFont } from './font.js';
import type { Point } from './geometry.js';
import { type HandTextLayout, layoutHandText, measureHandText, synthGlyph } from './glyphs.js';
import {
  handArrow,
  handCurve,
  handEllipse,
  handLine,
  handRect,
  handUnderline,
  type Stroke,
  type StrokePoint,
} from './primitives.js';
import { createRng, jitter } from './rng.js';
import { STROKE_STYLE } from './shapes/props.js';
import { labelPoint } from './sketch.js';

/** Server consumers import from `@pen/board/thumbnail` only: the package index pulls in React and tldraw. */
export { type GlyphSource, type HandFont, parseHandFont } from './font.js';

/**
 * Session thumbnail renderer (ADR-0013): `SketchSpec` → self-contained SVG.
 *
 * The sketch is drawn on a 1600 × 900 page — the board's own scale — so the
 * hand primitives (wobble, overshoot, marker width) and Caveat outlines look
 * exactly like the live board; the SVG viewBox scales it to any output size.
 * Nothing external is referenced: text is glyph outlines (deduplicated into
 * `<defs>` and placed with `<use>`, which keeps a 12-element sketch well
 * under 60 KB), colours are literal, the dot grid is a pattern.
 *
 * Determinism: every wobble is seeded from the element index and the caller's
 * seed, so the same spec always yields byte-identical SVG (golden tests).
 */

export const THUMB_PAGE = { w: 1600, h: 900 } as const;
/** Inset so strokes that overshoot the grid edge still land on the paper. */
export const THUMB_MARGIN = 44;

/**
 * Brand colours as literal sRGB (the SVG is an asset rendered outside the
 * app's cascade, and rasterisers do not understand `oklch()`); the OKLCH
 * source is the design token it was converted from (tokens.css, ADR-0007).
 */
export const THUMB_COLOURS = {
  paper: { token: '--color-paper', oklch: 'oklch(0.975 0.008 80)', hex: '#faf6f1' },
  grid: {
    token: '--color-paper-grid',
    oklch: 'oklch(0.285 0.062 247.7 / 16%)',
    hex: '#0c2c47',
    alpha: 0.16,
  },
  ink: { token: '--color-ink', oklch: 'oklch(0.27 0.055 248)', hex: '#0d2840' },
  accent: { token: '--color-ink-accent', oklch: 'oklch(0.597 0.107 218.3)', hex: '#038eaa' },
  highlight: {
    token: '--color-ink-highlight',
    oklch: 'oklch(0.88 0.12 90 / 55%)',
    hex: '#f6d476',
    alpha: 0.55,
  },
} as const;

/** Thumbnail typography (page units). Larger than the board's, since cards show the page at ⅕ scale. */
export const THUMB_TYPE: Record<SketchLabelSize, number> = { lg: 92, md: 62, sm: 44 };
const BOX_TEXT_SIZES = [62, 52, 44, 36, 30];
/** A heavier pen than the board's 3.2 so strokes survive the card scale. */
const PEN = 7;
const MARKER = 16;
const DOT_SPACING = 130;
const DOT_RADIUS = 3.6;

export interface RenderThumbnailOptions {
  /** Output attributes; the viewBox adapts so the sketch is centred on paper of any aspect. */
  width?: number;
  height?: number;
  /** Wobble seed (the session id); defaults to a fixed seed. */
  seed?: string;
}

export interface RenderedThumbnail {
  svg: string;
  bytes: number;
  elements: number;
  /** Characters no loaded font could draw (rendered as a pen squiggle). */
  unsupportedChars: string[];
}

// ── fonts ─────────────────────────────────────────────────────────────────

/** A glyph source that can also hand out raw outline commands (for the unit-size `<defs>`). */
export interface ThumbnailFont extends GlyphSource {
  /** Outline commands with the pen origin at (0, 0); null when no subset has the character. */
  commands(ch: string, fontSize: number): readonly PathCommand[] | null;
}

/**
 * Several Caveat subsets (latin, latin-ext, cyrillic…) behind one
 * `GlyphSource`: the first font that has a character draws it. Kerning only
 * applies between characters of the same font.
 */
export function createThumbnailFont(fonts: readonly HandFont[]): ThumbnailFont {
  const first = fonts[0];
  if (!first) throw new Error('createThumbnailFont: at least one font is required');
  const owner = (ch: string): HandFont | null => fonts.find((f) => f.has(ch)) ?? null;
  return {
    ascent: first.ascent,
    descent: first.descent,
    has: (ch) => owner(ch) !== null,
    advance: (ch, size) => (owner(ch) ?? first).advance(ch, size),
    kerning: (prev, ch, size) => {
      const a = owner(prev);
      return a && a === owner(ch) ? a.kerning(prev, ch, size) : 0;
    },
    path: (ch, x, y, size) => owner(ch)?.path(ch, x, y, size) ?? '',
    commands: (ch, size) => owner(ch)?.glyph(ch).getPath(0, 0, size).commands ?? null,
  };
}

// ── path compaction ───────────────────────────────────────────────────────

function perpendicularDistance(
  p: readonly number[],
  a: readonly number[],
  b: readonly number[],
): number {
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const dx = (b[0] ?? 0) - ax;
  const dy = (b[1] ?? 0) - ay;
  const px = (p[0] ?? 0) - ax;
  const py = (p[1] ?? 0) - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Ramer–Douglas–Peucker; keeps the outline's shape within `tolerance` page units. */
export function simplifyPolyline(points: readonly number[][], tolerance: number): number[][] {
  if (points.length <= 2) return points.map((p) => [...p]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const range = stack.pop();
    if (!range) break;
    const [s, e] = range;
    const a = points[s];
    const b = points[e];
    if (!a || !b) continue;
    let far = -1;
    let farDist = tolerance;
    for (let i = s + 1; i < e; i++) {
      const p = points[i];
      if (!p) continue;
      const d = perpendicularDistance(p, a, b);
      if (d > farDist) {
        farDist = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([s, far], [far, e]);
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([...(points[i] ?? [])]);
  return out;
}

const r0 = (n: number): string => String(Math.round(n));
const r1 = (n: number): string => {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/**
 * perfect-freehand outline → compact filled polygon: simplified within
 * `tolerance` page units, integer coordinates. The board smooths the raw
 * outline with quadratic midpoints; at thumbnail scale the simplified
 * polygon is already smooth and half the bytes, and it cannot fold into
 * the wedge artefacts midpoint smoothing makes at overshot corners.
 */
export function outlineToCompactPath(raw: readonly number[][], tolerance = 1.2): string {
  const finite = raw.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const outline = simplifyPolyline(finite, tolerance);
  if (outline.length < 3) return '';
  let d = '';
  for (const p of outline) d += `${d ? 'L' : 'M'}${r0(p[0] ?? 0)} ${r0(p[1] ?? 0)}`;
  return `${d}Z`;
}

/** Glyphs are defined once at this size and scaled per use; integers at 100 units are 1 % of the em. */
const GLYPH_UNIT = 100;

/**
 * Outline commands → relative integer path data (`m…l…q…c…z`). Deltas are
 * taken between already-rounded absolute points, so rounding never drifts
 * along a contour, and small relative numbers are ~40 % fewer bytes than
 * the absolute form.
 */
export function commandsToRelativePath(commands: readonly PathCommand[]): string {
  let d = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const num = (n: number, first: boolean): string => {
    const t = String(n);
    return first || t.startsWith('-') ? t : ` ${t}`;
  };
  /** Control points and the end point relative to the current point; the last pair moves the pen. */
  const rel = (...pairs: number[]): string => {
    let out = '';
    for (let i = 0; i < pairs.length; i += 2) {
      const px = Math.round(pairs[i] ?? 0);
      const py = Math.round(pairs[i + 1] ?? 0);
      out += num(px - x, i === 0) + num(py - y, false);
      if (i === pairs.length - 2) {
        x = px;
        y = py;
      }
    }
    return out;
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (![c.x, c.y].every(Number.isFinite)) break;
        x = Math.round(c.x);
        y = Math.round(c.y);
        startX = x;
        startY = y;
        d += `M${x}${num(y, false)}`;
        break;
      case 'L':
        if (![c.x, c.y].every(Number.isFinite)) break;
        d += `l${rel(c.x, c.y)}`;
        break;
      case 'Q':
        if (![c.x1, c.y1, c.x, c.y].every(Number.isFinite)) break;
        d += `q${rel(c.x1, c.y1, c.x, c.y)}`;
        break;
      case 'C':
        if (![c.x1, c.y1, c.x2, c.y2, c.x, c.y].every(Number.isFinite)) break;
        d += `c${rel(c.x1, c.y1, c.x2, c.y2, c.x, c.y)}`;
        break;
      case 'Z':
        d += 'z';
        x = startX;
        y = startY;
        break;
    }
  }
  return d;
}

/** Synthesised-symbol path data (absolute M/L/C at the unit size) rounded to integers. */
function compactGlyphPath(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n))));
}

// ── strokes ───────────────────────────────────────────────────────────────

function strokeToPath(points: readonly StrokePoint[], size: number): string {
  if (points.length < 2) return '';
  return outlineToCompactPath(
    getStroke(
      points.map((p) => [p[0], p[1], p[2]]),
      { ...STROKE_STYLE, size, last: true },
    ),
  );
}

function strokesToPaths(strokes: readonly Stroke[], size: number): string[] {
  return strokes.map((s) => strokeToPath(s, size)).filter((d) => d.length > 0);
}

/** Cut a stroke into dashes measured along its length (the pen lifts between them). */
export function dashStroke(points: readonly StrokePoint[], on: number, off: number): Stroke[] {
  const out: Stroke[] = [];
  let current: Stroke = [];
  let acc = 0;
  let drawing = true;
  let budget = on;
  const first = points[0];
  if (first) current.push([first[0], first[1], first[2]]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let from: StrokePoint = a;
    while (seg > 0) {
      if (seg <= budget) {
        budget -= seg;
        acc += seg;
        if (drawing) current.push([b[0], b[1], b[2]]);
        seg = 0;
      } else {
        const t = budget / seg;
        const cut: StrokePoint = [
          from[0] + (b[0] - from[0]) * t,
          from[1] + (b[1] - from[1]) * t,
          b[2],
        ];
        if (drawing) {
          current.push(cut);
          out.push(current);
          current = [];
        } else current = [cut];
        seg -= budget;
        acc += budget;
        from = cut;
        drawing = !drawing;
        budget = drawing ? on : off;
      }
    }
  }
  if (drawing && current.length > 1) out.push(current);
  return acc > 0 ? out : [];
}

/** Catmull-Rom through the points (8 samples per span) for a rounded trace; straight spans otherwise. */
export function tracePolyline(points: readonly Point[], smooth: boolean): Point[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  if (!smooth) return points.map((p) => ({ ...p }));
  const out: Point[] = [];
  const at = (i: number): Point =>
    points[Math.max(0, Math.min(points.length - 1, i))] ?? { x: 0, y: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < 8; k++) {
      const t = k / 8;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...at(points.length - 1) });
  return out;
}

/**
 * One continuous pen stroke along a polyline: resampled every few units,
 * with a slow perpendicular wobble plus a little jitter, like the board's
 * primitives but over the whole path rather than per segment (so a trace
 * reads as one confident line, not a chain of pieces).
 */
export function handTrace(points: readonly Point[], seed: string, amp = 1.4): Stroke {
  const rng = createRng(`trace:${seed}`);
  const f1 = 0.4 + rng() * 0.5;
  const p1 = rng() * Math.PI * 2;
  const stroke: Stroke = [];
  let travelled = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 6));
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const s = (travelled + len * t) / (total || 1);
      const off = amp * Math.sin(Math.PI * 2 * f1 * s * 6 + p1) + jitter(rng, amp * 0.25);
      stroke.push([a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off, 0.5]);
    }
    travelled += len;
  }
  return stroke;
}

function polygonPath(points: readonly StrokePoint[]): string {
  const pts = simplifyPolyline(points, 1.2);
  const first = pts[0];
  if (!first) return '';
  let d = `M${r0(first[0] ?? 0)} ${r0(first[1] ?? 0)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p) d += `L${r0(p[0] ?? 0)} ${r0(p[1] ?? 0)}`;
  }
  return `${d}Z`;
}

// ── glyphs ────────────────────────────────────────────────────────────────

interface GlyphDefs {
  ids: Map<string, string>;
  defs: string[];
}

interface Sink {
  body: string[];
  glyphs: GlyphDefs;
  unsupported: Set<string>;
}

function glyphDef(
  sink: Sink,
  font: ThumbnailFont,
  ch: string,
  kind: 'outline' | 'stroke',
): string | null {
  const key = `${kind}:${ch}`;
  const existing = sink.glyphs.ids.get(key);
  if (existing) return existing;
  const commands = kind === 'outline' ? font.commands(ch, GLYPH_UNIT) : null;
  const d =
    kind === 'outline'
      ? commands
        ? commandsToRelativePath(commands)
        : ''
      : compactGlyphPath(synthGlyph(ch, 0, 0, GLYPH_UNIT)?.d ?? '');
  if (!d) return null;
  const id = `g${sink.glyphs.ids.size}`;
  sink.glyphs.ids.set(key, id);
  sink.glyphs.defs.push(`<path id="${id}" d="${d}"/>`);
  return id;
}

/** Handwriting at (x, y) top-left, from a layout; returns the box it covered. */
function emitText(
  sink: Sink,
  font: ThumbnailFont,
  layout: HandTextLayout,
  x: number,
  y: number,
  color: string,
  seed: string,
): void {
  const fontSize = layout.fontSize;
  const strokeW = Math.max(0.6, fontSize * 0.05);
  const scale = fontSize / GLYPH_UNIT;
  const scaleAttr = scale === 1 ? '' : `scale(${Math.round(scale * 1000) / 1000})`;
  const parts: string[] = [];
  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (g.char === ' ') continue;
      const gx = x + g.x;
      const gy = y + g.y;
      const rot = g.rotation ? `rotate(${r1(g.rotation)})` : '';
      const place = `translate(${r0(gx)} ${r0(gy)})${rot}${scaleAttr}`;
      if (g.kind === 'outline') {
        const id = glyphDef(sink, font, g.char, 'outline');
        if (id) parts.push(`<use href="#${id}" transform="${place}"/>`);
        continue;
      }
      if (g.kind === 'stroke') {
        const id = glyphDef(sink, font, g.char, 'stroke');
        // Stroke width is scaled with the glyph, so it is specified in unit-size terms.
        if (id)
          parts.push(
            `<use href="#${id}" transform="${place}" fill="none" stroke-width="${r1((strokeW * 1.6) / scale)}" stroke-linecap="round"/>`,
          );
        continue;
      }
      // No outline anywhere: a pen squiggle the width of the glyph keeps the word's rhythm.
      sink.unsupported.add(g.char);
      const squiggle = handCurve(
        { x: gx, y: gy - fontSize * 0.3 },
        { x: gx + g.advance * 0.9, y: gy - fontSize * 0.28 },
        fontSize * 0.12,
        `${seed}:${g.index}`,
        fontSize * 0.05,
      );
      for (const d of strokesToPaths(squiggle, Math.max(2, fontSize * 0.06)))
        parts.push(`<path d="${d}" stroke="none"/>`);
    }
  }
  if (parts.length === 0) return;
  // The thin outline stroke thickens Caveat slightly, as on the board; it scales with each glyph.
  sink.body.push(
    `<g fill="${color}" stroke="${color}" stroke-width="${r1((strokeW * 0.5) / scale)}" stroke-linejoin="round">${parts.join('')}</g>`,
  );
}

/** Characters the model writes one way and the pen draws another (Caveat lacks Greek; the synth set has ∑). */
const ALIASES: Record<string, string> = {
  Σ: '∑',
  '−': '-',
  '‐': '-',
  '–': '-',
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '×': 'x',
};

function penText(text: string): string {
  return text.replace(/[Σ−‐–’‘“”×]/g, (ch) => ALIASES[ch] ?? ch);
}

function layoutText(
  font: ThumbnailFont,
  text: string,
  fontSize: number,
  maxWidth: number,
  seed: string,
  align: 'left' | 'center',
): HandTextLayout {
  return layoutHandText(font, penText(text), {
    fontSize,
    maxWidth: Math.max(fontSize, maxWidth),
    seed,
    align,
    // Self-contained SVG: no system font to shape a run, so every character is placed.
    runs: false,
  });
}

/** Largest thumbnail text size whose layout fits a w × h box. */
function fitText(
  font: ThumbnailFont,
  text: string,
  w: number,
  h: number,
  seed: string,
): HandTextLayout {
  let last: HandTextLayout | null = null;
  for (const size of BOX_TEXT_SIZES) {
    last = layoutText(font, text, size, w, seed, 'center');
    if (last.width <= w && last.height <= h) return last;
  }
  return (
    last ??
    layoutText(font, text, BOX_TEXT_SIZES[BOX_TEXT_SIZES.length - 1] ?? 30, w, seed, 'center')
  );
}

// ── elements ──────────────────────────────────────────────────────────────

const inkHex = (ink: SketchInk): string =>
  ink === 'accent' ? THUMB_COLOURS.accent.hex : THUMB_COLOURS.ink.hex;

interface Grid {
  cx: number;
  cy: number;
  ox: number;
  oy: number;
}

function emitFilled(sink: Sink, paths: readonly string[], color: string, extra = ''): void {
  if (paths.length === 0) return;
  sink.body.push(`<g fill="${color}"${extra}>${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`);
}

function emitElement(
  sink: Sink,
  font: ThumbnailFont,
  el: SketchElement,
  i: number,
  g: Grid,
  seed: string,
): void {
  const s = `${seed}:${i}`;
  const X = (v: number) => g.ox + v * g.cx;
  const Y = (v: number) => g.oy + v * g.cy;
  switch (el.kind) {
    case 'label': {
      const color = inkHex(el.ink);
      const size = THUMB_TYPE[el.size];
      // The model's `w` is a hint: a title that fits on one line inside the grid stays on one line.
      const single = measureHandText(font, penText(el.text), size);
      const room = (SKETCH_GRID.columns - el.x) * g.cx;
      // Wrapping measures word by word (no kerning across spaces), so allow half an em of slack.
      const maxWidth = Math.max(
        el.w * g.cx,
        single <= room ? single + size * 0.5 : Math.min(room, el.w * g.cx),
      );
      const layout = layoutText(font, el.text, size, maxWidth, s, 'left');
      emitText(sink, font, layout, X(el.x), Y(el.y) + size * 0.08, color, s);
      return;
    }
    case 'box':
    case 'circle': {
      const color = inkHex(el.ink);
      const pad = 12;
      const x = X(el.x) + pad;
      const y = Y(el.y) + pad;
      const w = Math.max(24, el.w * g.cx - pad * 2);
      const h = Math.max(24, el.h * g.cy - pad * 2);
      const strokes = el.kind === 'box' ? handRect(w, h, s) : handEllipse(w, h, s);
      const paths = strokesToPaths(strokes, PEN);
      sink.body.push(
        `<g fill="${color}" transform="translate(${r0(x)} ${r0(y)})">${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`,
      );
      if (el.text) {
        const inset = el.kind === 'circle' ? 0.78 : 0.86;
        const layout = fitText(font, el.text, w * inset, h * inset, s);
        emitText(
          sink,
          font,
          layout,
          x + (w - layout.width) / 2,
          y + (h - layout.height) / 2 + layout.fontSize * 0.04,
          color,
          s,
        );
      }
      return;
    }
    case 'arrow': {
      const color = inkHex(el.ink);
      const a: Point = { x: X(el.x1), y: Y(el.y1) };
      const b: Point = { x: X(el.x2), y: Y(el.y2) };
      emitFilled(sink, strokesToPaths(handArrow(a, b, s), PEN), color);
      if (el.text) {
        const at = labelPoint(a, b, 34);
        const layout = layoutText(font, el.text, THUMB_TYPE.sm, 4 * g.cx, s, 'center');
        emitText(sink, font, layout, at.x - layout.width / 2, at.y - layout.height / 2, color, s);
      }
      return;
    }
    case 'line': {
      const color = inkHex(el.ink);
      const a: Point = { x: X(el.x1), y: Y(el.y1) };
      const b: Point = { x: X(el.x2), y: Y(el.y2) };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // Sagitta ≈ a sixth of the length, capped: a clear gesture, never a semicircle. The primitives
      // bow to the right of a→b, which on a y-down page is screen-down for a left→right line.
      const bow = el.curve === 'none' ? 0 : (el.curve === 'up' ? -1 : 1) * Math.min(len * 0.17, 48);
      const strokes = el.curve === 'none' ? handLine(a, b, s) : handCurve(a, b, bow, s);
      const pieces = el.dashed ? strokes.flatMap((st) => dashStroke(st, 30, 20)) : strokes;
      emitFilled(sink, strokesToPaths(pieces, PEN), color);
      return;
    }
    case 'bars': {
      const color = inkHex(el.ink);
      const pad = 14;
      const x = X(el.x) + pad;
      const y = Y(el.y) + pad;
      const w = Math.max(40, el.w * g.cx - pad * 2);
      const h = Math.max(40, el.h * g.cy - pad * 2);
      const axis = [
        ...handLine({ x, y: y + h }, { x: x + w, y: y + h }, `${s}:ax`),
        ...handLine({ x, y: y + h }, { x, y }, `${s}:ay`),
      ];
      emitFilled(sink, strokesToPaths(axis, PEN), color);
      const n = el.values.length;
      const slot = (w - 16) / n;
      const bw = slot * 0.64;
      const fills: string[] = [];
      const outlines: string[] = [];
      el.values.forEach((v, k) => {
        const bh = Math.max(6, v * (h - 12));
        const bx = x + 16 + slot * k + (slot - bw) / 2;
        const by = y + h - bh;
        const rect = handRect(bw, bh, `${s}:b${k}`);
        const first = rect[0];
        if (first)
          fills.push(polygonPath(first.map((p): StrokePoint => [p[0] + bx, p[1] + by, p[2]])));
        for (const d of strokesToPaths(rect, PEN * 0.9))
          outlines.push(`<path d="${d}" transform="translate(${r0(bx)} ${r0(by)})"/>`);
      });
      emitFilled(sink, fills, color, ' fill-opacity="0.14"');
      sink.body.push(`<g fill="${color}">${outlines.join('')}</g>`);
      return;
    }
    case 'trace': {
      const pts = tracePolyline(
        el.points.map((p) => ({ x: X(p.x), y: Y(p.y) })),
        el.smooth,
      );
      emitFilled(sink, strokesToPaths([handTrace(pts, s)], PEN), inkHex(el.ink));
      return;
    }
    case 'underline': {
      const strokes = handUnderline(el.w * g.cx - 8, s);
      const paths = strokesToPaths(strokes, MARKER * 0.55);
      sink.body.push(
        `<g fill="${inkHex(el.ink)}" fill-opacity="0.9" transform="translate(${r0(X(el.x) + 4)} ${r0(Y(el.y))})">${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`,
      );
      return;
    }
    case 'highlight': {
      const x = X(el.x) + 6;
      const y = Y(el.y) + 6;
      const w = Math.max(20, el.w * g.cx - 12);
      const h = Math.max(20, el.h * g.cy - 12);
      // Four wobbly edges, no corner overshoot: a marker wash must stay one clean fill.
      const corners: Point[] = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      const rect = corners.flatMap((a, k) => {
        const b = corners[(k + 1) % 4] ?? a;
        return handCurve(a, b, 0, `${s}:e${k}`, 2.4)[0] ?? [];
      });
      const d = polygonPath(rect);
      sink.body.push(
        `<path d="${d}" fill="${THUMB_COLOURS.highlight.hex}" fill-opacity="${THUMB_COLOURS.highlight.alpha}"/>`,
      );
      return;
    }
  }
}

// ── document ──────────────────────────────────────────────────────────────

/**
 * Render a sketch to a self-contained SVG string. Output `width`/`height`
 * default to 320 × 180; other aspects (1200 × 630 for Open Graph) keep the
 * sketch centred and extend the paper and its dot grid to the edges.
 */
export function renderSketchSvg(
  spec: SketchSpec,
  font: ThumbnailFont,
  opts: RenderThumbnailOptions = {},
): RenderedThumbnail {
  const width = Math.max(16, Math.round(opts.width ?? 320));
  const height = Math.max(9, Math.round(opts.height ?? 180));
  const seed = opts.seed ?? 'thumb';
  const aspect = width / height;
  const pageAspect = THUMB_PAGE.w / THUMB_PAGE.h;
  const vbW = aspect >= pageAspect ? THUMB_PAGE.h * aspect : THUMB_PAGE.w;
  const vbH = aspect >= pageAspect ? THUMB_PAGE.h : THUMB_PAGE.w / aspect;
  const ox = (vbW - THUMB_PAGE.w) / 2;
  const oy = (vbH - THUMB_PAGE.h) / 2;

  const grid: Grid = {
    cx: (THUMB_PAGE.w - THUMB_MARGIN * 2) / SKETCH_GRID.columns,
    cy: (THUMB_PAGE.h - THUMB_MARGIN * 2) / SKETCH_GRID.rows,
    ox: THUMB_MARGIN,
    oy: THUMB_MARGIN,
  };
  const sink: Sink = { body: [], glyphs: { ids: new Map(), defs: [] }, unsupported: new Set() };

  // Highlights go under the ink whatever order the model listed them in.
  const ordered = [...spec.elements.entries()].sort(
    ([, a], [, b]) => Number(b.kind === 'highlight') - Number(a.kind === 'highlight'),
  );
  for (const [i, el] of ordered) emitElement(sink, font, el, i, grid, seed);

  const paper = THUMB_COLOURS.paper.hex;
  const dots = THUMB_COLOURS.grid;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${r1(vbW)} ${r1(vbH)}" role="img" aria-label="Sketch of the session's key idea">` +
    `<defs><pattern id="dots" width="${DOT_SPACING}" height="${DOT_SPACING}" patternUnits="userSpaceOnUse" x="${r1(ox + THUMB_MARGIN)}" y="${r1(oy + THUMB_MARGIN)}"><circle cx="0" cy="0" r="${DOT_RADIUS}" fill="${dots.hex}" fill-opacity="${dots.alpha}"/></pattern>${sink.glyphs.defs.join('')}</defs>` +
    `<rect width="100%" height="100%" fill="${paper}"/><rect width="100%" height="100%" fill="url(#dots)"/>` +
    `<g transform="translate(${r1(ox)} ${r1(oy)})">${sink.body.join('')}</g></svg>`;
  return {
    svg,
    bytes: new TextEncoder().encode(svg).length,
    elements: spec.elements.length,
    unsupportedChars: [...sink.unsupported],
  };
}
