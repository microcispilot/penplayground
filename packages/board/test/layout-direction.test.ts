import { describe, expect, it } from 'vitest';
import { Layout, MARGIN, PAGE_W } from '../src/layout.js';

/**
 * Writing starts from the right for a right-to-left lesson (ADR-0051): the
 * same layout, mirrored at the door, so a Persian board fills from its
 * right margin and its columns walk left.
 */
describe('Layout direction', () => {
  it('mirrors flow placement, columns and note slots for rtl, and keeps refs consistent', () => {
    const ltr = new Layout();
    const rtl = new Layout({ direction: 'rtl' });
    const a = ltr.place({ w: 300, h: 40, place: 'flow' });
    const b = rtl.place({ w: 300, h: 40, place: 'flow' });
    expect(a.x).toBe(MARGIN);
    expect(b.x + b.w).toBe(PAGE_W - MARGIN);
    expect(b.y).toBe(a.y);
    // A second item on the same line walks the other way.
    const a2 = ltr.place({ w: 100, h: 40, place: 'flow' });
    const b2 = rtl.place({ w: 100, h: 40, place: 'flow' });
    expect(a2.x).toBeGreaterThan(a.x + a.w);
    expect(b2.x + b2.w).toBeLessThan(b.x);
    // Relative placement reads the ref in the same mirrored space it was registered in.
    rtl.register('r', b);
    const beside = rtl.place({ w: 80, h: 40, place: 'beside', ref: 'r' });
    expect(beside.x + beside.w).toBeLessThanOrEqual(b.x);
    expect(rtl.boundsOf('r')).toEqual(b);
    // The note column is the trailing one: the left for rtl.
    const slot = rtl.noteSlot(300, 120);
    expect(slot.x).toBe(MARGIN);
    // The direction can change mid-lesson without moving what is on the page.
    rtl.setDirection('ltr');
    const c = rtl.place({ w: 120, h: 40, place: 'newline' });
    expect(c.x).toBe(MARGIN);
  });
});
