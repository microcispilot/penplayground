import { describe, expect, it } from 'vitest';
import {
  columnLayout,
  extentOf,
  FAINTEST,
  gapFor,
  heatIntensity,
  labelStride,
  laneSegments,
  linePath,
  niceMax,
  rampOpacity,
} from '../src/charts/geometry.js';

/**
 * The charts, as arithmetic.
 *
 * No chart library here means no chart library's tests either, so these are
 * the ones that stand between the console and a graph that lies: an axis
 * that does not start at zero, a stack with a gap in it, a heat grid where
 * "one visit" and "no visits" look the same.
 */

describe('the vertical extent', () => {
  it('starts at zero, so a bar chart cannot exaggerate a difference', () => {
    expect(extentOf([10, 12, 11])).toEqual({ min: 0, max: 12 });
  });

  it('goes below zero only when the data does', () => {
    expect(extentOf([-4, 10])).toEqual({ min: -4, max: 10 });
  });

  it('never divides by zero on a flat or empty series', () => {
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
    expect(extentOf([0, 0, 0])).toEqual({ min: 0, max: 1 });
  });
});

describe('a sparkline', () => {
  it('draws nothing when there is nothing', () => {
    expect(linePath([], 100, 40)).toEqual({ line: '', area: '', points: [] });
  });

  it('spreads samples evenly and puts the largest at the top', () => {
    const shape = linePath([0, 5, 10], 100, 40);
    expect(shape.points.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(shape.points.map((p) => p.y)).toEqual([40, 20, 0]);
  });

  it('closes the area down to the baseline', () => {
    const shape = linePath([1, 2], 100, 40);
    expect(shape.area.endsWith('L 0 40 Z')).toBe(true);
  });

  it('draws one sample as a flat line across the width, not a dot in the corner', () => {
    const shape = linePath([7], 100, 40);
    expect(shape.line).toBe('M 0 0 L 100 0');
    expect(shape.points[0]?.x).toBe(50);
  });

  it('treats a hole in the data as zero rather than as NaN in the path', () => {
    const shape = linePath([1, Number.NaN, 3], 100, 40);
    expect(shape.line).not.toContain('NaN');
  });
});

describe('columns', () => {
  it('lays a single series against the tallest column', () => {
    const { columns, max } = columnLayout([[1], [2], [4]], 120, 100, { gapRatio: 0 });
    expect(max).toBe(4);
    expect(columns[2]?.parts[0]).toEqual({ y: 0, height: 100, value: 4, series: 0 });
    expect(columns[0]?.parts[0]?.height).toBe(25);
    expect(columns.map((c) => c.width)).toEqual([40, 40, 40]);
  });

  it('stacks bottom-up, with the first series on the floor', () => {
    const { columns } = columnLayout([[3, 1]], 10, 100, { gapRatio: 0 });
    const parts = columns[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ series: 0, y: 25, height: 75 });
    expect(parts[1]).toMatchObject({ series: 1, y: 0, height: 25 });
    // No gap between them: the second starts exactly where the first ends.
    expect((parts[1]?.y ?? 0) + (parts[1]?.height ?? 0)).toBe(parts[0]?.y);
  });

  it('draws nothing at all for a bucket with nothing in it', () => {
    const { columns } = columnLayout([[0], [5]], 100, 100);
    expect(columns[0]?.parts).toEqual([]);
    expect(columns[0]?.total).toBe(0);
  });

  it('keeps the rhythm as the count grows', () => {
    const few = columnLayout(
      Array.from({ length: 7 }, () => [1]),
      100,
      50,
    );
    const many = columnLayout(
      Array.from({ length: 90 }, () => [1]),
      100,
      50,
    );
    expect(few.columns[0]?.width).toBeGreaterThan(many.columns[0]?.width ?? 0);
    expect(many.columns[0]?.width).toBeGreaterThanOrEqual(1);
  });

  it('honours a forced maximum, so two charts can share a scale', () => {
    const { columns } = columnLayout([[5]], 10, 100, { gapRatio: 0, max: 10 });
    expect(columns[0]?.parts[0]?.height).toBe(50);
  });
});

describe('the gap between columns', () => {
  it('widens as the columns thin out, so eight bars are not eight panels', () => {
    expect(gapFor(8)).toBeGreaterThan(gapFor(30));
    expect(gapFor(30)).toBeGreaterThan(gapFor(90));
  });

  it('always leaves a bar to draw', () => {
    for (const n of [1, 7, 12, 24, 30, 52, 90, 365]) {
      expect(gapFor(n)).toBeGreaterThan(0);
      expect(gapFor(n)).toBeLessThan(1);
    }
  });
});

