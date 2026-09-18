import type { RefObject } from 'react';
import { useEffect } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What every `aria-modal` surface owes a keyboard: focus moves inside when it
 * opens, Tab cannot leave it while it is up, Escape closes it, and focus goes
 * back to whatever opened it. One implementation, because `aria-modal="true"`
 * is a promise — a panel that claims it and lets Tab wander behind the scrim
 * is worse than one that never claimed it.
 *
 * The panel itself decides how it looks and where it comes from; this only
 * decides where focus may go. Pass the panel's ref, and keep `onClose` stable.
 */
export function useModalFocus(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first control, so a keyboard or switch user lands inside, not behind.
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const head = focusable[0];
      const tail = focusable[focusable.length - 1];
      if (!head || !tail) return;
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
  }, [open, onClose, panelRef]);
}
