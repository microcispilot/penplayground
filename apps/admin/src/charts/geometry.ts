/**
 * The arithmetic behind every chart in the console.
 *
 * There is no chart library here and there should not be one: the console
 * draws a sparkline, a run of columns, a bar in a table row, a heat grid and
 * a stacked lane, and all five are a hundred lines of coordinates. A
 * dependency would be heavier than the whole admin bundle and would bring its
 * own colours, its own type scale and its own idea of a tooltip — three
 * things this design system has already decided.
 *
 * Everything here is pure, takes a viewport in abstract units, and is tested
 * directly. The components in this folder do nothing but turn these numbers
 * into elements, so a chart that draws wrongly is a failing test here rather
 * than a screenshot somebody has to notice.
 *
 * Coordinates are SVG's: y grows downward, the baseline is `height`.
 */

/** Two decimals is a tenth of a pixel at any size this console draws at. */
const r = (v: number): number => Math.round(v * 100) / 100;

export interface Extent {
  min: number;
  max: number;
}

/**
 * The vertical extent a series is drawn against.
 *
 * Series here are counts and dollars, so the floor is zero unless the data
 * goes below it: a spend chart whose y-axis starts at the cheapest day
 * exaggerates every difference on it, which is the oldest way to lie with a
 * chart. An all-zero series gets a max of 1 so it draws a flat line on the
 * floor rather than dividing by zero.
 */
export function extentOf(values: readonly number[]): Extent {
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) max = min + 1;
  return { min, max };
}

export interface LineShape {
  /** The `d` of the line itself. Empty when there is nothing to draw. */
  line: string;
  /** The same line closed down to the baseline, for the wash underneath. */
  area: string;
  /** Where each sample landed, so a hover target can be put on it. */
  points: Array<{ x: number; y: number; value: number; index: number }>;
}

/**
 * A sparkline over `values`, spread evenly across `width`.
 *
 * A single sample is drawn as a flat line across the full width rather than
 * as a dot at x=0: one day of data is a fact about a day, and a dot in the
 * corner reads as a broken chart.
 */
export function linePath(
  values: readonly number[],
  width: number,
  height: number,
  extent: Extent = extentOf(values),
): LineShape {
  if (values.length === 0 || width <= 0 || height <= 0) return { line: '', area: '', points: [] };
  const span = extent.max - extent.min || 1;
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const points = values.map((value, index) => ({
    index,
    value,
    x: r(values.length === 1 ? width / 2 : index * step),
    y: r(height - (((Number.isFinite(value) ? value : 0) - extent.min) / span) * height),
  }));
  if (values.length === 1) {
    const only = points[0];
    if (!only) return { line: '', area: '', points: [] };
    const line = `M 0 ${only.y} L ${r(width)} ${only.y}`;
    return {
      line,
      area: `${line} L ${r(width)} ${r(height)} L 0 ${r(height)} Z`,
      points,
    };
  }
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const last = points[points.length - 1];
  const area = `${line} L ${r(last?.x ?? width)} ${r(height)} L ${r(points[0]?.x ?? 0)} ${r(height)} Z`;
  return { line, area, points };
}

export interface Column {
  index: number;
  x: number;
  width: number;
  /** Stacked bottom-up: `parts[0]` sits on the baseline. */
  parts: Array<{ y: number; height: number; value: number; series: number }>;
  total: number;
}

/**
 * A run of columns, optionally stacked.
 *
 * `gapRatio` is the share of each slot left empty, so the bars keep their
 * rhythm whatever the count: 90 daily columns end up hairlines with a
 * hairline gap, and seven end up broad, without the caller choosing.
 * A column whose total is zero has no parts at all — nothing is drawn, and
 * the empty slot is the honest picture of a day with no sessions.
 */
export function columnLayout(
  rows: readonly (readonly number[])[],
  width: number,
  height: number,
  options: { gapRatio?: number; max?: number } = {},
): { columns: Column[]; max: number; slot: number } {
  const gapRatio = options.gapRatio ?? 0.25;
  const totals = rows.map((parts) => parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0));
  const max = options.max ?? Math.max(1, ...totals);
  if (rows.length === 0 || width <= 0 || height <= 0) return { columns: [], max, slot: 0 };
  const slot = width / rows.length;
  const barWidth = Math.max(1, slot * (1 - gapRatio));
  const columns = rows.map((parts, index) => {
    let cursor = height;
    const laid: Column['parts'] = [];
    parts.forEach((value, series) => {
      const v = Number.isFinite(value) && value > 0 ? value : 0;
      if (v === 0) return;
      const h = (v / max) * height;
      cursor -= h;
      laid.push({ y: r(cursor), height: r(h), value: v, series });
    });
    return {
      index,
      x: r(index * slot + (slot - barWidth) / 2),
      width: r(barWidth),
      parts: laid,
      total: totals[index] ?? 0,
    };
  });
  return { columns, max, slot };
}

