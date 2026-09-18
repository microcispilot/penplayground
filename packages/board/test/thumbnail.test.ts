import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  EMPTY_SKETCH,
  SKETCH_MAX_ELEMENTS,
  type SketchSpec,
  SketchSpec as SketchSpecSchema,
} from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import { parseHandFont } from '../src/font.js';
import {
  createThumbnailFont,
  dashStroke,
  handTrace,
  outlineToCompactPath,
  renderSketchSvg,
  simplifyPolyline,
  THUMB_COLOURS,
  tracePolyline,
} from '../src/thumbnail.js';

const require = createRequire(import.meta.url);
const subset = (name: string) =>
  parseHandFont(
    readFileSync(require.resolve(`@fontsource/caveat/files/caveat-${name}-400-normal.woff`)),
  );
const font = createThumbnailFont([subset('latin'), subset('latin-ext'), subset('cyrillic')]);

/** A teacher's whiteboard sketch of attention: every element kind, at the element cap. */
const transformers: SketchSpec = {
  elements: [
    { kind: 'label', text: 'Attention', x: 0, y: 0, w: 6, size: 'lg', ink: 'accent' },
    { kind: 'underline', x: 0, y: 1, w: 3.5, ink: 'accent' },
    { kind: 'box', x: 0, y: 2, w: 2, h: 1.25, text: 'the', ink: 'ink' },
    { kind: 'box', x: 2.5, y: 2, w: 2, h: 1.25, text: 'cat', ink: 'ink' },
    { kind: 'box', x: 5, y: 2, w: 2, h: 1.25, text: 'sat', ink: 'accent' },
    { kind: 'arrow', x1: 6, y1: 3.5, x2: 1, y2: 5.25, text: 'query', ink: 'ink' },
    { kind: 'arrow', x1: 6, y1: 3.5, x2: 3.5, y2: 5.25, text: 'key', ink: 'ink' },
    { kind: 'circle', x: 0, y: 5.25, w: 2, h: 1.5, text: 'q·k / √d', ink: 'ink' },
    { kind: 'circle', x: 2.5, y: 5.25, w: 2, h: 1.5, text: 'softmax', ink: 'ink' },
    { kind: 'bars', x: 8, y: 1.5, w: 4, h: 4, values: [0.15, 0.9, 0.35, 0.2], ink: 'accent' },
    { kind: 'label', text: 'weights Σ = 1', x: 8, y: 5.75, w: 4, size: 'sm', ink: 'ink' },
    { kind: 'highlight', x: 4.75, y: 1.75, w: 2.5, h: 1.75 },
  ],
};

const ecg: SketchSpec = {
  elements: [
    { kind: 'label', text: 'Reading an ECG strip', x: 0, y: 0, w: 9, size: 'lg', ink: 'ink' },
    {
      kind: 'trace',
      points: [
        { x: 0, y: 4 },
        { x: 1.5, y: 4 },
        { x: 2.5, y: 3.4 },
        { x: 3.5, y: 4 },
        { x: 4.25, y: 4 },
      ],
      smooth: true,
      ink: 'ink',
    },
    {
      kind: 'trace',
      points: [
        { x: 4.25, y: 4 },
        { x: 4.75, y: 4.4 },
        { x: 5, y: 1.5 },
        { x: 5.5, y: 5 },
        { x: 6, y: 4 },
      ],
      smooth: false,
      ink: 'accent',
    },
    { kind: 'line', x1: 6, y1: 4, x2: 8, y2: 4, curve: 'up', dashed: false, ink: 'ink' },
    { kind: 'line', x1: 8, y1: 4, x2: 11.5, y2: 4, curve: 'none', dashed: false, ink: 'ink' },
    { kind: 'label', text: 'P', x: 2.5, y: 2.25, w: 1, size: 'md', ink: 'ink' },
    { kind: 'label', text: 'QRS', x: 5.25, y: 0.75, w: 2, size: 'md', ink: 'accent' },
    { kind: 'label', text: 'T', x: 7, y: 2.25, w: 1, size: 'md', ink: 'ink' },
    { kind: 'line', x1: 0, y1: 6.5, x2: 12, y2: 6.5, curve: 'none', dashed: true, ink: 'ink' },
  ],
};

