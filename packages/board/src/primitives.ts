import { type Bounds, type Point, distance } from './geometry.js';
import { type Rng, createRng, jitter } from './rng.js';

/**
 * Hand-drawn stroke primitives. Each returns one or more strokes: arrays of
 * [x, y, pressure] points in local coordinates, ready for perfect-freehand.
 * Everything is seeded so every client draws the same wobble.
 *
 * The look: slight low-frequency wobble along every line, corners that
 * overshoot a few units the way a marker does, ellipses that overlap their
 * start, arrowheads as an open "V".
 */

export type StrokePoint = [number, number, number];
export type Stroke = StrokePoint[];

const STEP = 5;

interface Wobble {
  amp: number;
  f1: number;
  f2: number;
  p1: number;
  p2: number;
}

function makeWobble(rng: Rng, amp: number): Wobble {
  return {
    amp,
    f1: 0.6 + rng() * 0.6,
    f2: 1.6 + rng() * 1.2,
    p1: rng() * Math.PI * 2,
    p2: rng() * Math.PI * 2,
  };
}

function wobbleAt(w: Wobble, t: number, rng: Rng): number {
  return (
    w.amp * (0.65 * Math.sin(Math.PI * 2 * w.f1 * t + w.p1) + 0.35 * Math.sin(Math.PI * 2 * w.f2 * t + w.p2)) +
    jitter(rng, w.amp * 0.15)
  );
}

/** Sample a straight segment with wobble perpendicular to it. */
function segment(a: Point, b: Point, rng: Rng, amp: number, bow = 0): Stroke {
  const len = distance(a, b);
  const n = Math.max(2, Math.ceil(len / STEP));
  const w = makeWobble(rng, amp);
  const nx = -(b.y - a.y) / (len || 1);
  const ny = (b.x - a.x) / (len || 1);
  const pts: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = wobbleAt(w, t, rng) + bow * Math.sin(Math.PI * t);
    pts.push([a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off, 0.5]);
  }
  return pts;
}

/**
 * A rectangle in one continuous stroke: starts a little way along the top
 * edge, overshoots each corner slightly, and overlaps the start at the end.
 */
export function handRect(w: number, h: number, seed: string, amp = 1.2): Stroke[] {
  const rng = createRng(`rect:${seed}`);
  const over = () => 2 + rng() * 4;
  const startX = 6 + rng() * 6;
  const pts: Stroke = [];
  const push = (s: Stroke) => {
    for (const p of s) pts.push(p);
  };
  // top (from startX), right, bottom, left, then back onto the top a little.
  push(segment({ x: startX, y: 0 }, { x: w + over(), y: jitter(rng, 0.8) }, rng, amp));
  push(segment({ x: w + jitter(rng, 0.8), y: -over() * 0.4 }, { x: w, y: h + over() }, rng, amp));
  push(segment({ x: w + over() * 0.5, y: h + jitter(rng, 0.8) }, { x: -over(), y: h }, rng, amp));
  push(segment({ x: jitter(rng, 0.8), y: h + over() * 0.4 }, { x: 0, y: -over() * 0.5 }, rng, amp));
  push(segment({ x: -over() * 0.3, y: jitter(rng, 0.8) }, { x: startX + 10, y: 0 }, rng, amp * 0.6));
  return [pts];
}

/** A rounded rectangle (code frames), corners sampled as quarter arcs. */
export function handRoundedRect(w: number, h: number, r: number, seed: string, amp = 1): Stroke[] {
  const rng = createRng(`rrect:${seed}`);
  const rad = Math.max(2, Math.min(r, w / 2, h / 2));
  const pts: Stroke = [];
  const wob = makeWobble(rng, amp);
  const perimeter = 2 * (w + h) - 8 * rad + 2 * Math.PI * rad;
  const n = Math.max(24, Math.ceil(perimeter / STEP));
  const start = 0.04 + rng() * 0.03; // start a little way along the top edge
  for (let i = 0; i <= n + Math.ceil(n * 0.03); i++) {
    const t = start + i / n;
    const p = pointOnRoundedRect(w, h, rad, t % 1);
    const off = wobbleAt(wob, t, rng);
    pts.push([p.x + p.nx * off, p.y + p.ny * off, 0.5]);
  }
  return [pts];
}

