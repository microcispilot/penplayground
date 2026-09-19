import { Avatar, Button, Dialog, TextField, useToast } from '@pen/design';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/context.js';
import { mountGoogleButton } from '../lib/google.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { PrivacyDialog } from './PrivacyDialog.js';

/**
 * The account sheet. Anonymous: pick a display name and, where Google sign-in
 * is configured, continue with Google — the current participant is upgraded
 * in place, so every session stays theirs. Signed in: the profile, the same
 * name field, and sign-out back to a fresh anonymous participant.
 */
export function NameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { participant, platform, setName, signInWithGoogle, signOut, deleteAccount } = useApp();
  const toast = useToast();
  const [name, setNameState] = useState(participant?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  /** Deleting is two deliberate clicks, never one — and the second one says what it will take. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleProblem, setGoogleProblem] = useState<string | null>(null);
  const googleSlot = useRef<HTMLDivElement>(null);
  // Through the store, not `readTheme()`: Google's button is painted for one
  // theme, so a toggle while this sheet is open has to remount it.
  const [theme] = useTheme();
  const signedIn = participant !== null && !participant.anonymous;
  const googleOffered = platform.googleClientId !== null && !signedIn;

  // The field follows the participant while the sheet is closed (rename, sign-in, sign-out).
  useEffect(() => {
    if (!open) {
      setNameState(participant?.name ?? '');
      setConfirmingDelete(false);
    }
  }, [open, participant]);

  useEffect(() => {
    const slot = googleSlot.current;
    if (!open || !googleOffered || !slot || !platform.googleClientId) return;
    setGoogleProblem(null);
    return mountGoogleButton(slot, {
      clientId: platform.googleClientId,
      theme: isDarkTheme(theme) ? 'dark' : 'light',
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
  }, [open, googleOffered, platform.googleClientId, theme, signInWithGoogle, toast, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={signedIn ? 'Your account' : 'How should we call you?'}
    >
      {signedIn && participant ? (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-surface-container-high p-3">
          <Avatar name={participant.name} src={participant.avatarUrl} hue={218} size={44} ring />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{participant.name}</p>
            {participant.email ? (
              <p className="truncate text-body-medium text-on-surface-variant">
                {participant.email}
              </p>
            ) : (
              <p className="text-body-medium text-on-surface-variant">Signed in with Google</p>
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
      <div className="mt-5 border-t border-outline-variant pt-4">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md text-body-medium text-on-surface-variant underline decoration-outline underline-offset-4 transition-colors hover:text-on-surface hover:decoration-primary"
          onClick={() => setPrivacyOpen(true)}
        >
          <ShieldCheck size={14} aria-hidden />
          Privacy choices
        </button>
        <p className="mt-1.5 text-body-medium text-on-surface-dim text-pretty">
          See what we collect, and turn analytics off if you would rather not be counted.
        </p>
      </div>

      {/* Deleting is rare and permanent, so it lives at the bottom, stated plainly and without alarm. */}
      <div className="mt-4 border-t border-outline-variant pt-4">
        {confirmingDelete ? (
          <div className="flex flex-col gap-3">
            <p className="text-body-medium text-on-surface-variant text-pretty">
              This removes your account and every session you started, including their recordings.
              It cannot be undone. Subscriptions are managed separately in billing.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep my account
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                data-testid="confirm-delete-account"
                onClick={async () => {
                  setDeleting(true);
                  try {
                    const removed = await deleteAccount();
                    toast(
                      removed === 0
                        ? 'Your account was deleted'
                        : `Your account and ${removed} session${removed === 1 ? '' : 's'} were deleted`,
                      'success',
                    );
                    onClose();
                  } catch (error) {
                    toast(
                      error instanceof Error ? error.message : 'Could not delete the account',
                      'danger',
                    );
                  } finally {
                    setDeleting(false);
                    setConfirmingDelete(false);
                  }
                }}
              >
                Delete everything
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="rounded-md text-body-medium text-on-surface-dim underline decoration-outline underline-offset-4 transition-colors hover:text-error hover:decoration-error"
            data-testid="delete-account"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete account
          </button>
        )}
      </div>

      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />

      {googleOffered ? (
        <div className="mt-5 border-t border-outline-variant pt-4">
          <p className="mb-3 text-body-medium text-on-surface-variant">
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
            <p className="mt-2 text-center text-body-medium text-error" role="alert">
              {googleProblem}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
