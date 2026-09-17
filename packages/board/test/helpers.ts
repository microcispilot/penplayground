import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BoardEvent } from '@pen/contracts';
import type {
  CameraMove,
  EditorLike,
  ShapeRecordInit,
  ShapeRecordUpdate,
} from '../src/editor-like.js';
import { type HandFont, parseHandFont } from '../src/font.js';
import type { Bounds } from '../src/geometry.js';

const require = createRequire(import.meta.url);

let cached: HandFont | null = null;
/** The same Caveat WOFF the browser loads, read from disk. */
export function loadTestFont(): HandFont {
  if (cached) return cached;
  const path = require.resolve('@fontsource/caveat/files/caveat-latin-400-normal.woff');
  cached = parseHandFont(readFileSync(path));
  return cached;
}

export function boardOp(
  id: string,
  partial: Partial<Omit<BoardEvent, 'type' | 'id'>> & Pick<BoardEvent, 'op'>,
): BoardEvent {
  return {
    type: 'board',
    id,
    anchor: 'now',
    text: '',
    lang: '',
    ref: '',
    ref2: '',
    place: 'flow',
    emphasis: 'ink',
    ...partial,
  };
}

export interface FakeShape {
  id: string;
  type: string;
  x: number;
  y: number;
  opacity: number;
  props: Record<string, unknown>;
}

/** In-memory EditorLike that records every call; bounds come from `props.w/h`. */
export class FakeEditor implements EditorLike {
  readonly shapes = new Map<string, FakeShape>();
  readonly cameraMoves: Array<{ bounds: Bounds; opts: CameraMove }> = [];
  readonly log: string[] = [];
  viewport: Bounds = { x: 0, y: 0, w: 1600, h: 1000 };
  zoom = 1;
  updateCount = 0;

  createShapes(shapes: ShapeRecordInit[]): void {
    for (const s of shapes) {
      if (this.shapes.has(s.id)) throw new Error(`duplicate shape id ${s.id}`);
      this.shapes.set(s.id, {
        id: s.id,
        type: s.type,
        x: s.x,
        y: s.y,
        opacity: s.opacity ?? 1,
        props: { ...s.props },
      });
      this.log.push(`create ${s.type} ${s.id}`);
    }
  }
  updateShapes(shapes: ShapeRecordUpdate[]): void {
    this.updateCount += 1;
    for (const u of shapes) {
      const s = this.shapes.get(u.id);
      if (!s) throw new Error(`update of unknown shape ${u.id}`);
      if (u.x !== undefined) s.x = u.x;
      if (u.y !== undefined) s.y = u.y;
      if (u.opacity !== undefined) s.opacity = u.opacity;
      if (u.props) Object.assign(s.props, u.props);
    }
  }
  deleteShapes(ids: string[]): void {
    for (const id of ids) {
      this.shapes.delete(id);
      this.log.push(`delete ${id}`);
    }
  }
  getShapePageBounds(id: string): Bounds | undefined {
    const s = this.shapes.get(id);
    if (!s) return undefined;
    return { x: s.x, y: s.y, w: Number(s.props.w ?? 0), h: Number(s.props.h ?? 0) };
  }
  getViewportPageBounds(): Bounds {
    return { ...this.viewport };
  }
  getZoomLevel(): number {
    return this.zoom;
  }
  zoomToBounds(bounds: Bounds, opts: CameraMove): void {
    this.cameraMoves.push({ bounds, opts });
    const z = opts.targetZoom ?? this.zoom;
    this.zoom = z;
    const w = 1600 / z;
    const h = 1000 / z;
    this.viewport = {
      x: bounds.x + bounds.w / 2 - w / 2,
      y: bounds.y + bounds.h / 2 - h / 2,
      w,
      h,
    };
  }
  run(fn: () => void): void {
    fn();
  }

  progress(id: string): number {
    return Number(this.shapes.get(id)?.props.progress ?? Number.NaN);
  }
  ofType(type: string): FakeShape[] {
    return [...this.shapes.values()].filter((s) => s.type === type);
  }
}

/** Let queued microtasks (the executor's prepare queue) settle. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}
