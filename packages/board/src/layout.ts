import type { Placement } from '@pen/contracts';
import { type Bounds, bottom, right } from './geometry.js';

/**
 * Layout engine: keeps a writing cursor on an infinite sheet of paper. The
 * model never computes pixels (contracts/cues.ts); it only says `flow`,
 * `newline`, `column`, `beside`, `below` or `center`, and this module turns
 * that into absolute page coordinates.
 *
 * Model of the page:
 *   - A page area is PAGE_W × PAGE_H world units with MARGIN on every side.
 *     `newpage` moves the page area down by PAGE_STRIDE and resets the cursor;
 *     the previous page stays in the world (and in the timeline) above.
 *   - Inside the content rect the hand writes in columns of `columnWidth`.
 *     `column` opens the next column to the right; when there is no room it
 *     opens a fresh page area below instead.
 *   - `flow` continues the current line and wraps to a new line when the item
 *     would overrun the column. When a line would overrun the bottom of the
 *     page the hand moves to the next column (or page).
 */

export const PAGE_W = 1600;
export const PAGE_H = 1000;
export const MARGIN = 80;
export const PAGE_STRIDE = 1100;

export interface LayoutOptions {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  pageStride: number;
  columnWidth: number;
  columnGap: number;
  /** Horizontal gap between items on one line. */
  itemGap: number;
  /** Vertical gap between lines. */
  lineGap: number;
  /** Offset used by beside/below. */
  relativeGap: number;
  /** Width reserved for pinned note cards on the right. */
  noteWidth: number;
  noteGap: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  pageWidth: PAGE_W,
  pageHeight: PAGE_H,
  margin: MARGIN,
  pageStride: PAGE_STRIDE,
  columnWidth: 640,
  columnGap: 64,
  itemGap: 18,
  lineGap: 18,
  relativeGap: 24,
  noteWidth: 300,
  noteGap: 16,
};

export interface PlaceRequest {
  w: number;
  h: number;
  place: Placement;
  /** Board id for beside/below. Unknown ids fall back to `flow`. */
  ref?: string;
}

export interface Placed extends Bounds {
  /** Zero-based page index the item landed on. */
  page: number;
  /** The placement actually used (after fallbacks). */
  used: Placement;
  /** True when placing opened a new page area. */
  newPage: boolean;
  /** True when placing moved to a new column. */
  newColumn: boolean;
}

export interface Cursor {
  x: number;
  y: number;
  /** Tallest item on the current line. */
  lineHeight: number;
}

export class Layout {
  readonly opts: LayoutOptions;
  private pageIndex = 0;
  private columnX: number;
  private cursor: Cursor;
  private readonly refs = new Map<string, Bounds>();
  /** Bottom edge of the last pinned note, per page. */
  private readonly noteBottom = new Map<number, number>();

  constructor(opts: Partial<LayoutOptions> = {}) {
    this.opts = { ...DEFAULT_LAYOUT, ...opts };
    this.columnX = this.contentLeft;
    this.cursor = { x: this.columnX, y: this.contentTop, lineHeight: 0 };
  }

  // ── geometry of the current page ──────────────────────────────────────

  get page(): number {
    return this.pageIndex;
  }

  /** Absolute bounds of the current page area. */
  get pageArea(): Bounds {
    return {
      x: 0,
      y: this.pageIndex * this.opts.pageStride,
      w: this.opts.pageWidth,
      h: this.opts.pageHeight,
    };
  }

  /** Content rect: page area minus margins. */
  get content(): Bounds {
    const p = this.pageArea;
    const m = this.opts.margin;
    return { x: p.x + m, y: p.y + m, w: p.w - m * 2, h: p.h - m * 2 };
  }

  private get contentLeft(): number {
    return this.content.x;
  }
  private get contentTop(): number {
    return this.content.y;
  }

  get columnWidth(): number {
    return this.opts.columnWidth;
  }

  /** Right edge of the current column. */
  get columnRight(): number {
    return Math.min(this.columnX + this.opts.columnWidth, right(this.content));
  }

  get position(): Readonly<Cursor> {
    return this.cursor;
  }

  /** Horizontal room left on the current line for a `flow` item. */
  remainingLineWidth(): number {
    return Math.max(0, this.columnRight - this.cursor.x);
  }

  /** True when the cursor sits at the start of a line. */
  atLineStart(): boolean {
    return this.cursor.x <= this.columnX + 0.5;
  }

  // ── refs ──────────────────────────────────────────────────────────────

  register(id: string, b: Bounds): void {
    this.refs.set(id, { ...b });
  }

  boundsOf(id: string): Bounds | undefined {
    const b = this.refs.get(id);
    return b ? { ...b } : undefined;
  }

  forget(id: string): void {
    this.refs.delete(id);
  }

  clearRefs(): void {
    this.refs.clear();
  }

  /** Reset everything: page 0, cursor at the top-left, no refs. */
  reset(): void {
    this.pageIndex = 0;
    this.refs.clear();
    this.noteBottom.clear();
    this.resetCursor();
  }

  // ── placement ─────────────────────────────────────────────────────────

  place(req: PlaceRequest): Placed {
    const w = Math.max(0, req.w);
    const h = Math.max(0, req.h);
    switch (req.place) {
      case 'beside':
      case 'below': {
        const ref = req.ref ? this.refs.get(req.ref) : undefined;
        if (!ref) return this.placeFlow(w, h, 'flow');
        return this.placeRelative(ref, req.place, w, h);
      }
      case 'center':
        return this.placeCenter(w, h);
      case 'column':
        return this.placeColumn(w, h);
      case 'newline':
        return this.placeNewline(w, h);
      default:
        return this.placeFlow(w, h, 'flow');
    }
  }

