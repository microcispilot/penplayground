import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../cn.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/** Native <dialog> with the design system's surface; focus trapping and Esc come from the platform. */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
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
        'm-auto w-[min(520px,92vw)] rounded-[var(--radius-xl)] bg-bg-elevated p-6 text-fg shadow-pop backdrop:bg-navy-900/60 backdrop:backdrop-blur-[2px]',
        className,
      )}
      aria-label={title}
    >
      <h3 className="mb-3 text-lg">{title}</h3>
      {children}
    </dialog>
  );
}
