import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
}

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap select-none rounded-[var(--radius-md)] font-medium transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] disabled:opacity-45 disabled:cursor-not-allowed active:scale-[0.985]';
const variants: Record<ButtonVariant, string> = {
  // Not --color-accent: that tone under --color-on-accent measures 3.75:1, which
  // is fine for a stroke and below AA for the product's main call to action.
  primary:
    'bg-accent-strong text-on-accent hover:bg-accent-pressed shadow-[0_1px_0_oklch(1_0_0/12%)_inset]',
  secondary: 'bg-transparent text-fg hairline hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:brightness-110',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  leading,
  trailing,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : leading}
      {children}
      {trailing}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block rounded-full border-2 border-line-strong border-t-accent animate-spin',
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
