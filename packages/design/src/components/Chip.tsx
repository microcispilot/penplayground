import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/**
 * M3's filter chip (Home → "Most learned").
 *
 *   @material/web tokens/versions/v0_192/_md-comp-filter-chip.scss
 *     height 32, shape `corner-small` (8 px), label `label-large`,
 *     unselected: 1 px `outline-variant` with an `on-surface-variant` label,
 *     selected: `secondary-container` with `on-secondary-container`.
 *
 * Filled when chosen rather than merely tinted: the answer to "which filter is
 * on?" should not depend on reading a hue. The corner stays `corner-small` —
 * a pill at this size reads as a tag, not as a control.
 */
export function Chip({ selected = false, className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'state-layer h-8 shrink-0 rounded-sm px-3 text-label-large whitespace-nowrap transition-colors duration-[var(--duration-fast)]',
        selected
          ? 'bg-secondary-container text-on-secondary-container'
          : 'bg-transparent text-on-surface-variant hairline',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
