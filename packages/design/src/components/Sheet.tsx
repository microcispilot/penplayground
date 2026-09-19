import { type ReactNode, useId, useRef } from 'react';
import { cn } from '../cn.js';
import { useModalFocus } from '../modal-focus.js';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Named for assistive technology; render it visibly with `heading` when it helps. */
  title: string;
  /** Show the title as a visible heading inside the sheet. */
  heading?: boolean;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * A sheet that rises from the bottom edge: how a phone offers the controls a
 * wide screen has room to show at once. Escape closes it, a press outside
 * closes it, focus moves in on open and back to the opener on close, and the
 * page behind cannot be tabbed into while it is up.
 *
 * Deliberately not a native `<dialog>`: the room keeps painting behind the
 * sheet (the board is still being written on) and a modal dialog's top layer
 * would take the board's own overlays with it.
 */
export function Sheet({
  open,
  onClose,
  title,
  heading = true,
  children,
  className,
  'data-testid': testId,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useModalFocus(open, onClose, panelRef);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[40] flex flex-col justify-end" data-testid={testId}>
      <button
        type="button"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-scrim/45 [animation:rise_var(--duration-base)_var(--ease-out)_both]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          // M3 bottom sheet: `surface-container-low`, `corner-extra-large`
          // on the top edge only, elevation level 1 (the scrim does the rest).
          'relative max-h-[82vh] w-full animate-rise overflow-y-auto rounded-t-xl bg-surface-container-low px-3 pt-2 shadow-level1 outline-none',
          // Clears the home indicator on a phone and the bar on a tablet.
          'pb-[max(1rem,env(safe-area-inset-bottom))]',
          className,
        )}
      >
        <div className="mx-auto mt-1 mb-3 h-1 w-9 rounded-full bg-outline-variant" aria-hidden />
        <h2
          id={titleId}
          className={cn(
            'mb-2 px-1 text-label-small tracking-widest text-on-surface-dim uppercase',
            !heading && 'sr-only',
          )}
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** A full-width labelled row inside a sheet: the label a wide screen shows as a tooltip. */
export function SheetRow({
  label,
  hint,
  icon,
  onClick,
  pressed,
  disabled,
  'data-testid': testId,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      data-testid={testId}
      className={cn(
        // M3 list item inside a sheet: `corner-full` when it carries a
        // selection, `on-secondary-container` when it does.
        'state-layer flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-left transition-colors duration-[var(--duration-fast)] disabled:opacity-disabled',
        pressed ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface',
      )}
    >
      {icon ? <span className="grid size-5 shrink-0 place-items-center">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-medium">{label}</span>
        {hint ? (
          <span className="block truncate text-body-small text-on-surface-dim">{hint}</span>
        ) : null}
      </span>
    </button>
  );
}
