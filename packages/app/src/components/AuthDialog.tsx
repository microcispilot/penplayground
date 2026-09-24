import { CHALLENGE_RESEND_COOLDOWN_SECONDS, passwordProblem } from '@pen/contracts';
import { Button, Dialog, TextField, useToast } from '@pen/design';
import { Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useGoogleButton } from '../lib/google-button.js';

/**
 * Signing in, and signing up — one sheet, the way ChatGPT does it.
 *
 * The owner: *"we should show both, sign in and sign up for free but they
 * open the same dialog … see how ChatGPT shows"*. So the first step asks for
 * nothing but the way in: **Continue with Google** on top, an address under
 * it, one **Continue**. Whether the address has an account decides nothing
 * visible on this step — the second step is a password box for everyone,
 * with the two other doors under it (forgot it, or new here). What an account
 * brings is said once, under the title, in the words of the plan (ADR-0040).
 *
 * ── the steps, and why it is one dialog ────────────────────────────────────
 *
 * start → password → (code | reset). They are one component because they
 * are one conversation: the address typed on the first step is the address
 * every later step uses, and three routes with their own state would lose it.
 *
 * ── what it may not say ────────────────────────────────────────────────────
 *
 * It never tells you whether an address has an account. The server is careful
 * about this (identical 202s, one 401 for every kind of failure), and the UI
 * would give it away for free if it skipped the password step for an unknown
 * address or the code step for a known one. So both doors are always there.
 */
type Mode = 'start' | 'password' | 'code' | 'reset';

/**
 * Google's button is a cross-origin iframe whose document only knows the
 * light scheme. The root declares `color-scheme: light dark`, so on a dark
 * desktop the iframe element's used scheme is dark, and Chrome then paints a
 * mismatched frame on an opaque canvas of the document's own scheme: a white
 * slab behind the dark pill, seen in production on 2026-09-23. Pinning the
 * slot to light matches the frame to its document, and the frame is
 * transparent again. The button's own colours are unaffected: GIS draws them
 * from the `theme` it is rendered with, not from the scheme around it.
 */
const GOOGLE_SLOT_STYLE = { colorScheme: 'light' } as const;

const TITLES: Record<Mode, string> = {
  start: 'Sign in or sign up',
  password: 'Welcome',
  code: 'Check your email',
  reset: 'Choose a new password',
};

/** A password field with a reveal, because a 12-character minimum is typo-prone. */
function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  error?: string | undefined;
  hint?: string | undefined;
  testId: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      label={label}
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      data-testid={testId}
      {...(error ? { error } : {})}
      {...(hint ? { hint } : {})}
      trailing={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className="state-layer grid size-8 place-items-center rounded-full text-on-surface-variant"
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      }
    />
  );
}

/** "or" between Google and the address, the way every sign-in draws it. */
function Divider() {
  return (
    <div className="flex items-center gap-3" role="presentation">
      <span className="h-px flex-1 bg-outline-variant" aria-hidden />
      <span className="text-label-small tracking-wide text-on-surface-dim uppercase">or</span>
      <span className="h-px flex-1 bg-outline-variant" aria-hidden />
    </div>
  );
}

/** The API's error code when there is one, else the error's class: a code, never its message. */
function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * What the sheet says when a step fails: a sentence, never a code.
 *
 * The client names an error by the server's code when the server sent no
 * sentence of its own, so without this a mail outage read `MAIL_UNAVAILABLE`
 * under the password box. Each sentence says what went wrong and what to do;
 * the red only agrees with the words. Nothing here says whether an address
 * has an account.
 */
function sentenceFor(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'MAIL_UNAVAILABLE':
        return 'We can’t send email right now. Try again in a few minutes, or continue with Google.';
      case 'RATE_LIMITED':
        return 'Too many tries. Give it a minute, then try again.';
      case 'BAD_CODE':
        return 'That code isn’t right, or it has expired. Check the email, or ask for a new one.';
      case 'NETWORK':
        return 'We couldn’t reach Pen Playground. Check your connection and try again.';
      default:
        // The server's own sentence when it wrote one; its code is not one.
        return error.message && error.message !== error.code
          ? error.message
          : 'Something went wrong. Try again.';
    }
  }
  return 'Something went wrong. Try again.';
}

/** The address, as a chip the second step wears, with the way back. */
function EmailChip({ email, onChange }: { email: string; onChange: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-highest px-3.5 py-2.5">
      <span
        className="min-w-0 truncate text-body-medium text-on-surface"
        data-testid="auth-email-shown"
      >
        {email}
      </span>
      <button
        type="button"
        className="shrink-0 text-label-large text-primary"
        onClick={onChange}
        data-testid="auth-change-email"
      >
        Change
      </button>
    </div>
  );
}