  /** After `erase all`: same page, cursor back at the top, refs gone. */
  restartPage(): void {
    this.refs.clear();
    this.noteBottom.delete(this.pageIndex);
    this.resetCursor();
  }

  /** `newpage`: a fresh page area below; returns its bounds. */
  newPage(): Bounds {
    this.pageIndex += 1;
    this.resetCursor();
    return this.pageArea;
  }

  /**
   * Slot for a pinned note card: the right column of the current page, level
   * with the current writing position, stacked under earlier notes.
   */
  noteSlot(w: number, h: number): Bounds {
    const c = this.content;
    const x = right(c) - w;
    const prev = this.noteBottom.get(this.pageIndex);
    const baseY = prev === undefined ? this.cursor.y : prev + this.opts.noteGap;
    // Keep the card on the page; if the stack overflows, start again at the top.
    let y = baseY;
    if (y + h > bottom(c)) y = c.y;
    this.noteBottom.set(this.pageIndex, y + h);
    return { x, y, w, h };
  }

  // ── internals ─────────────────────────────────────────────────────────

  private resetCursor(): void {
    this.columnX = this.contentLeft;
    this.cursor = { x: this.columnX, y: this.contentTop, lineHeight: 0 };
  }

  private placeFlow(w: number, h: number, used: Placement): Placed {
    let newColumn = false;
    let newPage = false;
    // Wrap when the item overruns the column and we are not already at the line start.
    if (!this.atLineStart() && this.cursor.x + w > this.columnRight + 0.5) {
      this.newline();
    }
    ({ newColumn, newPage } = this.ensureVerticalRoom(h));
    const placed: Placed = {
      x: this.cursor.x,
      y: this.cursor.y,
      w,
      h,
      page: this.pageIndex,
      used,
      newPage,
      newColumn,
    };
    this.advance(w, h);
    return placed;
  }

  private placeNewline(w: number, h: number): Placed {
    if (!this.atLineStart() || this.cursor.lineHeight > 0) this.newline();
    const p = this.placeFlow(w, h, 'newline');
    return p;
  }

  private placeColumn(w: number, h: number): Placed {
    const nextX = this.columnX + this.opts.columnWidth + this.opts.columnGap;
    const fits = nextX + Math.min(w, this.opts.columnWidth) <= right(this.content) + 0.5;
    let newPage = false;
    if (fits) {
      this.columnX = nextX;
    } else {
      this.newPage();
      newPage = true;
    }
    this.cursor = { x: this.columnX, y: this.contentTop, lineHeight: 0 };
    const p = this.placeFlow(w, h, 'column');
    return { ...p, newColumn: fits, newPage: newPage || p.newPage };
  }

  private placeRelative(ref: Bounds, place: 'beside' | 'below', w: number, h: number): Placed {
    const gap = this.opts.relativeGap;
    let x = place === 'beside' ? right(ref) + gap : ref.x;
    let y = place === 'beside' ? ref.y : bottom(ref) + gap;
    // Keep the item on the sheet; the ref may sit near an edge.
    const c = this.content;
    if (x + w > right(c)) x = Math.max(c.x, right(c) - w);
    if (y + h > bottom(c) && place === 'beside') y = Math.max(c.y, bottom(c) - h);
    const placed: Placed = {
      x,
      y,
      w,
      h,
      page: this.pageIndex,
      used: place,
      newPage: false,
      newColumn: false,
    };
    // The hand is now to the right of what it just wrote.
    this.cursor = { x: x + w + this.opts.itemGap, y, lineHeight: h };
    return placed;
  }

  private placeCenter(w: number, h: number): Placed {
    const c = this.content;
    // Centre horizontally in the content rect; vertically, centre in the room
    // that is left below the cursor so the diagram does not cover prior text.
    const top = this.cursor.lineHeight > 0 ? this.cursor.y + this.cursor.lineHeight : this.cursor.y;
    let newPage = false;
    let regionTop = top;
    if (top + h > bottom(c)) {
      this.newPage();
      newPage = true;
      regionTop = this.contentTop;
    }
    const cc = this.content;
    const x = cc.x + (cc.w - w) / 2;
    const room = bottom(cc) - regionTop;
    const y = regionTop + Math.max(0, (room - h) / 2);
    const placed: Placed = {
      x,
      y,
      w,
      h,
      page: this.pageIndex,
      used: 'center',
      newPage,
      newColumn: false,
    };
    // Continue below the diagram at the column start.
    this.cursor = { x: this.columnX, y: y + h + this.opts.lineGap, lineHeight: 0 };
    return placed;
  }

  private newline(): void {
    this.cursor = {
      x: this.columnX,
      y:
        this.cursor.y +
        this.cursor.lineHeight +
        (this.cursor.lineHeight > 0 ? this.opts.lineGap : 0),
      lineHeight: 0,
    };
  }

  private ensureVerticalRoom(h: number): { newColumn: boolean; newPage: boolean } {
    if (this.cursor.y + h <= bottom(this.content) + 0.5)
      return { newColumn: false, newPage: false };
    const nextX = this.columnX + this.opts.columnWidth + this.opts.columnGap;
    if (nextX + this.opts.columnWidth * 0.5 <= right(this.content)) {
      this.columnX = nextX;
      this.cursor = { x: this.columnX, y: this.contentTop, lineHeight: 0 };
      return { newColumn: true, newPage: false };
    }
    this.newPage();
    return { newColumn: false, newPage: true };
  }

  private advance(w: number, h: number): void {
    this.cursor = {
      x: this.cursor.x + w + this.opts.itemGap,
      y: this.cursor.y,
      lineHeight: Math.max(this.cursor.lineHeight, h),
    };
  }
}
