import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, Layout, MARGIN, PAGE_H, PAGE_STRIDE, PAGE_W } from '../src/layout.js';

describe('Layout', () => {
  it('starts at the top-left of the content rect', () => {
    const l = new Layout();
    const p = l.place({ w: 100, h: 40, place: 'flow' });
    expect(p).toMatchObject({ x: MARGIN, y: MARGIN, w: 100, h: 40, page: 0, used: 'flow' });
    expect(l.pageArea).toEqual({ x: 0, y: 0, w: PAGE_W, h: PAGE_H });
  });

  it('flow continues the line and wraps when the column is exceeded', () => {
    const l = new Layout();
    const a = l.place({ w: 300, h: 40, place: 'flow' });
    const b = l.place({ w: 300, h: 40, place: 'flow' });
    expect(b.y).toBe(a.y);
    expect(b.x).toBe(a.x + 300 + DEFAULT_LAYOUT.itemGap);
    // 300 + 18 + 300 + 18 = 636; a 200-wide item overruns the 640 column → wraps.
    const c = l.place({ w: 200, h: 40, place: 'flow' });
    expect(c.x).toBe(MARGIN);
    expect(c.y).toBe(a.y + 40 + DEFAULT_LAYOUT.lineGap);
  });

  it('newline starts a new line under the tallest item', () => {
    const l = new Layout();
    l.place({ w: 100, h: 40, place: 'flow' });
    l.place({ w: 100, h: 90, place: 'flow' });
    const n = l.place({ w: 100, h: 40, place: 'newline' });
    expect(n.x).toBe(MARGIN);
    expect(n.y).toBe(MARGIN + 90 + DEFAULT_LAYOUT.lineGap);
  });

  it('newline at the very start does not move down', () => {
    const l = new Layout();
    const n = l.place({ w: 100, h: 40, place: 'newline' });
    expect(n).toMatchObject({ x: MARGIN, y: MARGIN });
  });

  it('column opens the next column to the right, then a new page when there is no room', () => {
    const l = new Layout();
    l.place({ w: 100, h: 40, place: 'flow' });
    l.place({ w: 100, h: 40, place: 'newline' });
    const c1 = l.place({ w: 100, h: 40, place: 'column' });
    expect(c1.newColumn).toBe(true);
    expect(c1.x).toBe(MARGIN + DEFAULT_LAYOUT.columnWidth + DEFAULT_LAYOUT.columnGap);
    expect(c1.y).toBe(MARGIN);
    // Third column would end at 80 + 2*(640+64) + 640 = 2128 > 1520 → new page.
    const c2 = l.place({ w: 100, h: 40, place: 'column' });
    expect(c2.newPage).toBe(true);
    expect(c2.page).toBe(1);
    expect(c2).toMatchObject({ x: MARGIN, y: PAGE_STRIDE + MARGIN });
  });

  it('beside and below use the ref bounds and fall back to flow for unknown refs', () => {
    const l = new Layout();
    l.register('b1', { x: 200, y: 300, w: 120, h: 50 });
    const beside = l.place({ w: 80, h: 30, place: 'beside', ref: 'b1' });
    expect(beside).toMatchObject({
      x: 200 + 120 + DEFAULT_LAYOUT.relativeGap,
      y: 300,
      used: 'beside',
    });
    const below = l.place({ w: 80, h: 30, place: 'below', ref: 'b1' });
    expect(below).toMatchObject({
      x: 200,
      y: 300 + 50 + DEFAULT_LAYOUT.relativeGap,
      used: 'below',
    });
    const unknown = l.place({ w: 80, h: 30, place: 'below', ref: 'nope' });
    expect(unknown.used).toBe('flow');
  });

  it('center centres in the page and continues below the item', () => {
    const l = new Layout();
    const c = l.place({ w: 400, h: 200, place: 'center' });
    expect(c.x).toBe(MARGIN + (PAGE_W - 2 * MARGIN - 400) / 2);
    expect(c.y).toBeGreaterThanOrEqual(MARGIN);
    const next = l.place({ w: 100, h: 40, place: 'flow' });
    expect(next.x).toBe(MARGIN);
    expect(next.y).toBe(c.y + 200 + DEFAULT_LAYOUT.lineGap);
  });

  it('newpage moves the page area down by 1100 and resets the cursor', () => {
    const l = new Layout();
    l.place({ w: 100, h: 40, place: 'flow' });
    const area = l.newPage();
    expect(area).toEqual({ x: 0, y: PAGE_STRIDE, w: PAGE_W, h: PAGE_H });
    const p = l.place({ w: 100, h: 40, place: 'flow' });
    expect(p).toMatchObject({ x: MARGIN, y: PAGE_STRIDE + MARGIN, page: 1 });
  });

  it('overflowing the bottom of a column moves to the next column, then to a new page', () => {
    const l = new Layout();
    for (let i = 0; i < 12; i++) l.place({ w: 100, h: 80, place: 'newline' });
    // 12 × (80 + 18) = 1176 > 840 of content height → we must be in column 2 by now.
    const last = l.place({ w: 100, h: 80, place: 'newline' });
    expect(last.x).toBe(MARGIN + DEFAULT_LAYOUT.columnWidth + DEFAULT_LAYOUT.columnGap);
    for (let i = 0; i < 12; i++) l.place({ w: 100, h: 80, place: 'newline' });
    expect(l.page).toBe(1);
  });

  it('note slots stack on the right column', () => {
    const l = new Layout();
    l.place({ w: 100, h: 40, place: 'flow' });
    const a = l.noteSlot(300, 120);
    const b = l.noteSlot(300, 120);
    expect(a.x).toBe(PAGE_W - MARGIN - 300);
    expect(a.y).toBe(MARGIN);
    expect(b.y).toBe(a.y + 120 + DEFAULT_LAYOUT.noteGap);
  });

  it('remainingLineWidth and atLineStart describe the cursor', () => {
    const l = new Layout();
    expect(l.atLineStart()).toBe(true);
    expect(l.remainingLineWidth()).toBe(DEFAULT_LAYOUT.columnWidth);
    l.place({ w: 100, h: 40, place: 'flow' });
    expect(l.atLineStart()).toBe(false);
    expect(l.remainingLineWidth()).toBe(DEFAULT_LAYOUT.columnWidth - 100 - DEFAULT_LAYOUT.itemGap);
  });
});
