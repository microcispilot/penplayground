import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'neutral' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
}

/**
 * M3 buttons, Expressive shapes.
 *
 * Every button is a true pill (`corner-full`) at every size, which is the one
 * thing the Expressive sheet says loudest. The four variants map onto M3's
 * own: filled, outlined, text, and filled-with-error.
 *
 *   @material/web tokens/versions/v0_192/_md-comp-filled-button.scss
 *     container `primary`, label `on-primary`, shape `corner-full`,
 *     label type `label-large`.
 *   …/_md-comp-outlined-button.scss   1 px `outline`, label `primary`.
 *   …/_md-comp-text-button.scss       no container, label `primary`.
 *
 * Hover, focus and press are M3 state layers rather than second colours: the
 * button lays its own label colour over itself at 8 % / 12 % / 12 %
 * (`state-layer`, defined in styles/index.css from _md-sys-state.scss).
 */
const base =
  'state-layer inline-flex items-center justify-center gap-2 whitespace-nowrap select-none rounded-full transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] disabled:opacity-disabled disabled:cursor-not-allowed active:scale-[0.985]';

/**
 * `primary` fills in `primary-fixed`, not `primary`: a filled button is one of
 * the surfaces that carries the brand, and the brand is the one hex that does
 * not change between themes (tokens.css, "The brand red, in M3's two halves").
 * `primary` itself stays the toned role, for the label of a text or outlined
 * button, where it has to clear 4.5:1 against the page.
 */
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary-fixed text-on-primary-fixed',
  secondary: 'bg-transparent text-primary border border-outline',
  ghost: 'bg-transparent text-primary',
  // M3's filled-tonal button. For an action that is decisive but not a
  // mistake — ending a session you meant to end — which is why it is not
  // `danger`: this product does not paint ordinary states in alarm colours.
  neutral: 'bg-surface-container-highest text-on-surface',
  danger: 'bg-error text-on-error',
};

/**
 * M3 Expressive button heights: extra-small 32, small 40, medium 56. Leading
 * and trailing space grows with them (12 / 16 / 24 px), and the label steps
 * from `label-large` to `title-medium` at the largest size — never to a
 * display or headline role, which is what made the old buttons shout.
 */
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-label-large',
  md: 'h-10 px-4 text-label-large',
  lg: 'h-14 px-6 text-title-medium',
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
        'inline-block animate-spin rounded-full border-2 border-outline-variant border-t-primary',
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
