import { Button, Card, readTheme } from '@pen/design';
import { PenLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAdmin } from '../lib/context.js';
import { mountGoogleButton } from '../lib/google.js';

/**
 * The way in (ADR-0026). The same Google account the learner app signs in
 * with; whether it may be here is the server's decision alone
 * (`PEN_ADMIN_EMAILS`), checked immediately after the token is exchanged.
 *
 * An account that is not on the list is told plainly and signed straight back
 * out, so no half-authenticated state is left in this browser.
 */
/** Baked in at build time, so it is the same for every render and every tab. */
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

export function SignIn() {
  const { api, session, checked, refresh, signOut, unreachable } = useAdmin();
  const navigate = useNavigate();
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped to remount the Google button after a failed script load. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (checked && session.admin) navigate('/settings', { replace: true });
  }, [checked, session, navigate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is not read here — bumping it is the retry, and remounting Google's button is the whole effect
  useEffect(() => {
    const host = slot.current;
    if (!host || !CLIENT_ID || busy) return;
    return mountGoogleButton(host, {
      clientId: CLIENT_ID,
      theme: readTheme() === 'dark' ? 'dark' : 'light',
      width: 320,
      onCredential: (idToken) => {
        setBusy(true);
        setError(null);
        void api
          .signInWithGoogle(idToken)
          .then(() => api.session())
          .then((next) => {
            if (next.admin) {
              void refresh().then(() => navigate('/settings', { replace: true }));
              return;
            }
            // Signed in, but not an operator. Leave nothing behind.
            signOut();
            setBusy(false);
            setError('That account cannot open the operations console.');
          })
          .catch((cause: unknown) => {
            signOut();
            setBusy(false);
            setError(cause instanceof Error ? cause.message : 'Could not sign in.');
          });
      },
      onError: (cause) => setError(cause.message),
    });
  }, [api, busy, attempt, refresh, signOut, navigate]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-6">
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <PenLine size={22} className="text-primary" aria-hidden />
          <span className="text-title-large text-on-surface">Pen Playground</span>
        </div>
        <Card className="p-7">
          <h1 className="text-title-medium text-on-surface">Operations console</h1>
          <p className="mt-2 text-body-medium text-on-surface-variant">
            Sign in with the Google account that runs this deployment.
          </p>
          <div
            className={CLIENT_ID ? 'mt-6 flex min-h-[44px] justify-center' : 'hidden'}
            ref={slot}
            data-testid="google-signin"
          />
          {!CLIENT_ID ? (
            <p className="mt-4 text-body-small text-on-surface-variant">
              Google sign-in is not configured on this build. Set{' '}
              <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code> and rebuild.
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="mt-4 text-body-small text-on-surface-variant">
              Signing in…
            </p>
          ) : null}
          {error ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              <p role="alert" className="text-body-small text-error" data-testid="signin-error">
                {error}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {unreachable && !error ? (
            <p role="alert" className="mt-4 text-body-small text-error">
              {unreachable}
            </p>
          ) : null}
        </Card>
      </div>
    </main>
  );
}