/**
 * How dark a heat cell is, 0–1.
 *
 * Square-rooted rather than linear, because the distributions this draws —
 * cohort retention, hour-of-day usage — are heavily skewed, and a linear ramp
 * paints everything but the peak as an empty grid. Any non-zero value floors
 * at `FAINTEST` so "one visit at 4am" is visible as one visit rather than as
 * nothing at all; exactly zero returns exactly zero, and the grid is allowed
 * to look empty where it is.
 */
export const FAINTEST = 0.12;

export function heatIntensity(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (max <= 0) return 0;
  const linear = Math.min(1, value / max);
  return r(FAINTEST + (1 - FAINTEST) * Math.sqrt(linear));
}

export interface LaneSegment {
  key: string;
  value: number;
  /** Percentage of the lane, as a CSS width. Sums to exactly 100. */
  percent: number;
}

/**
 * A single 100 % lane split between named parts.
 *
 * The last segment absorbs the rounding so the lane always closes: a stacked
 * bar with a one-pixel gap at the end looks like a rendering bug, and here it
 * would be one. Parts of zero are dropped rather than drawn as invisible
 * slivers that still take a legend row.
 */
export function laneSegments(parts: readonly { key: string; value: number }[]): LaneSegment[] {
  const usable = parts.filter((p) => Number.isFinite(p.value) && p.value > 0);
  const total = usable.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return [];
  const out = usable.map((p) => ({
    key: p.key,
    value: p.value,
    percent: r((p.value / total) * 100),
  }));
  const drift = 100 - out.reduce((a, p) => a + p.percent, 0);
  const last = out[out.length - 1];
  if (last) last.percent = r(last.percent + drift);
  return out;
}

/**
 * A round number at or above `value`, for an axis top.
 *
 * The ladder is fine enough that the tallest column fills most of the chart:
 * a coarse 1/2/5/10 ladder turns a peak of 55 into an axis of 100 and draws
 * every bar at half height, which reads as a quiet month rather than as a
 * rounded axis. Zero stays zero — an axis labelled "1" over an empty chart
 * invents a scale nothing was measured against.
 */
const LADDER = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = LADDER.find((s) => normalised <= s + 1e-9) ?? 10;
  return r(step * magnitude);
}

/**
 * How much of each slot to leave empty, given how many columns there are.
 *
 * A fixed gap makes eight columns read as eight doors and ninety as a comb.
 * Few columns get a wide gap so a bar stays a bar rather than becoming a
 * panel; many get a narrow one so the run keeps its rhythm.
 */
export function gapFor(count: number): number {
  if (count <= 8) return 0.65;
  if (count <= 16) return 0.45;
  if (count <= 40) return 0.3;
  return 0.2;
}

/**
 * How opaque the `i`th part of an ordered ramp is.
 *
 * One token at n weights, rather than a palette of n hues. The first part is
 * nearly solid and the last is still clearly visible — a ramp that fades to
 * nothing loses its smallest segment, which is usually the interesting one.
 */
export function rampOpacity(index: number, count: number): number {
  if (count <= 1) return 0.9;
  const step = (0.9 - 0.22) / (count - 1);
  return r(0.9 - Math.min(index, count - 1) * step);
}

/**
 * Which of `count` labels to print under a run of columns, so they never
 * collide. Always the first and the last; the rest are thinned to at most
 * `slots`, which is how many the available width can hold.
 */
export function labelStride(count: number, slots: number): number[] {
  if (count <= 0) return [];
  if (count <= slots) return Array.from({ length: count }, (_, i) => i);
  const stride = Math.ceil(count / Math.max(1, slots - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i += stride) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    // Replace rather than append when the penultimate tick is too close to
    // the end to fit a label beside it.
    if (last - (out[out.length - 1] ?? 0) < stride / 2) out.pop();
    out.push(last);
  }
  return out;
}
