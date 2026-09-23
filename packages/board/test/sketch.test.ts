import { describe, expect, it } from 'vitest';
import {
  connectNearestSides,
  DEFAULT_SKETCH_LAYOUT,
  layoutSketch,
  nodeWidth,
  parseSketch,
} from '../src/sketch.js';

const EXAMPLE = `
  box q "Query"
  box k "Key"
  box v "Value"
  row
  box s "Score = q·k / √d"
  arrow q s
  arrow k s
`;

describe('parseSketch', () => {
  it('parses the BOARD_RULES example', () => {
    const p = parseSketch(EXAMPLE);
    expect(p.warnings).toEqual([]);
    expect(p.nodes.map((n) => [n.id, n.kind, n.label, n.row])).toEqual([
      ['q', 'box', 'Query', 0],
      ['k', 'box', 'Key', 0],
      ['v', 'box', 'Value', 0],
      ['s', 'box', 'Score = q·k / √d', 1],
    ]);
    expect(p.edges).toEqual([
      { from: 'q', to: 's', label: '' },
      { from: 'k', to: 's', label: '' },
    ]);
  });

  it('tolerates smart quotes, extra whitespace, unquoted labels and ->', () => {
    const p = parseSketch(
      'box   a   “Hello there”\n\tcircle b ‘Ring’\nnote n plain text here\narrow a -> b "weights"',
    );
    expect(p.nodes.map((n) => n.label)).toEqual(['Hello there', 'Ring', 'plain text here']);
    expect(p.nodes[1]?.kind).toBe('circle');
    expect(p.nodes[2]?.kind).toBe('note');
    expect(p.edges).toEqual([{ from: 'a', to: 'b', label: 'weights' }]);
    expect(p.warnings).toEqual([]);
  });

  it('reports unknown lines, unknown arrow ends and duplicate ids without failing', () => {
    const p = parseSketch('box a "A"\nbox a "Again"\nwibble\narrow a zz\narrow a a');
    expect(p.nodes).toHaveLength(1);
    expect(p.edges).toHaveLength(0);
    expect(p.warnings).toHaveLength(4);
    expect(p.warnings.join('\n')).toMatch(/duplicate id "a"/);
    expect(p.warnings.join('\n')).toMatch(/unknown statement "wibble"/);
    expect(p.warnings.join('\n')).toMatch(/unknown id "zz"/);
  });

  it('does not open empty rows', () => {
    const p = parseSketch('row\nrow\nbox a "A"\nrow\nrow\nbox b "B"');
    expect(p.nodes.map((n) => n.row)).toEqual([0, 1]);
  });

  it('empty label falls back to the id', () => {
    expect(parseSketch('box q').nodes[0]?.label).toBe('q');
  });
});

describe('layoutSketch', () => {
  it('lays rows top→bottom and nodes left→right with the 36 gap', () => {
    const l = layoutSketch(parseSketch(EXAMPLE));
    const [q, k, v, s] = l.nodes;
    if (!q || !k || !v || !s) throw new Error('nodes missing');
    expect(q.y).toBe(k.y);
    expect(k.x).toBe(q.x + q.w + 36);
    expect(v.x).toBe(k.x + k.w + 36);
    expect(s.y).toBe(q.y + 64 + 36);
    expect(l.height).toBe(64 + 36 + 64);
    // Row 1 is centred under row 0.
    expect(s.x + s.w / 2).toBeCloseTo(l.width / 2, 5);
  });

  /**
   * The bounds moved with the board's hand (ADR-0034). Eraser's mean advance
   * is 1.78x Caveat's, so a box sized for Caveat holds barely half the label
   * — and a clamped box does not shrink its text, it lets it spill out.
   * `charWidth` and `maxWidth` were re-derived together; this checks they
   * still agree with each other rather than re-stating either number.
   */
  it('node width tracks label length within [120, 520]', () => {
    expect(nodeWidth('')).toBe(120);
    expect(nodeWidth('Key')).toBe(120);
    const { charWidth, padding, maxWidth, minWidth } = DEFAULT_SKETCH_LAYOUT;
    expect(nodeWidth('Score = q·k / √d')).toBe(16 * charWidth + padding);
    expect(nodeWidth('x'.repeat(80))).toBe(maxWidth);
    expect(minWidth).toBe(120);
    // The cap has to hold a realistic label, or every longer one overflows.
    // "Self-attention" is 14 characters and is the kind of node label the
    // model actually emits.
    expect(14 * charWidth + padding).toBeLessThanOrEqual(maxWidth);
  });

  it('arrows connect nearest sides', () => {
    const { start, end } = connectNearestSides(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 200, w: 100, h: 50 },
    );
    expect(start).toEqual({ x: 50, y: 50 });
    expect(end).toEqual({ x: 50, y: 200 });
    const side = connectNearestSides(
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 300, y: 10, w: 100, h: 50 },
    );
    expect(side.start).toEqual({ x: 100, y: 25 });
    expect(side.end).toEqual({ x: 300, y: 35 });
  });

  it('edges get endpoints in sketch space and a label point', () => {
    const l = layoutSketch(parseSketch(EXAMPLE));
    const e = l.edges[0];
    if (!e) throw new Error('edge missing');
    expect(e.start.y).toBe(64);
    expect(e.end.y).toBe(100);
    expect(Number.isFinite(e.labelAt.x)).toBe(true);
  });
});
