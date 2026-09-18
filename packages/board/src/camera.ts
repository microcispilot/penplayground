import type { EditorLike } from './editor-like.js';
import { type Bounds, clamp, contains, union } from './geometry.js';
import { CAMERA_MS } from './pacing.js';
import { TYPE } from './shapes/props.js';

/**
 * Keeps the hand in view. After content is placed, if its bounds fall outside
 * the viewport the camera eases (550 ms, design token --duration-scene) to a
 * framing that keeps recent context when it fits.
 *
 * The camera is the only thing that may adapt to the screen. The page geometry
 * is fixed by contract — every client renders the same recording identically
 * (ADR-0002), and replay and export depend on it — so a phone gets the same
 * board as a desktop, framed differently: a smaller inset, and a zoom that is
 * never tighter than what actually fits. `minZoom` still decides how much
 * recent context is worth keeping, but it may not force content off the edge:
 * a line the learner cannot see is worse than one that is small.
 */
export interface CameraOptions {
  minZoom: number;
  maxZoom: number;
  /**
   * Floor on zoom, set by legibility rather than by layout. On a phone the page
   * is wider than the screen at any readable size, so the camera reads it like
   * a person would — at a size you can read, panning to follow the hand — and
   * never shrinks a lesson to a thumbnail to make it fit.
   */
  minLegibleZoom: number;
  /** Screen-pixel inset around the framed bounds. */
  inset: number;
  durationMs: number;
  /** Slack (page units) before a move is considered necessary. */
  tolerance: number;
}

/**
 * The smallest the expert's handwriting may be drawn, in CSS pixels. Caveat is
 * a script face; below this it stops being reading and starts being squinting.
 */
export const MIN_HAND_PX = 15;

export const DEFAULT_CAMERA: CameraOptions = {
  minZoom: 0.6,
  maxZoom: 1.2,
  /** Never smaller than this, whatever it costs in visible width. */
  minLegibleZoom: MIN_HAND_PX / TYPE.writeFont,
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

  /**
   * The frame around the content, in screen pixels. A 96 px inset is breathing
   * room on a laptop and most of the screen on a phone, so it scales down with
   * the smaller edge and never grows past the configured value.
   */
  inset(): number {
    const s = this.screen();
    if (!s) return this.opts.inset;
    return clamp(Math.min(s.w, s.h) * 0.08, 10, this.opts.inset);
  }

  /** Zoom at which `b` fits the screen with the inset. */
  fitZoom(b: Bounds): number | null {
    const s = this.screen();
    if (!s) return null;
    const inset = this.inset();
    const availW = Math.max(1, s.w - inset * 2);
    const availH = Math.max(1, s.h - inset * 2);
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
    // Never zoom in past what fits (that is what cut the right-hand side off a
    // narrow screen), and never below what can be read.
    const targetZoom = clamp(fit, this.opts.minLegibleZoom, this.opts.maxZoom);
    this.editor.zoomToBounds(this.window(frame, targetZoom), {
      targetZoom,
      inset: this.inset(),
      animation: { duration: this.opts.durationMs },
      force: true,
    });
    return true;
  }

  /**
   * The part of `b` that actually fits on screen at `zoom`, anchored at its
   * leading edge. Framing the whole of something too wide would centre it and
   * cut the start of every line; a reader wants the beginning.
   */
  private window(b: Bounds, zoom: number): Bounds {
    const s = this.screen();
    if (!s) return b;
    const inset = this.inset();
    const w = Math.max(1, s.w - inset * 2) / zoom;
    const h = Math.max(1, s.h - inset * 2) / zoom;
    return { x: b.x, y: b.y, w: Math.min(b.w, w), h: Math.min(b.h, h) };
  }

  /** Frame a whole page area (used by `newpage` and on mount). */
  showPage(area: Bounds, animate = true): void {
    const fit = this.fitZoom(area);
    if (fit === null) return;
    const targetZoom = clamp(fit, this.opts.minLegibleZoom, this.opts.maxZoom);
    this.editor.zoomToBounds(this.window(area, targetZoom), {
      targetZoom,
      inset: this.inset() * 0.5,
      ...(animate ? { animation: { duration: this.opts.durationMs } } : {}),
      force: true,
    });
  }
}