function pointOnRoundedRect(
  w: number,
  h: number,
  r: number,
  t: number,
): { x: number; y: number; nx: number; ny: number } {
  const straightW = w - 2 * r;
  const straightH = h - 2 * r;
  const arc = (Math.PI / 2) * r;
  const total = 2 * straightW + 2 * straightH + 4 * arc;
  let d = t * total;
  // top edge
  if (d < straightW) return { x: r + d, y: 0, nx: 0, ny: -1 };
  d -= straightW;
  if (d < arc) {
    const a = -Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return { x: w - r + Math.cos(a) * r, y: r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
  }
  d -= arc;
  if (d < straightH) return { x: w, y: r + d, nx: 1, ny: 0 };
  d -= straightH;
  if (d < arc) {
    const a = (d / arc) * (Math.PI / 2);
    return { x: w - r + Math.cos(a) * r, y: h - r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
  }
  d -= arc;
  if (d < straightW) return { x: w - r - d, y: h, nx: 0, ny: 1 };
  d -= straightW;
  if (d < arc) {
    const a = Math.PI / 2 + (d / arc) * (Math.PI / 2);
    return { x: r + Math.cos(a) * r, y: h - r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
  }
  d -= arc;
  if (d < straightH) return { x: 0, y: h - r - d, nx: -1, ny: 0 };
  d -= straightH;
  const a = Math.PI + (Math.min(d, arc) / arc) * (Math.PI / 2);
  return { x: r + Math.cos(a) * r, y: r + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) };
}

/** A wobbly ellipse that starts near the top-left and overlaps itself at the end. */
export function handEllipse(w: number, h: number, seed: string, amp = 1.4): Stroke[] {
  const rng = createRng(`ellipse:${seed}`);
  const rx = w / 2;
  const ry = h / 2;
  const start = -Math.PI * 0.72 + jitter(rng, 0.25);
  const sweep = Math.PI * 2 + Math.PI * 0.16 + rng() * Math.PI * 0.08; // overlap the start
  const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.max(24, Math.ceil(circumference / STEP));
  const wob = makeWobble(rng, amp);
  const tilt = jitter(rng, 0.05);
  const pts: Stroke = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + sweep * t;
    const rWob = 1 + wobbleAt(wob, t, rng) / Math.max(rx, ry);
    const ex = Math.cos(a) * rx * rWob;
    const ey = Math.sin(a) * ry * rWob;
    pts.push([
      rx + ex * Math.cos(tilt) - ey * Math.sin(tilt),
      ry + ex * Math.sin(tilt) + ey * Math.cos(tilt),
      0.5,
    ]);
  }
  return [pts];
}

/** A slightly bowed line. */
export function handLine(a: Point, b: Point, seed: string, amp = 1.2): Stroke[] {
  const rng = createRng(`line:${seed}`);
  const len = distance(a, b);
  const bow = jitter(rng, Math.min(6, len * 0.025));
  return [segment(a, b, rng, amp, bow)];
}

/** Shaft plus an open "V" head, drawn as two strokes. */
export function handArrow(a: Point, b: Point, seed: string, amp = 1.2): Stroke[] {
  const rng = createRng(`arrow:${seed}`);
  const len = distance(a, b);
  const bow = jitter(rng, Math.min(8, len * 0.03));
  const shaft = segment(a, b, rng, amp, bow);
  const headLen = Math.min(22, Math.max(10, len * 0.22));
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = 0.48 + jitter(rng, 0.06);
  const left: Point = {
    x: b.x - Math.cos(angle - spread) * headLen,
    y: b.y - Math.sin(angle - spread) * headLen,
  };
  const rightP: Point = {
    x: b.x - Math.cos(angle + spread) * headLen,
    y: b.y - Math.sin(angle + spread) * headLen,
  };
  const head = [...segment(left, b, rng, amp * 0.5), ...segment(b, rightP, rng, amp * 0.5).slice(1)];
  return [shaft, head];
}

/** A gently waving underline, slightly rising or falling. */
export function handUnderline(w: number, seed: string, amp = 1.5): Stroke[] {
  const rng = createRng(`underline:${seed}`);
  const drift = jitter(rng, 2.5);
  return [segment({ x: 0, y: 0 }, { x: w, y: drift }, rng, amp, jitter(rng, 2))];
}

// ── measurement & partial reveal ──────────────────────────────────────────

export function strokeLength(points: readonly StrokePoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

export function strokesLength(strokes: readonly Stroke[]): number {
  return strokes.reduce((acc, s) => acc + strokeLength(s), 0);
}

/** Points along a stroke up to `length` (interpolating the last point). */
export function takeLength(points: readonly StrokePoint[], length: number): StrokePoint[] {
  if (points.length === 0 || length <= 0) return [];
  const out: StrokePoint[] = [];
  const first = points[0];
  if (first) out.push([first[0], first[1], first[2]]);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + seg >= length) {
      const t = seg === 0 ? 1 : (length - acc) / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[2]]);
      return out;
    }
    acc += seg;
    out.push([b[0], b[1], b[2]]);
  }
  return out;
}

