import { formatPace, PACE_PRESETS } from '@pen/contracts';
import { cn } from '@pen/design';
import { Check, ChevronUp } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';

export interface PaceMenuProps {
  value: number;
  onChange: (pace: number) => void;
  /** Guests: the pill is shown but inert, with the reason as a tooltip. */
  disabled?: boolean;
  disabledReason?: string;
  /** "Pace" (a live room) or "Speed" (a replay): the accessible name and the menu heading. */
  label?: string;
  /** What each preset feels like; shown beside the number. */
  describe?: (pace: number) => string;
  className?: string;
}

/** How a preset feels when teaching live. */
export function describeTeachingPace(pace: number): string {
  if (pace <= 0.75) return 'Unhurried';
  if (pace <= 0.9) return 'Relaxed';
  if (pace < 1.1) return 'Teacher’s pace';
  if (pace <= 1.15) return 'Brisk';
  return 'Quick';
}

/** How a preset feels when watching a replay. */
export function describeReplayRate(rate: number): string {
  if (rate < 1) return 'Slower';
  if (rate === 1) return 'As recorded';
  return 'Faster';
}

/**
 * The pace control in the bottom bar: a "1×" pill that opens a menu of presets
 * (ADR-0010). Keyboard: Enter/Space/arrows open, arrows move, Enter/Space pick,
 * Escape closes and returns focus to the pill. Presets are toggle buttons
 * (`aria-pressed`) so a screen reader hears "1×, pressed".
 */
export function PaceMenu({
  value,
  onChange,
  disabled = false,
  disabledReason,
  label = 'Pace',
  describe = describeTeachingPace,
  className,
}: PaceMenuProps) {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const tipId = useId();
  const selectedIndex = Math.max(
    0,
    PACE_PRESETS.findIndex((p) => Math.abs(p - value) < 1e-6),
  );

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) pillRef.current?.focus();
  }, []);

  // Outside click / focus leaving the control closes it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onFocus = (e: FocusEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [open]);

  // Opening puts focus on the current preset so arrows start from it.
  useEffect(() => {
    if (open) optionRefs.current[selectedIndex]?.focus();
  }, [open, selectedIndex]);

  const onPillKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    const count = PACE_PRESETS.length;
    // A slot is null only while an option is unmounted; skipping those keeps a
    // null `activeElement` from matching an empty slot and moving focus nowhere.
    const active = document.activeElement;
    const focused = optionRefs.current.findIndex((el) => el !== null && el === active);
    const move = (to: number) => {
      e.preventDefault();
      optionRefs.current[(to + count) % count]?.focus();
    };
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        return;
      case 'ArrowDown':
        return move(focused + 1);
      case 'ArrowUp':
        return move(focused - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(count - 1);
      case 'Tab':
        setOpen(false);
        return;
      default:
        return;
    }
  };

  const pick = (pace: number) => {
    onChange(pace);
    close(true);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={pillRef}
        type="button"
        aria-label={`${label}: ${formatPace(value)}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && tip ? tipId : undefined}
        title={disabled ? disabledReason : `${label}: ${formatPace(value)}`}
        data-testid="pace-pill"
        data-state={open ? 'on' : 'default'}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        onKeyDown={onPillKey}
        onPointerEnter={() => setTip(true)}
        onPointerLeave={() => setTip(false)}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
        className={cn(
          'inline-flex h-8 min-w-[3.25rem] select-none items-center justify-center gap-1 rounded-full px-3 text-label-medium tabular transition-colors duration-[var(--duration-fast)]',
          disabled
            ? 'cursor-not-allowed bg-surface-container-low text-on-surface-dim opacity-60 hairline'
            : open
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-surface-container-low text-on-surface hairline hover:bg-surface-container-high',
        )}
      >
        <span>{formatPace(value)}</span>
        {!disabled ? (
          <ChevronUp
            size={12}
            aria-hidden
            className={cn(
              'text-on-surface-dim transition-transform duration-[var(--duration-fast)]',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      {disabled && disabledReason && tip ? (
        <div
          id={tipId}
          role="tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-[20] -translate-x-1/2 whitespace-nowrap rounded-sm bg-on-surface px-2.5 py-1.5 text-label-small text-surface shadow-level3 animate-rise"
        >
          {disabledReason}
        </div>
      ) : null}
      {open ? (
        <fieldset
          id={menuId}
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute right-0 bottom-[calc(100%+8px)] z-[20] m-0 w-[11.75rem] min-w-0 rounded-md border-0 bg-surface-container p-1 shadow-level3 hairline animate-rise"
        >
          <legend className="float-left w-full px-2.5 pt-1.5 pb-1 text-label-small font-medium tracking-widest text-on-surface-dim uppercase">
            {label}
          </legend>
          {PACE_PRESETS.map((preset, i) => {
            const selected = i === selectedIndex;
            return (
              <button
                key={preset}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                aria-pressed={selected}
                data-testid={`pace-option-${preset}`}
                onClick={() => pick(preset)}
                className={cn(
                  'state-layer flex h-8 w-full items-center gap-2 rounded-full px-3 text-left text-label-large transition-colors duration-[var(--duration-fast)]',
                  selected
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'text-on-surface',
                )}
              >
                <span className="w-10 font-medium tabular">{formatPace(preset)}</span>
                <span
                  className={cn(
                    'flex-1 text-body-small',
                    selected ? 'text-on-secondary-container' : 'text-on-surface-dim',
                  )}
                >
                  {describe(preset)}
                </span>
                {selected ? <Check size={14} aria-hidden /> : null}
              </button>
            );
          })}
        </fieldset>
      ) : null}
    </div>
  );
}
