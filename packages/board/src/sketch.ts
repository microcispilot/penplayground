import { type Bounds, bottom, center, clamp, type Point, right } from './geometry.js';

/**
 * The SKETCH DSL the model emits (session-engine BOARD_RULES):
 *   box ID "Label"      circle ID "Label"      note ID "text"
 *   row                 (start the next row)
 *   arrow A B "label"   (label optional)
 * Parsing is tolerant: extra whitespace, smart quotes, unquoted labels, `->`
 * between arrow ends. Unknown lines are skipped and reported in `warnings`
 * so the app can surface them (Sentry) without breaking the lesson.
 */

export type SketchNodeKind = 'box' | 'circle' | 'note';

export interface SketchNode {
  id: string;
  kind: SketchNodeKind;
  label: string;
  row: number;
}

export interface SketchEdge {
  from: string;
  to: string;
  label: string;
}

export interface ParsedSketch {
  nodes: SketchNode[];
  edges: SketchEdge[];
  warnings: string[];
}

const NODE_RE = /^(box|circle|note)\s+([A-Za-z_][\w.-]*)\s*(.*)$/i;
const ARROW_RE = /^arrow\s+([A-Za-z_][\w.-]*)\s*(?:->|→)?\s+([A-Za-z_][\w.-]*)\s*(.*)$/i;

function normaliseQuotes(s: string): string {
  return s.replace(/[“”„″]/g, '"').replace(/[‘’‚′]/g, "'");
}

/** Accepts `"Label"`, `'Label'`, or bare text; returns the label without quotes. */
function readLabel(raw: string): string {
  const s = normaliseQuotes(raw).trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1).trim();
    }
    if (first === '"' || first === "'") return s.slice(1).trim();
  }
  return s;
}

export function parseSketch(source: string): ParsedSketch {
  const nodes: SketchNode[] = [];
  const edges: SketchEdge[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  let row = 0;
  let rowHasNodes = false;

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    if (/^row$/i.test(line)) {
      // Consecutive `row` lines (or a leading one) do not open empty rows.
      if (rowHasNodes) {
        row += 1;
        rowHasNodes = false;
      }
      continue;
    }

    const node = NODE_RE.exec(line);
    if (node) {
      const kind = (node[1] ?? 'box').toLowerCase() as SketchNodeKind;
      const id = node[2] ?? '';
      const label = readLabel(node[3] ?? '');
      if (ids.has(id)) {
        warnings.push(`line ${i + 1}: duplicate id "${id}" ignored`);
        continue;
      }
      ids.add(id);
      nodes.push({ id, kind, label: label || id, row });
      rowHasNodes = true;
      continue;
    }

    const arrow = ARROW_RE.exec(line);
    if (arrow) {
      const from = arrow[1] ?? '';
      const to = arrow[2] ?? '';
      const label = readLabel(arrow[3] ?? '');
      if (!ids.has(from) || !ids.has(to)) {
        warnings.push(`line ${i + 1}: arrow references unknown id "${ids.has(from) ? to : from}"`);
        continue;
      }
      if (from === to) {
        warnings.push(`line ${i + 1}: arrow from "${from}" to itself ignored`);
        continue;
      }
      edges.push({ from, to, label });
      continue;
    }

    warnings.push(`line ${i + 1}: unknown statement "${line.slice(0, 40)}"`);
  }

  return { nodes, edges, warnings };
}

// ── layout ────────────────────────────────────────────────────────────────

export interface SketchLayoutOptions {
  /** Gap between nodes in a row and between rows. */
  gap: number;
  nodeHeight: number;
  noteHeight: number;
  minWidth: number;
  maxWidth: number;
  /**
   * Approximate hand-font advance per label character at the sketch label
   * size — what a node's box is sized from before anything is drawn.
   *
   * It is a property of the *font*, so it moved when the board's hand did.
   * Measured with opentype.js over a set of real sketch labels, Eraser's mean
   * advance is 1.78x Caveat's at every size (the ratio is scale-invariant:
   * 9.21 vs 16.41 at 26 px, 10.62 vs 18.93 at 30 px). The old 13 was Caveat's
   * number, and left at 13 it undersizes every box by nearly half — labels
   * spill out of the shapes drawn around them, which looks like broken layout
   * rather than like a font change.
   */
  charWidth: number;
  padding: number;
}

/**
 * Mean glyph advance as a fraction of font size, for the board's hand.
 *
 * Measured with opentype.js over real sketch labels rather than eyeballed:
 * Eraser is 16.41 units at 26 px, so 0.631. It is scale-invariant, which is
 * why it is a ratio and not a width — 9.21/26 and 10.62/30 give Caveat the
 * same 0.354 at every size.
 *
 * It lives here, exported, because two different places used to carry their
 * own Caveat-shaped magic number for the same fact: this file sized sketch
 * node boxes and `executor.ts` wrapped note-card questions. Swapping the hand
 * font moved both, and one of them would have been missed.
 */
