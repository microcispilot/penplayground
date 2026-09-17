import { describe, expect, it } from 'vitest';
import {
  handArrow,
  handEllipse,
  handRect,
  handRoundedRect,
  handUnderline,
  normaliseStrokes,
  outlineToPath,
  revealStrokes,
  strokeLength,
  strokesBounds,
  takeLength,
} from '../src/primitives.js';

describe('hand primitives', () => {
  it('are deterministic per seed', () => {
    expect(handRect(200, 80, 'a')).toEqual(handRect(200, 80, 'a'));
    expect(handRect(200, 80, 'a')).not.toEqual(handRect(200, 80, 'b'));
    expect(handEllipse(200, 80, 'a')).toEqual(handEllipse(200, 80, 'a'));
  });

  it('rect stays within a small overshoot of its box and is one stroke', () => {
    const [s] = handRect(200, 80, 'seed');
    if (!s) throw new Error('no stroke');
    const b = strokesBounds([s]);
    expect(b.x).toBeGreaterThan(-10);
    expect(b.y).toBeGreaterThan(-10);
    expect(b.w).toBeLessThan(220);
    expect(b.h).toBeLessThan(100);
    expect(strokeLength(s)).toBeGreaterThan(2 * (200 + 80));
  });

  it('ellipse overlaps its start and fits the box', () => {
    const [s] = handEllipse(200, 100, 'seed');
    if (!s) throw new Error('no stroke');
    const b = strokesBounds([s]);
    expect(b.w).toBeGreaterThan(190);
    expect(b.w).toBeLessThan(212);
    expect(b.h).toBeLessThan(112);
  });

  it('rounded rect closes the loop', () => {
    const [s] = handRoundedRect(300, 120, 14, 'seed');
    if (!s) throw new Error('no stroke');
    expect(strokeLength(s)).toBeGreaterThan(2 * (300 + 120) - 8 * 14);
  });

  it('arrow is a shaft plus a head ending at the tip', () => {
    const strokes = handArrow({ x: 0, y: 0 }, { x: 200, y: 0 }, 'seed');
    expect(strokes).toHaveLength(2);
    const head = strokes[1];
    if (!head) throw new Error('no head');
    const tip = head[Math.floor(head.length / 2)];
    expect(tip?.[0]).toBeCloseTo(200, 0);
    expect(handUnderline(120, 'u')[0]?.length).toBeGreaterThan(10);
  });

  it('takeLength / revealStrokes reveal by arc length', () => {
    const line: [number, number, number][] = [
      [0, 0, 0.5],
      [100, 0, 0.5],
      [100, 100, 0.5],
    ];
    expect(takeLength(line, 150)).toEqual([
      [0, 0, 0.5],
      [100, 0, 0.5],
      [100, 50, 0.5],
    ]);
    const parts = revealStrokes([line, line], 0.5);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.complete).toBe(true);
    const partial = revealStrokes([line, line], 0.75);
    expect(partial).toHaveLength(2);
    expect(partial[1]?.complete).toBe(false);
    expect(revealStrokes([line], 0)).toEqual([]);
  });

  it('normalises strokes to a padded origin', () => {
    const n = normaliseStrokes([[[-3, -2, 0.5], [10, 20, 0.5]]], 4);
    expect(n.offset).toEqual({ x: 7, y: 6 });
    expect(n.bounds).toEqual({ x: 0, y: 0, w: 21, h: 30 });
    expect(n.strokes[0]?.[0]).toEqual([4, 4, 0.5]);
  });

  it('outlineToPath produces a closed path', () => {
    const d = outlineToPath([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(d.startsWith('M0.00 0.00 Q')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(outlineToPath([[0, 0]])).toBe('');
  });
});
