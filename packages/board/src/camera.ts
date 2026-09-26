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
  /** Which edge the page hangs from when the screen is wider than it (ADR-0051). */
  direction: 'ltr' | 'rtl';
  /** Screen-pixel inset around the framed bounds. */
  inset: number;
  durationMs: number;
  /** Slack (page units) before a move is considered necessary. */
  tolerance: number;
}

/**
 * The smallest the expert's handwriting may be drawn, in CSS pixels. Below
 * this it stops being reading and starts being squinting. Set against the
 * type scale (ADR-0051): with the writing at 24 world units this floor is a
 * zoom of 0.58, which still lets a 1200-wide line fit a 700-wide phone.
 */
export const MIN_HAND_PX = 14;

export const DEFAULT_CAMERA: CameraOptions = {
  minZoom: 0.6,
  maxZoom: 1.2,
  /** Never smaller than this, whatever it costs in visible width. */
  minLegibleZoom: MIN_HAND_PX / TYPE.writeFont,
  direction: 'ltr',
  inset: 96,
  durationMs: CAMERA_MS,
  tolerance: 8,
};

export class CameraDirector {
  opts: CameraOptions;

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
    /*
     * A page is a frame (ADR-0051): once a page has been shown, the camera
     * keeps the whole of it on screen at whatever zoom the screen allows —
     * the way a video shows its whole frame in a small box and a big one —
     * and follows only what leaves the page. This comes before "is the
     * target already on screen": at mount the zoom is 1 and the first line
     * sits inside that small viewport, which is exactly when the page is
     * not yet framed. Cropping the page to keep the writing at a readable
     * size was what hid the bottom of a board in the inline player; a reader
     * who wants it larger makes the box larger.
     */
    const page = this.page;
    if (page && contains(page, target, this.opts.tolerance)) {
      if (contains(vp, page, this.opts.tolerance)) return false;
      this.showPage(page, true);
      return true;
    }
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

  /** The page the camera is keeping in frame; null until one has been shown. */
  private page: Bounds | null = null;

  /**
   * Frame a whole page area (used by `newpage` and on mount): the page fits,
   * whatever the screen, and hangs from its leading edge — the left for
   * left-to-right writing, the right for right-to-left — with the spare
   * board on the trailing side. Centring a page narrower than the screen put
   * the first word of every line near the middle.
   *
   * The page sits flush with the screen's edge: no inset. Its own margin
   * (`layout.MARGIN`) is the padding before the first word, and it used to
   * arrive on top of half the camera inset, which is where the owner saw "a
   * lot of spaces on the top" (2026-09-25).
   */
  showPage(area: Bounds, animate = true): void {
    this.page = area;
    const s = this.screen();
    if (!s) return;
    const fit = Math.min(s.w / Math.max(1, area.w), s.h / Math.max(1, area.h));
    const targetZoom = Math.min(fit, this.opts.maxZoom);
    const w = Math.max(1, s.w) / targetZoom;
    const h = Math.max(1, s.h) / targetZoom;
    const x = this.opts.direction === 'rtl' ? area.x + area.w - w : area.x;
    this.editor.zoomToBounds(
      { x, y: area.y, w, h },
      {
        targetZoom,
        inset: 0,
        ...(animate ? { animation: { duration: this.opts.durationMs } } : {}),
        force: true,
      },
    );
  }

  /** The screen changed size (a box grew, a phone turned): the same page, framed again. */
  refit(): void {
    if (this.page) this.showPage(this.page, false);
  }

  setDirection(direction: 'ltr' | 'rtl'): void {
    if (this.opts.direction === direction) return;
    this.opts = { ...this.opts, direction };
    this.refit();
  }
}
