import { z } from 'zod';
import { Expert } from './expert.js';

/**
 * Session thumbnails (ADR-0013). One background model call per session
 * returns the card copy and a `SketchSpec`: a tight sketch language the
 * renderer turns into the whiteboard-style SVG. The model draws the way a
 * teacher sketches the key idea on a board: a few labels, boxes, arrows.
 *
 * Coordinates are grid units on a 12 × 7 grid over a 16:9 canvas
 * (nominally 320 × 180): x in [0, 12], y in [0, 7]. The renderer maps grid
 * units to its own page units, so the spec never carries pixels.
 */

export const SKETCH_GRID = { columns: 12, rows: 7 } as const;
export const SKETCH_MAX_ELEMENTS = 12;
export const SKETCH_MAX_LABEL_CHARS = 40;
export const SKETCH_MAX_BARS = 8;
export const SKETCH_MAX_TRACE_POINTS = 16;
export const META_MAX_DESCRIPTION_CHARS = 160;
export const META_MIN_KEYWORDS = 3;
export const META_MAX_KEYWORDS = 6;
export const META_MAX_KEYWORD_CHARS = 32;

export const SketchInk = z.enum(['ink', 'accent']);
export type SketchInk = z.infer<typeof SketchInk>;

/**
 * `xl` is the card's headline — the three-or-four-word line a thumbnail is
 * read by in a grid, at roughly a sixth of the card's height. The other three
 * are the sketch's own labels.
 */
export const SketchLabelSize = z.enum(['xl', 'lg', 'md', 'sm']);
export type SketchLabelSize = z.infer<typeof SketchLabelSize>;

export const SketchCurve = z.enum(['none', 'up', 'down']);
export type SketchCurve = z.infer<typeof SketchCurve>;

export const SessionCategory = Expert.shape.domain;
export type SessionCategory = z.infer<typeof SessionCategory>;

const gx = z.number().min(0).max(SKETCH_GRID.columns);
const gy = z.number().min(0).max(SKETCH_GRID.rows);
const span = z.number().min(0.5);
const label = z.string().max(SKETCH_MAX_LABEL_CHARS);

// ── the bounded contract (what the renderer accepts) ─────────────────────

export const SketchLabel = z.object({
  kind: z.literal('label'),
  text: label.min(1),
  x: gx,
  y: gy,
  /** Wrap width in grid columns. */
  w: span,
  size: SketchLabelSize,
  ink: SketchInk,
});
export const SketchBox = z.object({
  kind: z.literal('box'),
  x: gx,
  y: gy,
  w: span,
  h: span,
  /** Centred inside the box; empty for a plain box. */
  text: label,
  ink: SketchInk,
});
export const SketchCircle = z.object({
  kind: z.literal('circle'),
  x: gx,
  y: gy,
  w: span,
  h: span,
  text: label,
  ink: SketchInk,
});
export const SketchArrow = z.object({
  kind: z.literal('arrow'),
  x1: gx,
  y1: gy,
  x2: gx,
  y2: gy,
  /** Short label beside the shaft; empty for none. */
  text: label,
  ink: SketchInk,
});
export const SketchLine = z.object({
  kind: z.literal('line'),
  x1: gx,
  y1: gy,
  x2: gx,
  y2: gy,
  curve: SketchCurve,
  dashed: z.boolean(),
  ink: SketchInk,
});
export const SketchBars = z.object({
  kind: z.literal('bars'),
  x: gx,
  y: gy,
  w: span,
  h: span,
  /** Bar heights as fractions of `h`, left to right. */
  values: z.array(z.number().min(0).max(1)).min(1).max(SKETCH_MAX_BARS),
  ink: SketchInk,
});
/** One pen line through several points: an ECG trace, a supply curve, a sine wave. */
export const SketchTrace = z.object({
  kind: z.literal('trace'),
  points: z
    .array(z.object({ x: gx, y: gy }))
    .min(2)
    .max(SKETCH_MAX_TRACE_POINTS),
  /** Rounded through the points (waves) or straight between them (spikes). */
  smooth: z.boolean(),
  ink: SketchInk,
});
export const SketchUnderline = z.object({
  kind: z.literal('underline'),
  x: gx,
  y: gy,
  w: span,
  ink: SketchInk,
});
export const SketchHighlight = z.object({
  kind: z.literal('highlight'),
  x: gx,
  y: gy,
  w: span,
  h: span,
});

