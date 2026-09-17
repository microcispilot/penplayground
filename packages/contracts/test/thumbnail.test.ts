import { describe, expect, it } from 'vitest';
import {
  EMPTY_SKETCH,
  META_MAX_DESCRIPTION_CHARS,
  META_MAX_KEYWORDS,
  type ModelSessionMeta,
  type ModelSketchElement,
  normaliseSessionMeta,
  normaliseSketchElement,
  SessionMeta,
  SKETCH_MAX_ELEMENTS,
  SKETCH_MAX_LABEL_CHARS,
  SketchSpec,
} from '../src/thumbnail.js';

const meta = (elements: ModelSketchElement[], extra: Partial<ModelSessionMeta> = {}) => ({
  description: 'Tokens become vectors; attention scores queries against keys.',
  keywords: ['transformers', 'attention', 'tokens'],
  category: 'computing-data' as const,
  thumbnail: { elements },
  ...extra,
});

describe('SketchSpec contract', () => {
  it('accepts a well-formed teacher sketch and the empty sketch', () => {
    const spec = SketchSpec.parse({
      elements: [
        { kind: 'label', text: 'Attention', x: 0, y: 0, w: 6, size: 'lg', ink: 'accent' },
        { kind: 'box', x: 1, y: 2, w: 2, h: 1, text: 'Q', ink: 'ink' },
        { kind: 'box', x: 5, y: 2, w: 2, h: 1, text: 'K', ink: 'ink' },
        { kind: 'arrow', x1: 3, y1: 2.5, x2: 5, y2: 2.5, text: 'q·k', ink: 'accent' },
        { kind: 'bars', x: 8, y: 3, w: 3, h: 3, values: [0.2, 0.9, 0.4], ink: 'ink' },
      ],
    });
    expect(spec.elements).toHaveLength(5);
    expect(SketchSpec.parse(EMPTY_SKETCH).elements).toEqual([]);
  });

  it('rejects out-of-grid coordinates, over-long labels and too many elements', () => {
    expect(
      SketchSpec.safeParse({
        elements: [{ kind: 'box', x: 13, y: 0, w: 1, h: 1, text: '', ink: 'ink' }],
      }).success,
    ).toBe(false);
    expect(
      SketchSpec.safeParse({
        elements: [
          {
            kind: 'label',
            text: 'x'.repeat(SKETCH_MAX_LABEL_CHARS + 1),
            x: 0,
            y: 0,
            w: 2,
            size: 'sm',
            ink: 'ink',
          },
        ],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: SKETCH_MAX_ELEMENTS + 1 }, () => ({
      kind: 'highlight' as const,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }));
    expect(SketchSpec.safeParse({ elements: many }).success).toBe(false);
  });
});

describe('normaliseSketchElement', () => {
  it('pulls coordinates back onto the grid and shortens spans that run off it', () => {
    const box = normaliseSketchElement({
      kind: 'box',
      x: 10,
      y: -3,
      w: 8,
      h: 40,
      text: '  A   box  ',
      ink: 'ink',
    });
    expect(box).toEqual({ kind: 'box', x: 10, y: 0, w: 2, h: 7, text: 'A box', ink: 'ink' });
  });

  it('cuts an over-long label at a word boundary', () => {
    const el = normaliseSketchElement({
      kind: 'label',
      text: 'How Transformers Predict Text And Then Some More Words Here',
      x: 0,
      y: 0,
      w: 8,
      size: 'lg',
      ink: 'ink',
    });
    expect(el?.kind === 'label' && el.text).toBe('How Transformers Predict Text And Then');
    const noSpaces = normaliseSketchElement({
      kind: 'label',
      text: 'x'.repeat(60),
      x: 0,
      y: 0,
      w: 8,
      size: 'lg',
      ink: 'ink',
    });
    expect(noSpaces?.kind === 'label' && noSpaces.text.length).toBe(SKETCH_MAX_LABEL_CHARS);
  });

  it('snaps to quarter cells and keeps a minimum half-cell span', () => {
    const c = normaliseSketchElement({
      kind: 'circle',
      x: 1.13,
      y: 1.9,
      w: 0.1,
      h: 0,
      text: '',
      ink: 'accent',
    });
    expect(c).toEqual({ kind: 'circle', x: 1.25, y: 2, w: 0.5, h: 0.5, text: '', ink: 'accent' });
  });

  it('drops degenerate elements: empty labels, zero-length arrows and lines, bars with no values', () => {
    expect(
      normaliseSketchElement({
        kind: 'label',
        text: '   ',
        x: 0,
        y: 0,
        w: 2,
        size: 'md',
        ink: 'ink',
      }),
    ).toBeNull();
    expect(
      normaliseSketchElement({ kind: 'arrow', x1: 2, y1: 2, x2: 2.1, y2: 2, text: '', ink: 'ink' }),
    ).toBeNull();
    expect(
      normaliseSketchElement({
        kind: 'line',
        x1: 4,
        y1: 4,
        x2: 4,
        y2: 4,
        curve: 'none',
        dashed: false,
        ink: 'ink',
      }),
    ).toBeNull();
    expect(
      normaliseSketchElement({ kind: 'bars', x: 0, y: 0, w: 3, h: 3, values: [], ink: 'ink' }),
    ).toBeNull();
  });

  it('scales bar values given in percent or counts by the tallest bar and clamps fractions', () => {
    const bars = normaliseSketchElement({
      kind: 'bars',
      x: 0,
      y: 0,
      w: 3,
      h: 3,
      values: [45, 90, -1, Number.NaN],
      ink: 'ink',
    });
    expect(bars?.kind === 'bars' && bars.values).toEqual([0.5, 1, 0]);
    const fractions = normaliseSketchElement({
      kind: 'bars',
      x: 0,
      y: 0,
      w: 3,
      h: 3,
      values: [0.2, 1, 0.6],
      ink: 'ink',
    });
    expect(fractions?.kind === 'bars' && fractions.values).toEqual([0.2, 1, 0.6]);
  });

  it('collapses duplicate trace points and drops a trace with fewer than two', () => {
    const t = normaliseSketchElement({
      kind: 'trace',
      points: [
        { x: 0, y: 4 },
        { x: 0.1, y: 4.05 },
        { x: 2, y: 2 },
        { x: 13, y: 9 },
      ],
      smooth: true,
      ink: 'ink',
    });
    expect(t).toEqual({
      kind: 'trace',
      points: [
        { x: 0, y: 4 },
        { x: 2, y: 2 },
        { x: 12, y: 7 },
      ],
      smooth: true,
      ink: 'ink',
    });
    expect(
      normaliseSketchElement({
        kind: 'trace',
        points: [
          { x: 1, y: 1 },
          { x: 1.1, y: 1 },
        ],
        smooth: false,
        ink: 'ink',
      }),
    ).toBeNull();
  });

  it('survives non-finite numbers', () => {
    const el = normaliseSketchElement({
      kind: 'underline',
      x: Number.POSITIVE_INFINITY,
      y: Number.NaN,
      w: Number.NEGATIVE_INFINITY,
      ink: 'accent',
    });
    expect(el).toEqual({ kind: 'underline', x: 0, y: 0, w: 0.5, ink: 'accent' });
  });
});

describe('normaliseSessionMeta', () => {
  it('always yields a valid SessionMeta from plausible model output', () => {
    const out = normaliseSessionMeta(
      meta(
        [
          { kind: 'label', text: 'Tokens → vectors', x: 0, y: 0, w: 8, size: 'lg', ink: 'ink' },
          { kind: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, text: '', ink: 'ink' },
          { kind: 'highlight', x: 0, y: 0, w: 4, h: 1 },
        ],
        {
          description: `${'A very long description. '.repeat(20)}`,
          keywords: [
            'Tokens',
            'tokens',
            ' attention ',
            '',
            'heads',
            'softmax',
            'vectors',
            'extra',
            'more',
          ],
        },
      ),
    );
    expect(SessionMeta.safeParse(out).success).toBe(true);
    expect(out.description.length).toBeLessThanOrEqual(META_MAX_DESCRIPTION_CHARS);
    expect(out.keywords).toEqual(['Tokens', 'attention', 'heads', 'softmax', 'vectors', 'extra']);
    expect(out.keywords.length).toBeLessThanOrEqual(META_MAX_KEYWORDS);
    expect(out.thumbnail.elements.map((e) => e.kind)).toEqual(['label', 'highlight']);
  });

  it('caps elements at the maximum, dropping decoration before content', () => {
    const boxes = Array.from({ length: 11 }, (_, i) => ({
      kind: 'box' as const,
      x: i,
      y: 1,
      w: 1,
      h: 1,
      text: String(i),
      ink: 'ink' as const,
    }));
    const highlights = Array.from({ length: 4 }, () => ({
      kind: 'highlight' as const,
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    }));
    const out = normaliseSessionMeta(meta([...highlights, ...boxes]));
    expect(out.thumbnail.elements).toHaveLength(11);
    expect(out.thumbnail.elements.every((e) => e.kind === 'box')).toBe(true);
    expect(SketchSpec.safeParse(out.thumbnail).success).toBe(true);
  });

  it('is deterministic under a random fuzz and always validates', () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const kinds = [
      'label',
      'box',
      'circle',
      'arrow',
      'line',
      'bars',
      'trace',
      'underline',
      'highlight',
    ] as const;
    const n = () => (rnd() - 0.3) * 40;
    for (let round = 0; round < 200; round++) {
      const elements: ModelSketchElement[] = Array.from({ length: Math.floor(rnd() * 20) }, () => {
        const kind = kinds[Math.floor(rnd() * kinds.length)] ?? 'box';
        const ink = rnd() > 0.5 ? ('ink' as const) : ('accent' as const);
        switch (kind) {
          case 'label':
            return {
              kind,
              text: 'abc '.repeat(Math.floor(rnd() * 12)),
              x: n(),
              y: n(),
              w: n(),
              size: 'md',
              ink,
            };
          case 'box':
          case 'circle':
            return { kind, x: n(), y: n(), w: n(), h: n(), text: 'x', ink };
          case 'arrow':
            return { kind, x1: n(), y1: n(), x2: n(), y2: n(), text: '', ink };
          case 'line':
            return { kind, x1: n(), y1: n(), x2: n(), y2: n(), curve: 'up', dashed: true, ink };
          case 'bars':
            return { kind, x: n(), y: n(), w: n(), h: n(), values: [n(), n()], ink };
          case 'trace':
            return {
              kind,
              points: Array.from({ length: Math.floor(rnd() * 20) }, () => ({ x: n(), y: n() })),
              smooth: rnd() > 0.5,
              ink,
            };
          case 'underline':
            return { kind, x: n(), y: n(), w: n(), ink };
          case 'highlight':
            return { kind, x: n(), y: n(), w: n(), h: n() };
          default:
            return { kind: 'highlight', x: n(), y: n(), w: n(), h: n() };
        }
      });
      const a = normaliseSessionMeta(meta(elements));
      const b = normaliseSessionMeta(meta(elements));
      expect(a).toEqual(b);
      const parsed = SessionMeta.safeParse(a);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
    }
  });
});
