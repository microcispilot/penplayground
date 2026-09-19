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

const TOKEN: Record<Emphasis, string> = {
  ink: '--color-ink',
  accent: '--color-ink-accent',
  warn: '--color-ink-warn',
  muted: '--color-ink-muted',
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
  switch (emphasis) {
    case 'accent':
      return '#E62117';
    case 'warn':
      // Amber, because the brand took red's hue: see tokens.css, --color-ink-warn.
      return '#8F3C00';
    case 'muted':
      return '#7A8494';
    default:
      return '#1B2B3F';
  }
}

export const EMPHASIS_VALUES = ['ink', 'accent', 'warn', 'muted'] as const;
