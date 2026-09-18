import { describe, expect, it } from 'vitest';
import { layoutHandText } from '../src/glyphs.js';
import { hasRtlChars, isRtlText } from '../src/text-direction.js';
import { loadTestFont } from './helpers.js';

/**
 * A lesson in Persian, Arabic or Hebrew has to be readable on the board.
 * Caveat has no Arabic glyphs, and placing those letters one by one would
 * disconnect them and reverse every word, so a right-to-left line is laid out
 * as one shaped run the browser draws.
 */
const font = loadTestFont();
const PERSIAN = 'با یک جمله شروع می‌کنیم';
const HEBREW = 'נתחיל במשפט';

describe('right-to-left detection', () => {
  it('sees the script in the text, whatever the language tag says', () => {
    expect(hasRtlChars(PERSIAN)).toBe(true);
    expect(hasRtlChars(HEBREW)).toBe(true);
    expect(hasRtlChars('attention is a weighted average')).toBe(false);
    // A Persian lesson still writes its formulas the Latin way.
    expect(hasRtlChars('q·k / √d')).toBe(false);
  });

  it('falls back to the language for text with no strong character', () => {
    expect(isRtlText('1024', 'fa-IR')).toBe(true);
    expect(isRtlText('1024', 'en-US')).toBe(false);
    expect(isRtlText('1024')).toBe(false);
    // A strong character always wins.
    expect(isRtlText(PERSIAN, 'en-US')).toBe(true);
  });
});

describe('laying out a right-to-left line', () => {
  it('keeps the line whole, anchored at its right edge, and paced by its characters', () => {
    const layout = layoutHandText(font, PERSIAN, { fontSize: 36, maxWidth: 2000, seed: 's' });
    expect(layout.lines).toHaveLength(1);
    const glyphs = layout.lines[0]?.glyphs ?? [];
    expect(glyphs).toHaveLength(1);
    const run = glyphs[0];
    expect(run?.kind).toBe('run');
    expect(run?.char).toBe(PERSIAN);
    expect(run?.rtl).toBe(true);
    expect(run?.chars).toBe([...PERSIAN].length);
    // Anchored at the right edge of the line: the pen starts there and moves left.
    expect(run?.x).toBeCloseTo(layout.lines[0]?.width ?? 0, 5);
    expect(run?.advance).toBeCloseTo(layout.lines[0]?.width ?? 0, 5);
    expect(run?.d).toBe('');
  });

  it('leaves Latin text exactly as it was', () => {
    const layout = layoutHandText(font, 'attention', { fontSize: 36, maxWidth: 2000, seed: 's' });
    const glyphs = layout.lines[0]?.glyphs ?? [];
    expect(glyphs).toHaveLength('attention'.length);
    expect(glyphs.every((g) => g.kind !== 'run')).toBe(true);
  });

  it('wraps a long right-to-left paragraph into runs, one per line', () => {
    const long = `${PERSIAN} ${PERSIAN} ${PERSIAN}`;
    const layout = layoutHandText(font, long, { fontSize: 36, maxWidth: 400, seed: 's' });
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(line.glyphs).toHaveLength(1);
      expect(line.glyphs[0]?.kind).toBe('run');
    }
    // Reveal order still follows the text: each run starts after the one before it.
    const starts = layout.lines.map((l) => l.glyphs[0]?.index ?? -1);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('places every character itself when runs are off (the self-contained thumbnail SVG)', () => {
    const layout = layoutHandText(font, PERSIAN, {
      fontSize: 36,
      maxWidth: 2000,
      seed: 's',
      runs: false,
    });
    const glyphs = layout.lines[0]?.glyphs ?? [];
    expect(glyphs.length).toBeGreaterThan(1);
    expect(glyphs.every((g) => g.kind !== 'run')).toBe(true);
  });
});
