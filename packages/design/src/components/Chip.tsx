import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/** Category filter chip (Home → "Most learned"). */
export function Chip({ selected = false, className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'h-7 shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-3 text-xs font-medium transition-colors duration-[var(--duration-fast)]',
        selected ? 'bg-fg text-bg' : 'bg-surface-2 text-fg hover:bg-line-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
