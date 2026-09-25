import { Rectangle2d, ShapeUtil, type TLShape } from 'tldraw';
import './augment.js';
import type { Emphasis } from '@pen/contracts';

/**
 * Shared behaviour for every board shape: the expert's ink is not something a
 * viewer edits, resizes, rotates, binds arrows to, or snaps against. Each
 * shape's geometry is its `w × h` box.
 */
export abstract class PaperShapeUtil<
  S extends TLShape & { props: { w: number; h: number } },
> extends ShapeUtil<S> {
  override canEdit(): boolean {
    return false;
  }
  override canResize(): boolean {
    return false;
  }
  override canBind(): boolean {
    return false;
  }
  override canSnap(): boolean {
    return false;
  }
  override hideRotateHandle(): boolean {
    return true;
  }
  override hideResizeHandles(): boolean {
    return true;
  }
  override hideSelectionBoundsFg(): boolean {
    return true;
  }
  override isAspectRatioLocked(): boolean {
    return true;
  }
  override getGeometry(shape: S): Rectangle2d {
    return new Rectangle2d({
      width: Math.max(1, shape.props.w),
      height: Math.max(1, shape.props.h),
      isFilled: true,
    });
  }
  /** No selection indicator: the expert's ink is never selected by viewers. */
  getIndicatorPath(): undefined {
    return undefined;
  }
}

/** Ink colour token for an emphasis. Components never use raw colour values (ADR-0007). */
export function inkVar(emphasis: Emphasis): string {
  switch (emphasis) {
    case 'accent':
      return 'var(--color-ink-accent)';
    case 'warn':
      return 'var(--color-ink-warn)';
    case 'muted':
      return 'var(--color-ink-muted)';
    default:
      return 'var(--color-ink)';
  }
}

/**
 * Every emphasis is written in the chalk or marker the learner chose (the
 * owner, 2026-09-25: "the rest should stay exactly as the selected colour").
 * Emphasis still shapes the writing — size, underline, weight — never its
 * colour; only code takes an editor's colours (highlight.ts).
 */
const TOKEN: Record<Emphasis, string> = {
  ink: '--color-ink',
  accent: '--color-ink',
  warn: '--color-ink',
  muted: '--color-ink',
};

/**
 * Resolve an ink token to a concrete colour for SVG export (exports are
 * rasterised outside the page's cascade). Falls back to navy ink.
 */
export function resolveInk(container: HTMLElement | null, emphasis: Emphasis): string {
  if (container && typeof getComputedStyle === 'function') {
    const v = getComputedStyle(container).getPropertyValue(TOKEN[emphasis]).trim();
    if (v) return v;
  }
  // One ink for every emphasis, so an export matches the board.
  return '#1B2B3F';
}

/**
 * How a highlighter or an underline blends with what is under it.
 *
 * `multiply` is what a marker does on white paper: it can only darken. On a
 * dark board that is the same as painting nothing, because the stroke is
 * already lighter than the ground — the mark simply vanishes. `screen` is the
 * inverse and is what chalk over chalk does.
 *
 * Two functions for the same reason `inkVar` and `resolveInk` are two: the
 * live board reads the cascade, and an SVG export is rasterised outside it and
 * needs the value already resolved.
 */
export function markerBlendVar(): string {
  return 'var(--board-marker-blend)';
}

/** The blend as a concrete value, for export. Falls back to the paper answer. */
export function resolveMarkerBlend(container: HTMLElement | null): string {
  if (container && typeof getComputedStyle === 'function') {
    const v = getComputedStyle(container).getPropertyValue('--board-marker-blend').trim();
    if (v) return v;
  }
  return 'multiply';
}

export const EMPHASIS_VALUES = ['ink', 'accent', 'warn', 'muted'] as const;