export function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    api,
    platform,
    signInWithGoogle,
    signInWithEmail,
    completeRegistration,
    resetPassword,
    features,
    signInSource,
  } = useApp();
  const toast = useToast();
  /** Google is offered where the client is configured for it and the flag says so here (ADR-0036). */
  const googleClientId = features.google_sign_in ? platform.googleClientId : null;
  const emailOffered = features.email_sign_in;

  const [mode, setMode] = useState<Mode>('start');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Reopening should not resume a half-finished sign-up from last time.
  // Read through a ref: the served flags can arrive while the dialog is open,
  // and a re-run here would wipe a half-typed form and say "opened" twice.
  const offered = useRef({
    google: googleClientId !== null,
    email: emailOffered,
    source: signInSource ?? 'header',
  });
  offered.current = {
    google: googleClientId !== null,
    email: emailOffered,
    source: signInSource ?? 'header',
  };
  useEffect(() => {
    if (!open) return;
    setMode('start');
    setProblem(null);
    setCode('');
    setPassword('');
    trackAction('sign_in_opened', offered.current);
  }, [open]);

  // The resend countdown. Cleared on unmount so a closed dialog stops ticking.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const googleSlot = useRef<HTMLDivElement>(null);
  const googleProblem = useGoogleButton({
    open,
    slot: googleSlot,
    clientId: googleClientId,
    onToken: async (idToken) => {
      await signInWithGoogle(idToken);
      toast('Signed in', 'success');
      onClose();
    },
  });

  const strength = mode === 'code' || mode === 'reset' ? passwordProblem(password) : null;

  async function run(what: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (error) {
      setProblem(sentenceFor(error));
      // Which step, and the server's code — never the address or the password.
      trackAction('sign_in_failed', { mode, code: errorCode(error) });
    } finally {
      setBusy(false);
    }
  }

  /** New here: a code to the address, then a name and a password. */
  const createAccount = () => {
    trackAction('sign_in_submitted', { mode: 'signUp' });
    void run(async () => {
      // Always a code step, even for an address that already has an
      // account. Skipping it for a known address would answer the one
      // question the whole flow is built not to answer.
      const accepted = await api.startRegistration(email);
      setChallengeId(accepted.challengeId);
      setCooldown(accepted.resendAvailableInSeconds);
      setPassword('');
      setMode('code');
    });
  };

  /** Forgot it: a code to the address, then a new password. */
  const forgotPassword = () => {
    trackAction('sign_in_submitted', { mode: 'forgot' });
    void run(async () => {
      const accepted = await api.startPasswordReset(email);
      setChallengeId(accepted.challengeId);
      setCooldown(accepted.resendAvailableInSeconds);
      setPassword('');
      setMode('reset');
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    trackAction('sign_in_submitted', { mode });
    void run(async () => {
      switch (mode) {
        case 'start': {
          // The address is all this step asks; the next one is the same for
          // everyone, so nothing here says whether it is known.
          setProblem(null);
          setMode('password');
          return;
        }
        case 'password': {
          await signInWithEmail(email, password);
          toast('Signed in', 'success');
          onClose();
          return;
        }
        case 'code': {
          await completeRegistration({ challengeId, code, name, password });
          toast('Welcome to Pen Playground', 'success');
          onClose();
          return;
        }
        case 'reset': {
          await resetPassword({ challengeId, code, password });
          toast('Password changed', 'success');
          onClose();
          return;
        }
      }
    });
  };

  const codeStep = mode === 'code' || mode === 'reset';
  const close = (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      className="state-layer absolute top-4 right-4 grid size-9 place-items-center rounded-full text-on-surface-variant"
      data-testid="auth-close"
    >
      <X size={18} />
    </button>
  );

  if (!emailOffered) {
    // Email sign-in is off here (ADR-0036): Google alone, or an honest line
    // when there is no way in at all — never a form the server would refuse.
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Sign in or sign up"
        width={448}
        className="relative"
      >
        {close}
        {googleClientId ? (
          <div className="flex flex-col gap-4">
            <p className="text-body-medium text-on-surface-variant">
              Continue with your Google account to keep your sessions everywhere.
            </p>
            <div
              ref={googleSlot}
              className="flex min-h-[44px] justify-center"
              style={GOOGLE_SLOT_STYLE}
              data-testid="auth-google"
            />
            {googleProblem ? (
              <p className="text-center text-body-medium text-error" role="alert">
                {googleProblem}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-body-medium text-on-surface-variant" data-testid="auth-unavailable">
            Signing in is not available here yet. Everything you do on this device stays on it.
          </p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={TITLES[mode]}
      width={448}
      className="relative text-center"
    >
      {close}
      {mode === 'start' ? (
        <p className="mx-auto -mt-1 mb-5 max-w-[380px] text-body-medium text-on-surface-variant text-pretty">
          Keep your sessions, get a lesson prepared on any topic you name, and have the expert take
          your questions.
        </p>
      ) : null}

      {/* Google first, where the form is — never on the code step, where the
          person is halfway through making a different kind of account. */}
      {mode === 'start' && googleClientId ? (
        <div className="mb-4 flex flex-col gap-4">
          <div
            ref={googleSlot}
            className="flex min-h-[44px] justify-center"
            style={GOOGLE_SLOT_STYLE}
            data-testid="auth-google"
          />
          {googleProblem ? (
            <p className="text-center text-body-medium text-error" role="alert">
              {googleProblem}
            </p>
          ) : null}
          <Divider />
        </div>
      ) : null}

      <form className="flex flex-col gap-4 text-left" onSubmit={submit} data-testid="auth-form">
        {mode === 'start' ? (
          <TextField
            label="Email address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            data-testid="auth-email"
          />
        ) : (
          <EmailChip
            email={email}
            onChange={() => {
              setMode('start');
              setProblem(null);
              setCode('');
              setPassword('');
            }}
          />
        )}

        {codeStep ? (
          <TextField
            label="The code we emailed you"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/gu, '').slice(0, 8))}
            hint={
              mode === 'reset'
                ? 'If that address has an account, a code is on its way. It works for 15 minutes.'
                : 'A code is on its way. It works for 15 minutes.'
            }
            data-testid="auth-code"
          />
        ) : null}
        {mode === 'code' ? (
          <TextField
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            data-testid="auth-name"
          />
        ) : null}
        {mode !== 'start' ? (
          <PasswordField
            label={mode === 'password' ? 'Password' : 'Choose a password'}
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'password' ? 'current-password' : 'new-password'}
            testId="auth-password"
            {...(strength && password ? { error: strength } : {})}
            {...(mode !== 'password' ? { hint: 'At least 12 characters.' } : {})}
          />
        ) : null}

        {problem ? (
          <p className="text-body-medium text-error" role="alert" data-testid="auth-problem">
            {problem}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          data-testid="auth-continue"
          disabled={
            (mode === 'start' && !email.trim()) ||
            (mode === 'password' && !password) ||
            (mode === 'code' && (code.length !== 8 || !name.trim() || strength !== null)) ||
            (mode === 'reset' && (code.length !== 8 || strength !== null))
          }
        >
          {mode === 'start' && 'Continue'}
          {mode === 'password' && 'Sign in'}
          {mode === 'code' && 'Create account'}
          {mode === 'reset' && 'Change password'}
        </Button>

        {mode === 'password' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-body-medium">
            <button
              type="button"
              className="text-primary underline decoration-outline underline-offset-4"
              data-testid="auth-to-signup"
              disabled={busy}
              onClick={createAccount}
            >
              New here? Create your account
            </button>
            <button
              type="button"
              className="underline decoration-outline underline-offset-4 hover:text-on-surface"
              data-testid="auth-to-forgot"
              disabled={busy}
              onClick={forgotPassword}
            >
              Forgot password?
            </button>
          </div>
        ) : null}

        {codeStep ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-body-medium">
            <button
              type="button"
              className="text-primary underline decoration-outline underline-offset-4 disabled:text-on-surface-dim disabled:no-underline"
              disabled={cooldown > 0 || busy}
              data-testid="auth-resend"
              onClick={() =>
                void run(async () => {
                  const next =
                    mode === 'reset'
                      ? await api.startPasswordReset(email)
                      : await api.resendRegistrationCode(challengeId);
                  setChallengeId(next.challengeId);
                  setCooldown(next.resendAvailableInSeconds || CHALLENGE_RESEND_COOLDOWN_SECONDS);
                })
              }
            >
              {cooldown > 0 ? `Send another in ${cooldown}s` : 'Send another code'}
            </button>
            <button
              type="button"
              className="text-on-surface-variant underline decoration-outline underline-offset-4"
              data-testid="auth-to-signin"
              onClick={() => {
                setMode('password');
                setCode('');
                setPassword('');
              }}
            >
              Back
            </button>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