export const SketchElement = z.discriminatedUnion('kind', [
  SketchLabel,
  SketchBox,
  SketchCircle,
  SketchArrow,
  SketchLine,
  SketchBars,
  SketchTrace,
  SketchUnderline,
  SketchHighlight,
]);
export type SketchElement = z.infer<typeof SketchElement>;
export type SketchElementKind = SketchElement['kind'];

export const SketchSpec = z.object({
  elements: z.array(SketchElement).max(SKETCH_MAX_ELEMENTS),
});
export type SketchSpec = z.infer<typeof SketchSpec>;

export const SessionMeta = z.object({
  /** Card and Open Graph copy; one or two plain sentences. */
  description: z.string().max(META_MAX_DESCRIPTION_CHARS),
  keywords: z.array(z.string().min(1).max(META_MAX_KEYWORD_CHARS)).max(META_MAX_KEYWORDS),
  category: SessionCategory,
  thumbnail: SketchSpec,
});
export type SessionMeta = z.infer<typeof SessionMeta>;

// ── the model-facing schema (strict structured output) ───────────────────
// Every field required, no bounds: providers reject `min`/`max` in strict
// mode and a cheap model gets ranges wrong anyway. `normaliseSessionMeta`
// clamps the result into the contract above instead of rejecting it.

const mNum = z.number();
const mText = z.string();

export const ModelSketchElement = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('label'),
    text: mText,
    x: mNum,
    y: mNum,
    w: mNum,
    size: SketchLabelSize,
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('box'),
    x: mNum,
    y: mNum,
    w: mNum,
    h: mNum,
    text: mText,
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('circle'),
    x: mNum,
    y: mNum,
    w: mNum,
    h: mNum,
    text: mText,
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('arrow'),
    x1: mNum,
    y1: mNum,
    x2: mNum,
    y2: mNum,
    text: mText,
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('line'),
    x1: mNum,
    y1: mNum,
    x2: mNum,
    y2: mNum,
    curve: SketchCurve,
    dashed: z.boolean(),
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('bars'),
    x: mNum,
    y: mNum,
    w: mNum,
    h: mNum,
    values: z.array(mNum),
    ink: SketchInk,
  }),
  z.object({
    kind: z.literal('trace'),
    points: z.array(z.object({ x: mNum, y: mNum })),
    smooth: z.boolean(),
    ink: SketchInk,
  }),
  z.object({ kind: z.literal('underline'), x: mNum, y: mNum, w: mNum, ink: SketchInk }),
  z.object({ kind: z.literal('highlight'), x: mNum, y: mNum, w: mNum, h: mNum }),
]);
export type ModelSketchElement = z.infer<typeof ModelSketchElement>;

export const ModelSessionMeta = z.object({
  description: mText,
  keywords: z.array(mText),
  category: SessionCategory,
  thumbnail: z.object({ elements: z.array(ModelSketchElement) }),
});
export type ModelSessionMeta = z.infer<typeof ModelSessionMeta>;

// ── normalisation ─────────────────────────────────────────────────────────

const { columns: COLS, rows: ROWS } = SKETCH_GRID;

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}
/** Quarter-grid precision keeps positions expressive while staying deterministic. */
function snap(n: number): number {
  return Math.round(finite(n) * 4) / 4;
}
function cx(n: number): number {
  return clamp(snap(n), 0, COLS);
}
function cy(n: number): number {
  return clamp(snap(n), 0, ROWS);
}
/** A span that starts at `at` and stays inside `max`, at least half a cell. */
function spanWithin(size: number, at: number, max: number): number {
  const room = max - at;
  if (room < 0.5) return 0.5;
  return clamp(snap(size), 0.5, room);
}
/** Whitespace-normalised and cut at `max`; an over-long text loses whole words, never half of one. */
function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut.slice(0, max)).trim();
}

/**
 * Clamp one model element into the bounded contract, or null when nothing
 * sensible remains (zero-length arrow, empty label, no bars). A box that
 * runs off the grid is shortened, a coordinate past the edge is pulled back:
 * a slightly moved sketch beats no sketch at all.
 */
