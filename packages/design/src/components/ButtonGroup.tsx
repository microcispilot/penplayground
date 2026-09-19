import { Check } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn.js';

/**
 * A connected button group (M3 Expressive).
 *
 * Buttons that belong to one decision stop being separate objects: they sit in
 * one run, the outer ends keep `corner-full`, the joins soften to
 * `corner-small`, and a 2 px seam keeps each target its own. The children are
 * ordinary `<Button>`s — the group only re-shapes them, so every prop, handler
 * and `data-testid` on them is untouched.
 */
export function ButtonGroup({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups arbitrary buttons, and role="group" is the ARIA pattern M3's connected button group uses
    <div
      role="group"
      className={cn(
        'inline-flex items-stretch gap-0.5',
        '[&>*]:rounded-sm',
        '[&>*:first-child]:rounded-s-full [&>*:last-child]:rounded-e-full',
        '[&>*:only-child]:rounded-full',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Spoken label, when the visible one is a shorthand. */
  title?: string;
  'data-testid'?: string;
}

export interface SegmentedButtonsProps<T extends string> {
  /** Names the group for assistive technology ("Pace", "Billing period"). */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Hide the M3 check that marks the chosen segment (tight rows). */
  checkmark?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * M3's outlined segmented button — the "Going / Not going / Maybe" control.
 *
 *   @material/web tokens/versions/v0_192/_md-comp-outlined-segmented-button.scss
 *     height 40, shape `corner-full`, 1 px `outline`, label `label-large`,
 *     selected container `secondary-container` with `on-secondary-container`,
 *     unselected label `on-surface`.
 *
 * One outline around the whole run, hairlines between the segments, and the
 * chosen one filled rather than merely coloured — so the answer is legible
 * without relying on hue.
 */
export function SegmentedButtons<T extends string>({
  label,
  options,
  value,
  onChange,
  checkmark = true,
  className,
  'data-testid': testId,
}: SegmentedButtonsProps<T>) {
  return (
    <fieldset
      aria-label={label}
      data-testid={testId}
      className={cn(
        'm-0 inline-flex h-10 min-w-0 items-stretch overflow-hidden rounded-full border border-outline p-0',
        className,
      )}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: M3's segmented button is a button that answers as a radio; a native radio input cannot carry the leading check and the container fill the spec gives the chosen segment
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title ?? option.label}
            data-testid={option['data-testid']}
            onClick={() => onChange(option.value)}
            className={cn(
              'state-layer flex min-w-0 flex-auto items-center justify-center gap-2 px-4 text-label-large transition-colors duration-[var(--duration-fast)]',
              i > 0 && 'border-s border-outline',
              selected
                ? 'bg-secondary-container text-on-secondary-container'
                : 'bg-transparent text-on-surface',
            )}
          >
            {checkmark && selected ? <Check size={16} aria-hidden className="shrink-0" /> : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
