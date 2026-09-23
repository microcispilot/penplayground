import { type RefObject, useEffect, useRef, useState } from 'react';
import { mountGoogleButton } from './google.js';
import { isDarkTheme, useTheme } from './theme.js';

/**
 * Google's own button, mounted into a slot.
 *
 * Extracted from the account sheet when sign-in became its own dialog: the
 * button is the same in both places, and the two details below are the kind
 * that get lost when a component is copied rather than shared.
 *
 * **The theme comes from the store, not from `readTheme()`.** Google renders
 * the button as an image for one theme, so switching theme while the dialog is
 * open has to remount it. Reading the stored value once would leave a light
 * button on a dark sheet until the next open.
 *
 * **The returned cleanup matters.** `mountGoogleButton` attaches to Google's
 * global, and a dialog that opens, closes and opens again would otherwise
 * stack listeners and fire `onToken` more than once per credential.
 */
export function useGoogleButton(opts: {
  open: boolean;
  slot: RefObject<HTMLDivElement | null>;
  clientId: string | null;
  onToken: (idToken: string) => Promise<void>;
}): string | null {
  const [problem, setProblem] = useState<string | null>(null);
  const [theme] = useTheme();
  const { open, slot, clientId } = opts;

  /*
   * The callback, held in a ref.
   *
   * It is a fresh closure on every render, so depending on it would tear down
   * and remount Google's button on each keystroke in the form beside it — and
   * Google's button is an iframe that takes a visible moment to draw. A ref
   * keeps the effect stable while still calling the *latest* callback, which
   * is what a suppression comment would have papered over rather than solved.
   */
  const onToken = useRef(opts.onToken);
  onToken.current = opts.onToken;

  useEffect(() => {
    const el = slot.current;
    if (!open || !el || !clientId) return;
    setProblem(null);
    return mountGoogleButton(el, {
      clientId,
      theme: isDarkTheme(theme) ? 'dark' : 'light',
      width: Math.min(400, el.clientWidth || 320),
      onCredential: (idToken) => {
        onToken.current(idToken).catch((error: unknown) => {
          setProblem(error instanceof Error ? error.message : 'Could not sign in with Google.');
        });
      },
      onError: (error) => setProblem(error.message),
    });
  }, [open, slot, clientId, theme]);

  return problem;
}