export function normaliseSketchElement(el: ModelSketchElement): SketchElement | null {
  switch (el.kind) {
    case 'label': {
      const text = trim(el.text, SKETCH_MAX_LABEL_CHARS);
      if (!text) return null;
      const x = clamp(cx(el.x), 0, COLS - 1);
      const y = clamp(cy(el.y), 0, ROWS - 0.5);
      return {
        kind: 'label',
        text,
        x,
        y,
        w: spanWithin(el.w, x, COLS),
        size: el.size,
        ink: el.ink,
      };
    }
    case 'box':
    case 'circle': {
      const x = clamp(cx(el.x), 0, COLS - 0.5);
      const y = clamp(cy(el.y), 0, ROWS - 0.5);
      return {
        kind: el.kind,
        x,
        y,
        w: spanWithin(el.w, x, COLS),
        h: spanWithin(el.h, y, ROWS),
        text: trim(el.text, SKETCH_MAX_LABEL_CHARS),
        ink: el.ink,
      };
    }
    case 'arrow': {
      const x1 = cx(el.x1);
      const y1 = cy(el.y1);
      const x2 = cx(el.x2);
      const y2 = cy(el.y2);
      if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return null;
      return {
        kind: 'arrow',
        x1,
        y1,
        x2,
        y2,
        text: trim(el.text, SKETCH_MAX_LABEL_CHARS),
        ink: el.ink,
      };
    }
    case 'line': {
      const x1 = cx(el.x1);
      const y1 = cy(el.y1);
      const x2 = cx(el.x2);
      const y2 = cy(el.y2);
      if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return null;
      return { kind: 'line', x1, y1, x2, y2, curve: el.curve, dashed: el.dashed, ink: el.ink };
    }
    case 'bars': {
      const raw = el.values.filter((v) => Number.isFinite(v)).slice(0, SKETCH_MAX_BARS);
      if (raw.length === 0) return null;
      // Fractions are the contract, but a model that answers in percent or counts is scaled by its tallest bar.
      const top = Math.max(...raw);
      const values = raw.map((v) => clamp(top > 1 ? v / top : v, 0, 1));
      const x = clamp(cx(el.x), 0, COLS - 1);
      const y = clamp(cy(el.y), 0, ROWS - 1);
      return {
        kind: 'bars',
        x,
        y,
        w: spanWithin(Math.max(1, el.w), x, COLS),
        h: spanWithin(Math.max(1, el.h), y, ROWS),
        values,
        ink: el.ink,
      };
    }
    case 'trace': {
      // Consecutive duplicates (after snapping) collapse; fewer than two distinct points is no line.
      const points: Array<{ x: number; y: number }> = [];
      for (const p of el.points.slice(0, SKETCH_MAX_TRACE_POINTS)) {
        const q = { x: cx(p.x), y: cy(p.y) };
        const last = points[points.length - 1];
        if (!last || last.x !== q.x || last.y !== q.y) points.push(q);
      }
      if (points.length < 2) return null;
      return { kind: 'trace', points, smooth: el.smooth, ink: el.ink };
    }
    case 'underline': {
      const x = clamp(cx(el.x), 0, COLS - 0.5);
      return { kind: 'underline', x, y: cy(el.y), w: spanWithin(el.w, x, COLS), ink: el.ink };
    }
    case 'highlight': {
      const x = clamp(cx(el.x), 0, COLS - 0.5);
      const y = clamp(cy(el.y), 0, ROWS - 0.5);
      return {
        kind: 'highlight',
        x,
        y,
        w: spanWithin(el.w, x, COLS),
        h: spanWithin(el.h, y, ROWS),
      };
    }
  }
}

/**
 * Model output → contract. Never throws on shape the model may plausibly
 * produce: too many elements are cut (highlights first, then from the end),
 * copy is trimmed, keywords deduplicated. The result always satisfies
 * `SessionMeta`; the caller may still `SessionMeta.parse` it as a guard.
 */
export function normaliseSessionMeta(raw: ModelSessionMeta): SessionMeta {
  const elements = raw.thumbnail.elements.flatMap((el) => {
    const n = normaliseSketchElement(el);
    return n ? [n] : [];
  });
  let kept = elements;
  if (kept.length > SKETCH_MAX_ELEMENTS) {
    // Decoration goes before content: drop highlights, then trailing elements.
    kept = kept.filter((e) => e.kind !== 'highlight');
    kept = kept.slice(0, SKETCH_MAX_ELEMENTS);
  }
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const k of raw.keywords) {
    const t = trim(k, META_MAX_KEYWORD_CHARS);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    keywords.push(t);
    if (keywords.length === META_MAX_KEYWORDS) break;
  }
  return {
    description: trim(raw.description, META_MAX_DESCRIPTION_CHARS),
    keywords,
    category: raw.category,
    thumbnail: { elements: kept },
  };
}

/** The empty sketch: the renderer still produces valid paper for it. */
export const EMPTY_SKETCH: SketchSpec = { elements: [] };
