import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

/**
 * M3's outlined text field.
 *
 *   @material/web tokens/versions/v0_192/_md-comp-outlined-text-field.scss
 *     shape `corner-extra-small` (4 px), outline 1 px `outline`, focused 2 px
 *     `primary`, caret `primary`, input `body-large`, label and supporting
 *     text `body-small` in `on-surface-variant`, error in `error`.
 *
 * Four pixels of corner beside a fully round button is not an accident: M3
 * gives a field a quiet, almost square container precisely so the controls
 * around it read as the things you press.
 */
export function TextField({
  label,
  hint,
  error,
  leading,
  trailing,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const inputId = id ?? rest.name ?? undefined;
  return (
    <label className={cn('flex flex-col gap-1.5', className)} htmlFor={inputId}>
      {label ? <span className="text-body-small text-on-surface-variant">{label}</span> : null}
      <span
        className={cn(
          // 40 px, not M3's 56: M3 sizes the container to hold a floating
          // label inside it, and this field renders its label above. 40 is
          // the same height as a `size="md"` button, so a field and the
          // button beside it line up.
          'flex h-10 items-center gap-2 rounded-xs bg-transparent px-4 transition-shadow',
          'shadow-[0_0_0_1px_var(--color-outline)] focus-within:shadow-[0_0_0_2px_var(--color-primary)]',
          error && 'shadow-[0_0_0_1px_var(--color-error)]',
        )}
      >
        {leading ? <span className="text-on-surface-variant">{leading}</span> : null}
        <input
          id={inputId}
          className="min-w-0 flex-1 bg-transparent text-body-large text-on-surface caret-primary outline-none placeholder:text-on-surface-dim"
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {trailing}
      </span>
      {error ? (
        <span className="text-body-small text-error">{error}</span>
      ) : hint ? (
        <span className="text-body-small text-on-surface-variant">{hint}</span>
      ) : null}
    </label>
  );
}
