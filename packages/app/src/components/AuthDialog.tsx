import { CHALLENGE_RESEND_COOLDOWN_SECONDS, passwordProblem } from '@pen/contracts';
import { Button, Dialog, TextField, useToast } from '@pen/design';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context.js';
import { useGoogleButton } from '../lib/google-button.js';

/**
 * Signing in, and signing up.
 *
 * This replaces a sheet titled "How should we call you?" that opened when you
 * pressed **Sign in** — a rename form, a privacy link and a Delete account
 * button stacked above the only thing the visitor had asked for. The owner:
 * *"it should show proper email and password and then or part which is for now
 * google auth sign in. like any other app and platform."*
 *
 * So it is the ordinary arrangement, in the ordinary order: the form first,
 * a divider, then Google. Everything about an existing account moved to
 * `/account`.
 *
 * ── the four states, and why it is one dialog ──────────────────────────────
 *
 * Sign in, sign up, the code step, and forgotten password. They are one
 * component because they are one conversation — a person who mistypes an
 * address on step two must not lose what they typed on step one, and three
 * routes with their own state would do exactly that.
 *
 * ── what it may not say ────────────────────────────────────────────────────
 *
 * It never tells you whether an address has an account. The server is careful
 * about this (identical 202s, one 401 for every kind of failure), and the UI
 * would give it away for free if it said "no account with that email" or
 * skipped the code step for a known address. So the copy is deliberately
 * uninformative in exactly one direction, and the comments below say where.
 */
type Mode = 'signIn' | 'signUp' | 'code' | 'forgot' | 'reset';

