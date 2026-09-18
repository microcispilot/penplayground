import { describe, expect, it } from 'vitest';
import { CameraDirector, DEFAULT_CAMERA } from '../src/camera.js';
import type { CameraMove, EditorLike } from '../src/editor-like.js';
import type { Bounds } from '../src/geometry.js';
import { PAGE_H, PAGE_W } from '../src/layout.js';

/** An editor whose viewport is whatever the test says a screen is. */
function fakeEditor(screenW: number, screenH: number, zoom = 1) {
  const moves: Array<{ bounds: Bounds; opts: CameraMove }> = [];
  const editor: EditorLike = {
    createShapes() {},
    updateShapes() {},
    deleteShapes() {},
    getShapePageBounds: () => undefined,
    // Page-space viewport is the screen divided by the zoom.
    getViewportPageBounds: () => ({ x: 0, y: 0, w: screenW / zoom, h: screenH / zoom }),
    getZoomLevel: () => zoom,
    zoomToBounds(bounds, opts) {
      moves.push({ bounds, opts });
    },
    run(fn) {
      fn();
    },
  };
  return { editor, moves };
}

const page: Bounds = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };

describe('CameraDirector on small screens', () => {
  it('shrinks the inset with the screen, and caps it on a big one', () => {
    const big = new CameraDirector(fakeEditor(2560, 1440).editor);
    const laptop = new CameraDirector(fakeEditor(1024, 768).editor);
    const phone = new CameraDirector(fakeEditor(390, 700).editor);
    // Capped at the configured frame however much screen there is.
    expect(big.inset()).toBe(96);
    expect(laptop.inset()).toBeCloseTo(768 * 0.08, 5);
    // A phone cannot afford a 96 px frame on a 390 px screen.
    expect(phone.inset()).toBeLessThan(40);
    expect(phone.inset()).toBeGreaterThanOrEqual(10);
  });

  it('fits a whole page on a wide screen without cutting it off', () => {
    for (const [w, h] of [
      [1440, 900],
      [1024, 768],
    ] as const) {
      const { editor, moves } = fakeEditor(w, h);
      const camera = new CameraDirector(editor);
      camera.showPage(page, false);
      const move = moves.at(-1);
      const zoom = move?.opts.targetZoom ?? 0;
      expect(zoom).toBeGreaterThanOrEqual(DEFAULT_CAMERA.minLegibleZoom);
      expect(PAGE_W * zoom).toBeLessThanOrEqual(w + 1);
    }
  });

  it('keeps the writing readable on a phone and frames what fits, from its left edge', () => {
    const { editor, moves } = fakeEditor(390, 844);
    const camera = new CameraDirector(editor);
    // A full-width line of writing, off the current viewport.
    camera.follow({ x: 0, y: 2000, w: PAGE_W, h: 120 });
    const move = moves.at(-1);
    const zoom = move?.opts.targetZoom ?? 0;
    // Readable rather than shrunk to fit: 36-unit handwriting stays >= 15 px.
    expect(zoom).toBeGreaterThanOrEqual(DEFAULT_CAMERA.minLegibleZoom);
    expect(36 * zoom).toBeGreaterThanOrEqual(15 - 1e-9);
    // And the framed window starts where the line starts, so no word is cut off the front.
    expect(move?.bounds.x).toBe(0);
    expect(move?.bounds.w ?? 0).toBeLessThan(PAGE_W);
  });

  it('never zooms in past what fits, which is what cut lines off a narrow screen', () => {
    const { editor, moves } = fakeEditor(700, 500);
    const camera = new CameraDirector(editor);
    camera.follow({ x: 0, y: 2000, w: 1200, h: 120 });
    const zoom = moves.at(-1)?.opts.targetZoom ?? 0;
    // Below the old 0.6 floor — and that is the point.
    expect(zoom).toBeLessThan(0.6);
    expect(1200 * zoom).toBeLessThanOrEqual(700);
  });

  it('still refuses to zoom past the maximum on a big screen with small content', () => {
    const { editor, moves } = fakeEditor(1920, 1080);
    const camera = new CameraDirector(editor);
    camera.follow({ x: 0, y: 5000, w: 40, h: 20 });
    expect(moves.at(-1)?.opts.targetZoom).toBe(1.2);
  });
});