export const HAND_ADVANCE_RATIO = 0.63;

export const DEFAULT_SKETCH_LAYOUT: SketchLayoutOptions = {
  gap: 36,
  nodeHeight: 64,
  noteHeight: 48,
  minWidth: 120,
  /*
   * Scaled with the hand. At 23 px a character, the old 320 clamped every
   * label past 12 characters — "Self-attention" is 14 — so boxes would have
   * been capped and their labels would have spilled out of them. 520 keeps the
   * same *character* capacity the 320/13 pair had (about 21), which is what
   * the number was really expressing.
   */
  maxWidth: 520,
  /*
   * 26 px label x 0.63 = 16.4 px of mean advance, then the same ~1.4x headroom
   * the old pair carried (13 against Caveat's 9.2) so a word of wide letters
   * still fits its box.
   */
  charWidth: 23,
  padding: 44,
};

export interface LaidOutNode extends SketchNode, Bounds {}

export interface LaidOutEdge extends SketchEdge {
  start: Point;
  end: Point;
  /** Where a label sits (offset from the midpoint, perpendicular to the arrow). */
  labelAt: Point;
}

export interface SketchLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

export function nodeWidth(
  label: string,
  opts: SketchLayoutOptions = DEFAULT_SKETCH_LAYOUT,
): number {
  return clamp(label.length * opts.charWidth + opts.padding, opts.minWidth, opts.maxWidth);
}

/**
 * Rows top→bottom, nodes left→right in declaration order, each row centred on
 * the widest row. Coordinates are relative to the sketch's top-left corner.
 */
export function layoutSketch(
  parsed: ParsedSketch,
  opts: SketchLayoutOptions = DEFAULT_SKETCH_LAYOUT,
): SketchLayout {
  const rows = new Map<number, SketchNode[]>();
  for (const n of parsed.nodes) {
    const list = rows.get(n.row);
    if (list) list.push(n);
    else rows.set(n.row, [n]);
  }
  const rowIndexes = [...rows.keys()].sort((a, b) => a - b);

  const rowWidths = rowIndexes.map((r) => {
    const list = rows.get(r) ?? [];
    return list.reduce((acc, n, i) => acc + nodeWidth(n.label, opts) + (i > 0 ? opts.gap : 0), 0);
  });
  const width = rowWidths.reduce((m, w) => Math.max(m, w), 0);

  const nodes: LaidOutNode[] = [];
  let y = 0;
  rowIndexes.forEach((r, ri) => {
    const list = rows.get(r) ?? [];
    const rowH = list.reduce(
      (m, n) => Math.max(m, n.kind === 'note' ? opts.noteHeight : opts.nodeHeight),
      0,
    );
    let x = (width - (rowWidths[ri] ?? 0)) / 2;
    for (const n of list) {
      const w = nodeWidth(n.label, opts);
      const h = n.kind === 'note' ? opts.noteHeight : opts.nodeHeight;
      nodes.push({ ...n, x, y: y + (rowH - h) / 2, w, h });
      x += w + opts.gap;
    }
    y += rowH + opts.gap;
  });
  const height = Math.max(0, y - opts.gap);

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges: LaidOutEdge[] = [];
  for (const e of parsed.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const { start, end } = connectNearestSides(a, b);
    edges.push({ ...e, start, end, labelAt: labelPoint(start, end) });
  }

  return { nodes, edges, width, height };
}

/** Pick the facing sides of two boxes and return the anchor points on each. */
export function connectNearestSides(a: Bounds, b: Bounds): { start: Point; end: Point } {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  // Dominant axis decides which sides face each other; the other axis keeps
  // the anchor near the centre so arrows do not clip corners.
  if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) {
    const start = { x: dx >= 0 ? right(a) : a.x, y: ca.y };
    const end = { x: dx >= 0 ? b.x : right(b), y: cb.y };
    return { start, end };
  }
  const start = { x: ca.x, y: dy >= 0 ? bottom(a) : a.y };
  const end = { x: cb.x, y: dy >= 0 ? b.y : bottom(b) };
  return { start, end };
}

export function labelPoint(start: Point, end: Point, offset = 16): Point {
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  // Perpendicular (rotated -90°) so the label sits above a left→right arrow.
  const nx = (end.y - start.y) / len;
  const ny = -(end.x - start.x) / len;
  return { x: mx + nx * offset, y: my + ny * offset };
}
