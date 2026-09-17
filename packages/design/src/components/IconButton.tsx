import type { ButtonHTMLAttributes } from 'react';
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
        'grid place-items-center rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] focus-visible:outline-accent',
        state === 'default' && 'bg-surface text-fg hairline hover:bg-surface-2',
        state === 'on' && 'bg-presence-soft text-presence shadow-[0_0_0_1px_var(--color-presence)]',
        state === 'warn' && 'bg-warm-soft text-warm shadow-[0_0_0_1px_var(--color-warm)]',
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      {children}
    </button>
  );
}
