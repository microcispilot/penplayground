import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { cn } from '../cn.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** 'on' tints the control with the presence colour (mic live, captions on). */
  state?: 'default' | 'on' | 'warn';
  size?: number;
}

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
      className={cn(
        // Sized through a custom property, not an inline style, so a caller can
        // grow the control on a phone and shrink it on a wide screen with a
        // class (an inline style would always win over the breakpoint).
        'grid size-[var(--icon-size)] shrink-0 place-items-center rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-accent',
        state === 'default' && 'bg-surface text-fg hairline hover:bg-surface-2',
        state === 'on' && 'bg-presence-soft text-presence shadow-[0_0_0_1px_var(--color-presence)]',
        state === 'warn' && 'bg-warm-soft text-warm shadow-[0_0_0_1px_var(--color-warm)]',
        className,
      )}
      style={{ '--icon-size': `${size}px` } as CSSProperties}
      {...rest}
    >
      {children}
    </button>
  );
}
