import type { Bounds } from './geometry.js';

/**
 * The tiny slice of tldraw's Editor the executor depends on. Keeping it this
 * small is what makes the executor testable with a fake and the engine
 * swappable (ADR-0005: nothing outside packages/board imports tldraw, and
 * inside it only the adapter and the shape utils do).
 */

export interface ShapeRecordInit {
  /** Full tldraw id, i.e. `shape:<…>`. */
  id: string;
  type: string;
  x: number;
  y: number;
  props: Record<string, unknown>;
  opacity?: number;
}

export interface ShapeRecordUpdate {
  id: string;
  type: string;
  x?: number;
  y?: number;
  props?: Record<string, unknown>;
  opacity?: number;
}

export interface CameraMove {
  targetZoom?: number;
  inset?: number;
  animation?: { duration: number };
  /** Move even though user camera control is locked. */
  force?: boolean;
}

export interface EditorLike {
  createShapes(shapes: ShapeRecordInit[]): void;
  updateShapes(shapes: ShapeRecordUpdate[]): void;
  deleteShapes(ids: string[]): void;
  getShapePageBounds(id: string): Bounds | undefined;
  getViewportPageBounds(): Bounds;
  getZoomLevel(): number;
  zoomToBounds(bounds: Bounds, opts: CameraMove): void;
  /** Batch several store writes into one transaction, outside undo history. */
  run(fn: () => void, opts?: { history?: 'ignore' }): void;
}

export const SHAPE_ID_PREFIX = 'shape:';

export function toShapeId(id: string): string {
  return id.startsWith(SHAPE_ID_PREFIX) ? id : `${SHAPE_ID_PREFIX}${id}`;
}