const wellFormed = (svg: string) => {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  // Self-contained: no external references, no CSS variables, no text elements needing a font.
  expect(svg).not.toMatch(/href="(?!#)/);
  expect(svg).not.toMatch(/var\(|url\((?!#)|<text|<image|<style|@import/);
  expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  expect(svg).toContain(`fill="${THUMB_COLOURS.paper.hex}"`);
  expect(svg).toContain('<pattern id="dots"');
};

describe('renderSketchSvg', () => {
  it('renders the attention sketch to the golden SVG', async () => {
    const r = renderSketchSvg(transformers, font, { seed: 'golden' });
    wellFormed(r.svg);
    expect(r.elements).toBe(SKETCH_MAX_ELEMENTS);
    expect(r.unsupportedChars).toEqual([]);
    await expect(r.svg).toMatchFileSnapshot('./__snapshots__/thumbnail-transformers.svg');
  });

  it('renders the ECG sketch to the golden SVG', async () => {
    const r = renderSketchSvg(ecg, font, { seed: 'golden' });
    wellFormed(r.svg);
    await expect(r.svg).toMatchFileSnapshot('./__snapshots__/thumbnail-ecg.svg');
  });

  it('renders the empty sketch as valid paper', async () => {
    const r = renderSketchSvg(EMPTY_SKETCH, font);
    wellFormed(r.svg);
    expect(r.elements).toBe(0);
    expect(r.bytes).toBeLessThan(1_000);
    await expect(r.svg).toMatchFileSnapshot('./__snapshots__/thumbnail-empty.svg');
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const a = renderSketchSvg(transformers, font, { seed: 'sess-1' });
    const b = renderSketchSvg(transformers, font, { seed: 'sess-1' });
    const c = renderSketchSvg(transformers, font, { seed: 'sess-2' });
    expect(a.svg).toBe(b.svg);
    expect(a.svg).not.toBe(c.svg);
  });

  it('keeps a full 12-element sketch with long labels under 60 KB', () => {
    const heavy: SketchSpec = {
      elements: Array.from({ length: SKETCH_MAX_ELEMENTS }, (_, i) => ({
        kind: 'box' as const,
        x: (i % 4) * 3,
        y: Math.floor(i / 4) * 2,
        w: 3,
        h: 2,
        text: `Long label number ${i} here`,
        ink: i % 2 ? ('accent' as const) : ('ink' as const),
      })),
    };
    const r = renderSketchSvg(heavy, font);
    expect(r.bytes).toBe(new TextEncoder().encode(r.svg).length);
    expect(r.bytes).toBeLessThan(60_000);
    expect(renderSketchSvg(transformers, font).bytes).toBeLessThan(60_000);
  });

  it('deduplicates glyph outlines through <defs> and <use>', () => {
    const r = renderSketchSvg(
      { elements: [{ kind: 'label', text: 'aaaa', x: 0, y: 0, w: 4, size: 'md', ink: 'ink' }] },
      font,
    );
    expect(r.svg.match(/<path id="g\d+"/g)).toHaveLength(1);
    expect(r.svg.match(/<use href="#g0"/g)).toHaveLength(4);
  });

  it('extends the paper for a wider output and centres the sketch', () => {
    const og = renderSketchSvg(ecg, font, { width: 1200, height: 630, seed: 'golden' });
    expect(og.svg).toContain('width="1200" height="630"');
    expect(og.svg).toContain('viewBox="0 0 1714.3 900"');
    expect(og.svg).toContain('<g transform="translate(57.1 0)">');
    const card = renderSketchSvg(ecg, font, { seed: 'golden' });
    expect(card.svg).toContain('viewBox="0 0 1600 900"');
    expect(card.svg).toContain('<g transform="translate(0 0)">');
  });

  it('draws cyrillic through the composite font and squiggles what no subset has', () => {
    const r = renderSketchSvg(
      {
        elements: [
          { kind: 'label', text: 'Привет 日本', x: 0, y: 0, w: 8, size: 'md', ink: 'ink' },
        ],
      },
      font,
    );
    expect(r.unsupportedChars).toEqual(['日', '本']);
    // Six cyrillic glyphs became outlines; the two ideographs became pen squiggles (plain paths).
    expect(r.svg.match(/<use href="#g\d+"/g)?.length).toBe(6);
    expect(r.svg.match(/<path d="M[^"]+" stroke="none"\/>/g)?.length).toBe(2);
  });

  it('writes Σ with the synthesised ∑ pen stroke instead of a squiggle', () => {
    const r = renderSketchSvg(
      { elements: [{ kind: 'label', text: 'Σ = 1', x: 0, y: 0, w: 4, size: 'md', ink: 'ink' }] },
      font,
    );
    expect(r.unsupportedChars).toEqual([]);
    expect(r.svg).toMatch(/<use href="#g0"[^>]*fill="none"/);
  });

  it('draws highlights beneath ink regardless of order', () => {
    const r = renderSketchSvg(
      {
        elements: [
          { kind: 'box', x: 1, y: 1, w: 2, h: 1, text: '', ink: 'ink' },
          { kind: 'highlight', x: 1, y: 1, w: 2, h: 1 },
        ],
      },
      font,
    );
    const highlightAt = r.svg.indexOf(THUMB_COLOURS.highlight.hex);
    const inkAt = r.svg.indexOf(`<g fill="${THUMB_COLOURS.ink.hex}"`);
    expect(highlightAt).toBeGreaterThan(0);
    expect(highlightAt).toBeLessThan(inkAt);
  });

  /**
   * The model guesses a highlight's width from a character count and gets it
   * wrong most of the time — a wash that stops halfway through the headline is
   * the single worst thing a thumbnail can do. Only the renderer knows how wide
   * the handwriting turned out, so it fits the wash to the words.
   */
  it('fits a highlight behind a headline to the words, not to the width it was given', () => {
    const headline = {
      kind: 'label',
      text: 'Attention, explained',
      x: 0.5,
      y: 0.25,
      w: 10.5,
      size: 'xl',
      ink: 'ink',
    } as const;
    const wash = (svg: string) => /<path d="([^"]+)" fill="#f6d476"/.exec(svg)?.[1] ?? '';
    const short = renderSketchSvg(
      // A wash asked for at a quarter of the headline's width.
      { elements: [{ kind: 'highlight', x: 0.5, y: 0.25, w: 2.5, h: 1.4 }, headline] },
      font,
      { seed: 'golden' },
    );
    const asked = renderSketchSvg(
      { elements: [{ kind: 'highlight', x: 0.5, y: 0.25, w: 10.5, h: 1.4 }, headline] },
      font,
      { seed: 'golden' },
    );
    // Both end up the same wash: it is the headline that decides, not the guess.
    expect(wash(short.svg)).not.toBe('');
    expect(wash(short.svg)).toBe(wash(asked.svg));
    // And it really does span the words: wider than the quarter-width it asked for.
    const xs = [...wash(short.svg).matchAll(/[ML](-?\d+) (-?\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2.5 * ((1600 - 88) / 12));
  });

  it('leaves a highlight that is not behind a label exactly where it was asked for', () => {
    const away = renderSketchSvg(
      {
        elements: [
          { kind: 'label', text: 'Read an ECG', x: 0.5, y: 0.25, w: 6, size: 'xl', ink: 'ink' },
          // Four rows below the headline: its own wash, over the drawing.
          { kind: 'highlight', x: 1, y: 4, w: 5, h: 2 },
        ],
      },
      font,
      { seed: 'golden' },
    );
    const d = /<path d="([^"]+)" fill="#f6d476"/.exec(away.svg)?.[1] ?? '';
    const ys = [...d.matchAll(/[ML](-?\d+) (-?\d+)/g)].map((m) => Number(m[2]));
    // Still down where it was put, not snapped up to the headline.
    expect(Math.min(...ys)).toBeGreaterThan(44 + 3.5 * ((900 - 88) / 7));
  });

  it('accepts anything the contract accepts', () => {
    const spec = SketchSpecSchema.parse(transformers);
    expect(() => renderSketchSvg(spec, font)).not.toThrow();
  });
});

describe('path helpers', () => {
  it('simplifyPolyline keeps endpoints and drops collinear points within tolerance', () => {
    const line = Array.from({ length: 50 }, (_, i) => [i, i * 0.5 + (i % 2) * 0.1]);
    const out = simplifyPolyline(line, 0.5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([49, 24.5 + 0.1]);
    expect(out.length).toBeLessThan(5);
    const corner = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(simplifyPolyline(corner, 0.5)).toEqual(corner);
  });

  it('outlineToCompactPath emits an integer closed polygon and skips non-finite points', () => {
    const d = outlineToCompactPath(
      [
        [0.4, 0.4],
        [10.2, 0.1],
        [Number.NaN, 3],
        [10, 10.4],
        [0, 10],
      ],
      0.1,
    );
    expect(d).toBe('M0 0L10 0L10 10L0 10Z');
    expect(outlineToCompactPath([[0, 0]])).toBe('');
  });

  it('tracePolyline keeps straight traces as given and rounds smooth ones through every point', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ];
    expect(tracePolyline(pts, false)).toEqual(pts);
    const smooth = tracePolyline(pts, true);
    expect(smooth.length).toBe(17);
    expect(smooth[0]).toEqual({ x: 0, y: 0 });
    expect(smooth[8]).toEqual({ x: 10, y: 10 });
    expect(smooth[16]).toEqual({ x: 20, y: 0 });
  });

  it('handTrace is one seeded stroke along the path', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
    ];
    const a = handTrace(pts, 'x');
    expect(a).toEqual(handTrace(pts, 'x'));
    expect(a).not.toEqual(handTrace(pts, 'y'));
    expect(a.length).toBe(21);
    for (const p of a) expect(Math.abs(p[0] - Math.min(60, Math.max(0, p[0]))) < 3).toBe(true);
  });

  it('keeps a title on one line when it fits the grid, whatever width the model guessed', () => {
    const r = renderSketchSvg(
      {
        elements: [
          {
            kind: 'label',
            text: 'Transformers predict text',
            x: 0.5,
            y: 0,
            w: 3,
            size: 'lg',
            ink: 'ink',
          },
        ],
      },
      font,
    );
    // Every glyph within baseline jitter of each other: one line (a wrap would add a full line height).
    const ys = [...r.svg.matchAll(/<use href="#g\d+" transform="translate\(\d+ (\d+)\)/g)].map(
      (m) => Number(m[1]),
    );
    expect(ys.length).toBeGreaterThan(20);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(6);
  });

  it('dashStroke cuts a stroke into on/off runs by arc length', () => {
    const pts = Array.from({ length: 101 }, (_, i): [number, number, number] => [i, 0, 0.5]);
    const dashes = dashStroke(pts, 30, 20);
    expect(dashes).toHaveLength(2);
    expect(dashes[0]?.[0]?.[0]).toBe(0);
    expect(dashes[0]?.at(-1)?.[0]).toBeCloseTo(30);
    expect(dashes[1]?.[0]?.[0]).toBeCloseTo(50);
    expect(dashes[1]?.at(-1)?.[0]).toBeCloseTo(80);
    expect(dashStroke([], 10, 5)).toEqual([]);
  });
});