describe('heat intensity', () => {
  it('is exactly zero for zero, so an empty grid looks empty', () => {
    expect(heatIntensity(0, 100)).toBe(0);
    expect(heatIntensity(-1, 100)).toBe(0);
  });

  it('floors anything non-zero, so one visit at 4am is visible', () => {
    expect(heatIntensity(1, 10_000)).toBeGreaterThanOrEqual(FAINTEST);
  });

  it('saturates at the maximum', () => {
    expect(heatIntensity(100, 100)).toBe(1);
  });

  it('is square-rooted, so a skewed distribution is not one bright cell', () => {
    // A quarter of the peak reads as half the darkness, not a quarter.
    expect(heatIntensity(25, 100)).toBeGreaterThan(0.5);
    expect(heatIntensity(25, 100)).toBeLessThan(heatIntensity(100, 100));
  });

  it('is zero rather than NaN when nothing has been measured', () => {
    expect(heatIntensity(3, 0)).toBe(0);
  });
});

describe('a stacked lane', () => {
  it('always closes to exactly 100 percent', () => {
    for (const parts of [
      [
        { key: 'a', value: 1 },
        { key: 'b', value: 1 },
        { key: 'c', value: 1 },
      ],
      [
        { key: 'a', value: 7 },
        { key: 'b', value: 11 },
        { key: 'c', value: 13 },
      ],
      [{ key: 'only', value: 5 }],
    ]) {
      const segments = laneSegments(parts);
      expect(segments.reduce((a, s) => a + s.percent, 0)).toBeCloseTo(100, 6);
    }
  });

  it('drops empty parts rather than drawing invisible slivers', () => {
    const segments = laneSegments([
      { key: 'a', value: 3 },
      { key: 'b', value: 0 },
    ]);
    expect(segments.map((s) => s.key)).toEqual(['a']);
  });

  it('is nothing at all when nothing has a value', () => {
    expect(laneSegments([{ key: 'a', value: 0 }])).toEqual([]);
    expect(laneSegments([])).toEqual([]);
  });
});

describe('a round axis top', () => {
  it('rounds up to a round number', () => {
    expect(niceMax(0.7)).toBe(0.8);
    expect(niceMax(1.4)).toBe(1.5);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(1234)).toBe(1500);
  });

  it('is close enough to the peak that the tallest column fills the chart', () => {
    // A coarse ladder draws a peak of 55 against an axis of 100 — half
    // height — and makes a busy month look like a quiet one.
    for (const peak of [3, 17, 55, 88, 412, 1284, 9001]) {
      const top = niceMax(peak);
      expect(top).toBeGreaterThanOrEqual(peak);
      expect(peak / top, `${peak} against an axis of ${top}`).toBeGreaterThan(0.6);
    }
  });

  it('leaves an empty chart unlabelled rather than inventing a scale', () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(-5)).toBe(0);
  });
});

describe('the ordered ramp', () => {
  it('runs from nearly solid to still visible', () => {
    const weights = Array.from({ length: 5 }, (_, i) => rampOpacity(i, 5));
    expect(weights[0]).toBe(0.9);
    expect(weights[4]).toBe(0.22);
    for (let i = 1; i < weights.length; i += 1)
      expect(weights[i]).toBeLessThan(weights[i - 1] as number);
  });

  it('never fades a part to nothing, however many there are', () => {
    for (const n of [1, 2, 3, 6, 12])
      for (let i = 0; i < n; i += 1) expect(rampOpacity(i, n)).toBeGreaterThanOrEqual(0.22);
  });

  it('gives a lone part the full weight', () => {
    expect(rampOpacity(0, 1)).toBe(0.9);
  });
});

describe('axis labels', () => {
  it('prints them all when they fit', () => {
    expect(labelStride(5, 7)).toEqual([0, 1, 2, 3, 4]);
  });

  it('always keeps the first and the last', () => {
    for (const n of [8, 30, 90, 365]) {
      const ticks = labelStride(n, 7);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(n - 1);
      expect(ticks.length).toBeLessThanOrEqual(8);
    }
  });

  it('never repeats one', () => {
    const ticks = labelStride(30, 7);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('has nothing to print for an empty chart', () => {
    expect(labelStride(0, 7)).toEqual([]);
  });
});
