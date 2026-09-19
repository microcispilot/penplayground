import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** 'on' tints the control with the presence colour (mic live, captions on). */
  state?: 'default' | 'on' | 'warn';
  size?: number;
}

/**
 * M3 icon buttons: `corner-full`, one state layer, and a tonal container when
 * the control is *on* rather than a second stroke colour.
 *
 *   @material/web tokens/versions/v0_192/_md-comp-outlined-icon-button.scss
 *     1 px `outline`, icon `on-surface-variant`, shape `corner-full`.
 *   …/_md-comp-filled-tonal-icon-button.scss
 *     container + on-container pair for the selected state.
 *
 * `data-state` is what `IconButtonGroup` reads to flatten the resting buttons
 * into a shared toolbar without touching the ones that are lit.
 */
export function IconButton({
  label,
  state = 'default',
  size = 32,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={state === 'on' ? true : undefined}
      data-state={state}
      className={cn(
        // Sized through a custom property, not an inline style, so a caller can
        // grow the control on a phone and shrink it on a wide screen with a
        // class (an inline style would always win over the breakpoint).
        'state-layer grid size-[var(--icon-size)] shrink-0 place-items-center rounded-full transition-colors duration-[var(--duration-fast)]',
        state === 'default' && 'bg-surface-container-low text-on-surface-variant hairline',
        state === 'on' && 'bg-presence-container text-on-presence-container',
        state === 'warn' && 'bg-warm-container text-on-warm-container',
        className,
      )}
      style={{ '--icon-size': `${size}px` } as CSSProperties}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface IconButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Names the toolbar for assistive technology ("Room controls"). */
  label?: string;
  children: ReactNode;
}

/**
 * The Expressive icon-button toolbar: one rounded container holding a run of
 * icon buttons, each of which drops its own fill and edge so the container
 * carries them. A button that is lit — a live microphone, a warning — keeps
 * its tonal container, which is the only thing that should stand out in a row
 * of controls.
 */
export function IconButtonGroup({ label, className, children, ...rest }: IconButtonGroupProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface-container p-1',
        // Descendant, not child: a control may bring its own wrapper (a menu,
        // a picker) and still belongs to the toolbar.
        '[&_[data-state="default"]]:bg-transparent [&_[data-state="default"]]:shadow-none',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
