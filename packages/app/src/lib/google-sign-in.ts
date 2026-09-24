import { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleCancelled, loadGoogleAccounts, requestGoogleCode } from './google.js';

/**
 * The app's own Continue with Google, as a hook (ADR-0042).
 *
 * Replaces the hook that mounted Google's rendered button into a slot. Three
 * details that were easy to lose when the button was Google's are kept here
 * on purpose:
 *
 * **The script is preloaded while the sheet is open.** `start` runs from the
 * click and must open the popup inside the browser's user activation; with
 * GIS already on the page that is a microtask away, without it a network
 * round-trip that some browsers count as too late.
 *
 * **A closed popup is not a problem.** The person changed their mind; the
 * sheet says nothing and the button is ready again.
 *
 * **A sheet that closes mid-flight disposes the request**, so a code that
 * arrives afterwards is dropped rather than signing in a dialog nobody is
 * looking at.
 */
export function useGoogleSignIn(opts: {
  open: boolean;
  clientId: string | null;
  onCode: (code: string) => Promise<void>;
}): { start: () => void; busy: boolean; problem: string | null } {
  const { open, clientId } = opts;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dispose = useRef<(() => void) | null>(null);

  // A fresh closure every render; a ref keeps `start` stable while it still
  // calls the latest one.
  const onCode = useRef(opts.onCode);
  onCode.current = opts.onCode;

  useEffect(() => {
    if (!open || !clientId) return;
    setProblem(null);
    setBusy(false);
    loadGoogleAccounts().catch(() => {
      /* said when the button is pressed, not before */
    });
    return () => {
      dispose.current?.();
      dispose.current = null;
    };
  }, [open, clientId]);

  const start = useCallback(() => {
    if (!clientId || busy) return;
    setBusy(true);
    setProblem(null);
    dispose.current?.();
    dispose.current = requestGoogleCode({
      clientId,
      onCode: (code) => {
        onCode
          .current(code)
          .catch((error: unknown) => {
            setProblem(error instanceof Error ? error.message : 'Could not sign in with Google.');
          })
          .finally(() => setBusy(false));
      },
      onError: (error) => {
        setBusy(false);
        if (!(error instanceof GoogleCancelled)) setProblem(error.message);
      },
    });
  }, [clientId, busy]);

  return { start, busy, problem };
}
