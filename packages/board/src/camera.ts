import { type Bounds, clamp, contains, union } from './geometry.js';
import type { EditorLike } from './editor-like.js';
import { CAMERA_MS } from './pacing.js';

/**
 * Keeps the hand in view. After content is placed, if its bounds fall outside
 * the viewport the camera eases (550 ms, design token --duration-scene) to a
 * framing that keeps recent context when it fits, staying between 0.6× and
 * 1.2× zoom so writing never becomes unreadably small or absurdly large.
 * Viewers never fight this: user camera control is locked on the Board.
 */
export interface CameraOptions {
  minZoom: number;
  maxZoom: number;
  /** Screen-pixel inset around the framed bounds. */
  inset: number;
  durationMs: number;
  /** Slack (page units) before a move is considered necessary. */
  tolerance: number;
}

export const DEFAULT_CAMERA: CameraOptions = {
  minZoom: 0.6,
  maxZoom: 1.2,
  inset: 96,
  durationMs: CAMERA_MS,
  tolerance: 8,
};

export class CameraDirector {
  readonly opts: CameraOptions;

  constructor(
    private readonly editor: EditorLike,
    opts: Partial<CameraOptions> = {},
  ) {
    this.opts = { ...DEFAULT_CAMERA, ...opts };
  }

  /** Screen size in CSS px derived from the page-space viewport and zoom. */
  private screen(): { w: number; h: number } | null {
    const vp = this.editor.getViewportPageBounds();
    const z = this.editor.getZoomLevel();
    if (!(vp.w > 0) || !(vp.h > 0) || !(z > 0)) return null;
    return { w: vp.w * z, h: vp.h * z };
  }

  /** Zoom at which `b` fits the screen with the inset. */
  fitZoom(b: Bounds): number | null {
    const s = this.screen();
    if (!s) return null;
    const availW = Math.max(1, s.w - this.opts.inset * 2);
    const availH = Math.max(1, s.h - this.opts.inset * 2);
    return Math.min(availW / Math.max(1, b.w), availH / Math.max(1, b.h));
  }

  /**
   * Ensure `target` is visible. `context` are recent bounds worth keeping on
   * screen if they fit at ≥ minZoom. Returns true when the camera moved.
   */
  follow(target: Bounds, context: readonly Bounds[] = []): boolean {
    const vp = this.editor.getViewportPageBounds();
    if (!(vp.w > 0) || !(vp.h > 0)) return false;
    if (contains(vp, target, this.opts.tolerance)) return false;

    let frame = target;
    const withContext = union([...context, target]);
    if (withContext) {
      const z = this.fitZoom(withContext);
      if (z !== null && z >= this.opts.minZoom) frame = withContext;
    }
    const fit = this.fitZoom(frame);
    if (fit === null) return false;
    const targetZoom = clamp(fit, this.opts.minZoom, this.opts.maxZoom);
    this.editor.zoomToBounds(frame, {
      targetZoom,
      inset: this.opts.inset,
      animation: { duration: this.opts.durationMs },
      force: true,
    });
    return true;
  }

  /** Frame a whole page area (used by `newpage` and on mount). */
  showPage(area: Bounds, animate = true): void {
    const fit = this.fitZoom(area);
    if (fit === null) return;
    const targetZoom = clamp(fit, this.opts.minZoom, this.opts.maxZoom);
    this.editor.zoomToBounds(area, {
      targetZoom,
      inset: this.opts.inset * 0.5,
      ...(animate ? { animation: { duration: this.opts.durationMs } } : {}),
      force: true,
    });
  }
}
