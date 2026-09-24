import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../cn.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** The sheet's width in CSS pixels, before the viewport's 92 % cap. */
  width?: number;
}

/** Native <dialog> with the design system's surface; focus trapping and Esc come from the platform. */
export function Dialog({ open, onClose, title, children, className, width = 520 }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes; Escape is handled natively by <dialog>
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        // M3 basic dialog: `surface-container-high`, `corner-extra-large`
        // (28 px), elevation level 3, over a `scrim`.
        'm-auto rounded-xl bg-surface-container-high p-6 text-on-surface shadow-level3 backdrop:bg-scrim/60 backdrop:backdrop-blur-[2px]',
        className,
      )}
      style={{ width: `min(${width}px, 92vw)` }}
      aria-label={title}
    >
      {/* M3 names `headline-small` here; `title-large` keeps a modal that is
          mostly one sentence from shouting, and is still a scale role. */}
      <h3 className="mb-3 text-title-large">{title}</h3>
      {children}
    </dialog>
  );
}