const TITLES: Record<Mode, string> = {
  signIn: 'Sign in',
  signUp: 'Create your account',
  code: 'Check your email',
  forgot: 'Reset your password',
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

/** "or" between the form and Google, the way every sign-in draws it. */
function Divider() {
  return (
    <div className="flex items-center gap-3" role="presentation">
      <span className="h-px flex-1 bg-outline-variant" aria-hidden />
      <span className="text-label-small tracking-wide text-on-surface-dim uppercase">or</span>
      <span className="h-px flex-1 bg-outline-variant" aria-hidden />
    </div>
  );
}

export function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api, platform, signInWithGoogle } = useApp();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Reopening should not resume a half-finished sign-up from last time.
  useEffect(() => {
    if (!open) return;
    setMode('signIn');
    setProblem(null);
    setCode('');
    setPassword('');
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
    clientId: platform.googleClientId,
    onToken: async (idToken) => {
      await signInWithGoogle(idToken);
      toast('Signed in', 'success');
      onClose();
    },
  });

  const strength = mode === 'signUp' || mode === 'reset' ? passwordProblem(password) : null;

  async function run(what: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void run(async () => {
      switch (mode) {
        case 'signIn': {
          await api.signInWithPassword(email, password);
          toast('Signed in', 'success');
          onClose();
          return;
        }
        case 'signUp': {
          // Always a code step, even for an address that already has an
          // account. Skipping it for a known address would answer the one
          // question the whole flow is built not to answer.
          const accepted = await api.startRegistration(email);
          setChallengeId(accepted.challengeId);
          setCooldown(accepted.resendAvailableInSeconds);
          setMode('code');
          return;
        }
        case 'code': {
          await api.completeRegistration({ challengeId, code, name, password });
          toast('Welcome to Pen Playground', 'success');
          onClose();
          return;
        }
        case 'forgot': {
          const accepted = await api.startPasswordReset(email);
          setChallengeId(accepted.challengeId);
          setCooldown(accepted.resendAvailableInSeconds);
          setMode('reset');
          return;
        }
        case 'reset': {
          await api.resetPassword({ challengeId, code, password });
          toast('Password changed', 'success');
          onClose();
          return;
        }
      }
    });
  };

  const codeStep = mode === 'code' || mode === 'reset';

  return (
    <Dialog open={open} onClose={onClose} title={TITLES[mode]}>
      <form className="flex flex-col gap-4" onSubmit={submit} data-testid="auth-form">
        {codeStep ? (
          <p className="text-body-medium text-on-surface-variant text-pretty">
            {/*
              "If there is an account" is load-bearing on the reset path: saying
              "we sent you a code" would confirm the address is registered.
            */}
            {mode === 'reset'
              ? `If there is an account for ${email}, a code is on its way. Enter it below.`
              : `We sent an eight-digit code to ${email}.`}
          </p>
        ) : null}

        {!codeStep ? (
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
            data-testid="auth-email"
          />
        ) : null}

        {codeStep ? (
          <TextField
            label="Verification code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/gu, '').slice(0, 8))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            className="font-mono tracking-[0.3em]"
            data-testid="auth-code"
          />
        ) : null}

        {mode === 'code' ? (
          <TextField
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={60}
            hint="Shown to the expert, and to anyone you invite to a room."
            data-testid="auth-name"
          />
        ) : null}

        {mode !== 'forgot' && mode !== 'signUp' ? (
          <PasswordField
            label={mode === 'reset' ? 'New password' : 'Password'}
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
            testId="auth-password"
            {...(mode !== 'signIn' && password && strength ? { error: strength } : {})}
            {...(mode !== 'signIn'
              ? {
                  hint: 'At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols.',
                }
              : {})}
          />
        ) : null}

        {problem ? (
          <p className="text-body-medium text-error" role="alert" data-testid="auth-error">
            {problem}
          </p>
        ) : null}

        <Button
          variant="primary"
          type="submit"
          size="lg"
          loading={busy}
          className="w-full"
          data-testid="auth-submit"
          disabled={
            (mode === 'code' && (code.length !== 8 || !name.trim() || strength !== null)) ||
            (mode === 'reset' && (code.length !== 8 || strength !== null)) ||
            (mode === 'signIn' && (!email.trim() || !password)) ||
            ((mode === 'signUp' || mode === 'forgot') && !email.trim())
          }
        >
          {mode === 'signIn' && 'Sign in'}
          {mode === 'signUp' && 'Continue'}
          {mode === 'code' && 'Create account'}
          {mode === 'forgot' && 'Send me a code'}
          {mode === 'reset' && 'Change password'}
        </Button>

        {codeStep ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-body-medium">
            <button
              type="button"
              className="text-primary underline decoration-outline underline-offset-4 disabled:text-on-surface-dim disabled:no-underline"
              disabled={cooldown > 0 || busy}
              data-testid="auth-resend"
              onClick={() =>
                void run(async () => {
                  const next = await api.resendRegistrationCode(challengeId);
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
              onClick={() => {
                setMode(mode === 'reset' ? 'forgot' : 'signUp');
                setCode('');
              }}
            >
              Use a different email
            </button>
          </div>
        ) : null}
      </form>

      {/* Google only where the form is, not on the code step: by then the
          person is halfway through making a different kind of account. */}
      {!codeStep && platform.googleClientId ? (
        <div className="mt-5 flex flex-col gap-4">
          <Divider />
          <div
            ref={googleSlot}
            className="flex min-h-[44px] justify-center"
            data-testid="google-signin"
          />
          {googleProblem ? (
            <p className="text-center text-body-medium text-error" role="alert">
              {googleProblem}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 border-t border-outline-variant pt-4 text-body-medium text-on-surface-variant">
        {mode === 'signIn' ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="text-primary underline decoration-outline underline-offset-4"
              data-testid="auth-to-signup"
              onClick={() => {
                setMode('signUp');
                setProblem(null);
              }}
            >
              Create an account
            </button>
            <button
              type="button"
              className="underline decoration-outline underline-offset-4 hover:text-on-surface"
              data-testid="auth-to-forgot"
              onClick={() => {
                setMode('forgot');
                setProblem(null);
              }}
            >
              Forgot password?
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="text-primary underline decoration-outline underline-offset-4"
            data-testid="auth-to-signin"
            onClick={() => {
              setMode('signIn');
              setProblem(null);
              setCode('');
            }}
          >
            Back to sign in
          </button>
        )}
      </div>
    </Dialog>
  );
}
