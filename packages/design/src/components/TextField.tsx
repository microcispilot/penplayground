import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

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
      {label ? <span className="text-xs font-medium text-fg-2">{label}</span> : null}
      <span
        className={cn(
          'flex h-10 items-center gap-2 rounded-[var(--radius-md)] bg-surface px-3 hairline transition-shadow focus-within:shadow-[0_0_0_2px_var(--color-accent)]',
          error && 'shadow-[0_0_0_1px_var(--color-danger)]',
        )}
      >
        {leading ? <span className="text-fg-3">{leading}</span> : null}
        <input
          id={inputId}
          className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-3 outline-none caret-accent"
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {trailing}
      </span>
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs text-fg-3">{hint}</span>
      ) : null}
    </label>
  );
}