/**
 * Reveal a list of strokes up to a fraction of their total length. Returns
 * the visible strokes and whether each is complete (perfect-freehand's `last`).
 */
export function revealStrokes(
  strokes: readonly Stroke[],
  progress: number,
): Array<{ points: StrokePoint[]; complete: boolean }> {
  const total = strokesLength(strokes);
  let budget = Math.max(0, Math.min(1, progress)) * total;
  const out: Array<{ points: StrokePoint[]; complete: boolean }> = [];
  for (const s of strokes) {
    const len = strokeLength(s);
    if (budget <= 0) break;
    if (budget >= len - 1e-6) {
      out.push({ points: s.map((p) => [p[0], p[1], p[2]]), complete: true });
      budget -= len;
      continue;
    }
    out.push({ points: takeLength(s, budget), complete: false });
    budget = 0;
  }
  return out;
}

export function strokesBounds(strokes: readonly Stroke[], pad = 0): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of strokes) {
    for (const p of s) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Shift strokes so their bounds start at (pad, pad); returns the offset applied. */
export function normaliseStrokes(strokes: readonly Stroke[], pad: number): { strokes: Stroke[]; offset: Point; bounds: Bounds } {
  const b = strokesBounds(strokes, pad);
  const offset = { x: -b.x, y: -b.y };
  const moved = strokes.map((s) => s.map((p): StrokePoint => [p[0] + offset.x, p[1] + offset.y, p[2]]));
  return { strokes: moved, offset, bounds: { x: 0, y: 0, w: b.w, h: b.h } };
}

/** perfect-freehand outline → SVG path (quadratic midpoint smoothing). */
export function outlineToPath(outline: readonly number[][]): string {
  if (outline.length < 2) return '';
  const first = outline[0];
  if (!first) return '';
  let d = `M${(first[0] ?? 0).toFixed(2)} ${(first[1] ?? 0).toFixed(2)} Q`;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    d += `${(a[0] ?? 0).toFixed(2)} ${(a[1] ?? 0).toFixed(2)} ${(((a[0] ?? 0) + (b[0] ?? 0)) / 2).toFixed(2)} ${(((a[1] ?? 0) + (b[1] ?? 0)) / 2).toFixed(2)} `;
  }
  return `${d}Z`;
}
