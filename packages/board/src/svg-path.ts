import type { PathCommand } from 'opentype.js';

/**
 * SVG path-data building and the last line of defence before a `d` attribute.
 *
 * Why this exists: opentype.js 2.0.0's `Path.toPathData()` formats numbers
 * through a `roundDecimal` cache keyed by the fractional part, and for values
 * such as `18.000000000000004` it returns `"NaN"` even though the underlying
 * command is finite. Chromium then logs `<path> attribute d: Expected number`
 * for every affected glyph. We therefore serialise `path.commands` ourselves
 * and never let a non-finite coordinate reach the DOM.
 */

export interface PathBuild {
  d: string;
  /** Commands dropped because a coordinate was not finite. */
  dropped: number;
}

/** Fixed two decimals, trailing zeros trimmed: `18.000000000000004` → `18`, `-10.638` → `-10.64`. */
export function formatCoord(n: number): string {
  const s = n.toFixed(2);
  if (s.indexOf('.') === -1) return s;
  const trimmed = s.replace(/\.?0+$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function finite(...values: number[]): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

/**
 * Serialise opentype commands (already positioned by `glyph.getPath`) to
 * path data. A command with a non-finite coordinate is dropped and counted;
 * a dropped M or L simply shortens the contour, which is far better than a
 * broken attribute that blanks the whole glyph.
 */
export function commandsToPathData(commands: readonly PathCommand[]): PathBuild {
  let d = '';
  let dropped = 0;
  for (const c of commands) {
    switch (c.type) {
      case 'M':
      case 'L':
        if (!finite(c.x, c.y)) {
          dropped += 1;
          break;
        }
        d += `${c.type}${formatCoord(c.x)} ${formatCoord(c.y)}`;
        break;
      case 'Q':
        if (!finite(c.x1, c.y1, c.x, c.y)) {
          dropped += 1;
          break;
        }
        d += `Q${formatCoord(c.x1)} ${formatCoord(c.y1)} ${formatCoord(c.x)} ${formatCoord(c.y)}`;
        break;
      case 'C':
        if (!finite(c.x1, c.y1, c.x2, c.y2, c.x, c.y)) {
          dropped += 1;
          break;
        }
        d += `C${formatCoord(c.x1)} ${formatCoord(c.y1)} ${formatCoord(c.x2)} ${formatCoord(c.y2)} ${formatCoord(c.x)} ${formatCoord(c.y)}`;
        break;
      case 'Z':
        d += 'Z';
        break;
    }
  }
  return { d, dropped };
}

const NON_FINITE = /NaN|Infinity/;
const SEGMENT = /[MLQCZmlqcz][^MLQCZmlqcz]*/g;

/** Cheap test used by the render path. */
export function hasNonFinite(d: string): boolean {
  return NON_FINITE.test(d);
}

/**
 * Remove every path segment that carries a non-finite number. Segments are
 * `<letter><numbers…>` runs, so dropping one keeps the rest well-formed. The
 * returned `dropped` lets callers report the incident.
 */
export function sanitisePathData(d: string): PathBuild {
  if (!hasNonFinite(d)) return { d, dropped: 0 };
  let dropped = 0;
  const kept: string[] = [];
  for (const seg of d.match(SEGMENT) ?? []) {
    if (NON_FINITE.test(seg)) dropped += 1;
    else kept.push(seg);
  }
  // A contour cannot start with anything but M; drop leading non-M segments.
  while (kept.length && !/^[Mm]/.test(kept[0] ?? '')) {
    kept.shift();
    dropped += 1;
  }
  return { d: kept.join(''), dropped };
}
