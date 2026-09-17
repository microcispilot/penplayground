import { Avatar, Button, Dialog, readTheme, TextField, useToast } from '@pen/design';
import { LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context.js';
import { mountGoogleButton } from '../lib/google.js';

/**
 * The account sheet. Anonymous: pick a display name and, where Google sign-in
 * is configured, continue with Google — the current participant is upgraded
 * in place, so every session stays theirs. Signed in: the profile, the same
 * name field, and sign-out back to a fresh anonymous participant.
 */
export function NameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { participant, platform, setName, signInWithGoogle, signOut } = useApp();
  const toast = useToast();
  const [name, setNameState] = useState(participant?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleProblem, setGoogleProblem] = useState<string | null>(null);
  const googleSlot = useRef<HTMLDivElement>(null);
  const signedIn = participant !== null && !participant.anonymous;
  const googleOffered = platform.googleClientId !== null && !signedIn;

  // The field follows the participant while the sheet is closed (rename, sign-in, sign-out).
  useEffect(() => {
    if (!open) setNameState(participant?.name ?? '');
  }, [open, participant]);

  useEffect(() => {
    const slot = googleSlot.current;
    if (!open || !googleOffered || !slot || !platform.googleClientId) return;
    setGoogleProblem(null);
    const theme = readTheme();
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    return mountGoogleButton(slot, {
      clientId: platform.googleClientId,
      theme: dark ? 'dark' : 'light',
      width: Math.min(400, slot.clientWidth || 320),
      onCredential: (idToken) => {
        setGoogleBusy(true);
        signInWithGoogle(idToken)
          .then((outcome) => {
            toast(outcome === 'existing' ? 'Welcome back' : 'Signed in with Google', 'success');
            onClose();
          })
          .catch((error: unknown) => {
            setGoogleProblem(
              error instanceof Error ? error.message : 'Could not sign in with Google.',
            );
          })
          .finally(() => setGoogleBusy(false));
      },
      onError: (error) => setGoogleProblem(error.message),
    });
  }, [open, googleOffered, platform.googleClientId, signInWithGoogle, toast, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={signedIn ? 'Your account' : 'How should we call you?'}
    >
      {signedIn && participant ? (
        <div className="mb-4 flex items-center gap-3 rounded-[var(--radius-lg)] bg-surface-2 p-3">
          <Avatar name={participant.name} src={participant.avatarUrl} hue={218} size={44} ring />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{participant.name}</p>
            {participant.email ? (
              <p className="truncate text-sm text-fg-2">{participant.email}</p>
            ) : (
              <p className="text-sm text-fg-2">Signed in with Google</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            leading={<LogOut size={14} />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signOut();
                toast('Signed out', 'success');
                onClose();
              } catch (error) {
                toast(error instanceof Error ? error.message : 'Could not sign out', 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await setName(name.trim());
            toast('Saved', 'success');
            onClose();
          } catch (error) {
            toast(error instanceof Error ? error.message : 'Could not save', 'danger');
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          name="displayName"
          label="Display name"
          value={name}
          onChange={(e) => setNameState(e.target.value)}
          maxLength={60}
          autoFocus
          hint="Shown to the expert and to anyone you invite to a room."
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
      {googleOffered ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-3 text-sm text-fg-2">
            Keep your sessions on every device — sign in and this name and everything you have
            started come with you.
          </p>
          <div
            ref={googleSlot}
            className="flex min-h-[44px] justify-center"
            aria-busy={googleBusy || undefined}
            data-testid="google-signin"
          />
          {googleProblem ? (
            <p className="mt-2 text-center text-sm text-danger" role="alert">
              {googleProblem}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
