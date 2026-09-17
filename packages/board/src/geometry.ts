/** Plain geometry used everywhere in the board; deliberately free of tldraw types. */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function bounds(x: number, y: number, w: number, h: number): Bounds {
  return { x, y, w, h };
}

export function right(b: Bounds): number {
  return b.x + b.w;
}

export function bottom(b: Bounds): number {
  return b.y + b.h;
}

export function center(b: Bounds): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function expand(b: Bounds, by: number): Bounds {
  return { x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 };
}

export function translate(b: Bounds, dx: number, dy: number): Bounds {
  return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
}

export function union(list: readonly Bounds[]): Bounds | null {
  let acc: Bounds | null = null;
  for (const b of list) {
    if (!acc) {
      acc = { ...b };
      continue;
    }
    const x = Math.min(acc.x, b.x);
    const y = Math.min(acc.y, b.y);
    const r = Math.max(right(acc), right(b));
    const bo = Math.max(bottom(acc), bottom(b));
    acc = { x, y, w: r - x, h: bo - y };
  }
  return acc;
}

/** True when `inner` lies entirely inside `outer`, with an optional tolerance in world units. */
export function contains(outer: Bounds, inner: Bounds, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    right(inner) <= right(outer) + tolerance &&
    bottom(inner) <= bottom(outer) + tolerance
  );
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
