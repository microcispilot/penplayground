import type { Box, Editor, TLShapeId, TLShapePartial } from 'tldraw';
import type { CameraMove, EditorLike, ShapeRecordInit, ShapeRecordUpdate } from './editor-like.js';
import type { Bounds } from './geometry.js';

/**
 * The real EditorLike: a thin wrapper over tldraw's Editor. All casts from
 * the executor's untyped records to tldraw's TLShapePartial live here and
 * nowhere else. The shape utils validate props at write time, so a wrong
 * record fails loudly in development rather than rendering garbage.
 */
export function adaptEditor(editor: Editor): EditorLike {
  const toBounds = (b: Box | undefined): Bounds | undefined => (b ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined);
  return {
    createShapes(shapes: ShapeRecordInit[]) {
      editor.createShapes(shapes.map((s) => ({ ...s, id: s.id as TLShapeId }) as unknown as TLShapePartial));
    },
    updateShapes(shapes: ShapeRecordUpdate[]) {
      editor.updateShapes(shapes.map((s) => ({ ...s, id: s.id as TLShapeId }) as unknown as TLShapePartial));
    },
    deleteShapes(ids: string[]) {
      editor.deleteShapes(ids as TLShapeId[]);
    },
    getShapePageBounds(id: string) {
      return toBounds(editor.getShapePageBounds(id as TLShapeId));
    },
    getViewportPageBounds() {
      return toBounds(editor.getViewportPageBounds()) ?? { x: 0, y: 0, w: 0, h: 0 };
    },
    getZoomLevel() {
      return editor.getZoomLevel();
    },
    zoomToBounds(bounds: Bounds, opts: CameraMove) {
      editor.zoomToBounds(bounds, opts);
    },
    run(fn, opts) {
      editor.run(fn, opts?.history === 'ignore' ? { history: 'ignore' } : undefined);
    },
  };
}
