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
        // A filter reads as a control, not as a run of words: each one carries
        // its own fill and edge whether or not it is the chosen one, and the
        // corner is nearly square — a pill at this size looked like a tag.
        'h-8 shrink-0 whitespace-nowrap rounded-[4px] px-3 text-xs font-medium transition-colors duration-[var(--duration-fast)]',
        selected ? 'bg-fg text-bg' : 'bg-surface-2 text-fg hairline hover:bg-line-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
