import { PLAN_NAME } from '@pen/contracts';
import { Avatar, Button, TextField, useToast } from '@pen/design';
import { LogOut, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ShellPage } from '../components/AppShell.js';
import { PrivacyDialog } from '../components/PrivacyDialog.js';
import { SurveyDialog } from '../components/SurveyDialog.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { useSeo } from '../lib/seo.js';

/**
 * Account: who you are, what you pay for, and how to leave.
 *
 * Everything here used to live inside the dialog that `Sign in` opened, which
 * is why that dialog was titled *"How should we call you?"* — clicking **Sign
 * in** asked a signed-out visitor to name themselves, and buried the actual
 * sign-in under a rename form, a privacy link and a delete button. The owner,
 * on both halves: the sign-in should look like a sign-in, and *"what should we
 * call you is not good not the proper way of changing a name"*.
 *
 * So the two are separated. `AuthDialog` signs you in. This is the page you
 * reach afterwards, and it is a page rather than a sheet because it holds
 * things you come back to deliberately — your plan, your privacy choices,
 * deleting everything — rather than a single field you fill once.
 *
 * It is deliberately *not* Settings. Settings is what the app does (the board,
 * the theme); this is who the account is. That split is the owner's, and it is
 * the reason there are two entries in the sidebar rather than one screen with
 * a heading for each.
 */
function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-outline-variant border-t py-8 first:border-t-0 first:pt-0">
      <h3 className="text-title-medium">{title}</h3>
      {intro ? (
        <p className="mt-1.5 max-w-[35rem] text-body-medium text-on-surface-variant text-pretty">
          {intro}
        </p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function Account() {
  useSeo({ title: 'Account', description: 'Your name, your plan, and your privacy choices.' });
  const { participant, setName, signOut, deleteAccount } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setNameState] = useState(participant?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** The leaving survey stands between "Delete everything" and the deletion (ADR-0060); Skip is one press. */
  const [askingWhy, setAskingWhy] = useState(false);

  const performDelete = async () => {
    setDeleting(true);
    try {
      const removed = await deleteAccount();
      toast(
        removed === 0
          ? 'Your account was deleted'
          : `Your account and ${removed} session${removed === 1 ? '' : 's'} were deleted`,
        'success',
      );
      navigate('/');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete the account', 'danger');
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const signedIn = participant !== null && !participant.anonymous;
  const plan = participant?.plan ?? 'free';
  const changed = name.trim() !== (participant?.name ?? '') && name.trim().length > 0;

  return (
    <ShellPage title="Account" intro="Your name, your plan, and your privacy choices.">
      {askingWhy ? (
        <SurveyDialog
          open
          kind="cancel_reason"
          trigger="account_deleted"
          onDone={() => {
            setAskingWhy(false);
            void performDelete();
          }}
        />
      ) : null}
      <div className="max-w-[45rem]">
        <Section title="You">
          <div className="flex flex-wrap items-center gap-3.5">
            <Avatar
              name={participant?.name ?? 'Learner'}
              src={participant?.avatarUrl ?? null}
              hue={218}
              size={52}
              ring
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-title-small">{participant?.name ?? 'Learner'}</p>
              <p className="truncate text-body-medium text-on-surface-variant">
                {/*
                  An anonymous learner is a real learner here, not a lesser one.
                  It says what is true and what signing in would add, and never
                  that they ought to.
                */}
                {participant?.email ??
                  (signedIn ? 'Signed in' : 'Not signed in — this device only')}
              </p>
            </div>
            {signedIn ? (
              <Button
                variant="secondary"
                size="sm"
                leading={<LogOut size={14} />}
                loading={signingOut}
                data-testid="account-signout"
                onClick={async () => {
                  setSigningOut(true);
                  try {
                    await signOut();
                    toast('Signed out', 'success');
                    navigate('/');
                  } catch (error) {
                    toast(error instanceof Error ? error.message : 'Could not sign out', 'danger');
                  } finally {
                    setSigningOut(false);
                  }
                }}
              >
                Sign out
              </Button>
            ) : null}
          </div>
        </Section>

        <Section
          title="Display name"
          intro="Shown to the expert, and to anyone you invite to a room."
        >
          <form
            className="flex max-w-[26.25rem] flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await setName(name.trim());
                toast('Saved', 'success');
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
              data-testid="account-name"
            />
            <div className="flex justify-end">
              {/* Disabled until something actually changed: a Save that does
                  nothing is a Save you stop trusting. */}
              <Button
                variant="primary"
                type="submit"
                loading={busy}
                disabled={!changed}
                data-testid="account-name-save"
              >
                Save
              </Button>
            </div>
          </form>
        </Section>

        <Section title="Plan" intro="What this account includes today.">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full bg-secondary-container px-3 py-1 text-label-large font-semibold text-on-secondary-container">
              {PLAN_NAME[plan]}
            </span>
            <Link
              to="/pricing"
              onClick={() => trackAction('upgrade_clicked', { source: 'account' })}
              className="text-body-medium text-primary underline decoration-outline underline-offset-4 hover:decoration-primary"
            >
              {plan === 'free' ? 'See what the paid plans add' : 'Change or cancel'}
            </Link>
          </div>
        </Section>

        <Section
          title="Privacy"
          intro="See what we collect, and turn analytics off if you would rather not be counted."
        >
          <Button
            variant="secondary"
            size="sm"
            leading={<ShieldCheck size={14} />}
            onClick={() => setPrivacyOpen(true)}
            data-testid="account-privacy"
          >
            Privacy choices
          </Button>
        </Section>

        {/*
          Deleting is rare and permanent, so it is last, stated plainly and
          without alarm. It is the one place on this page that uses the error
          role, and only once the learner has asked for it.
        */}
        <Section title="Delete account">
          {confirmingDelete ? (
            <div className="flex max-w-[35rem] flex-col gap-3">
              <p className="text-body-medium text-on-surface-variant text-pretty">
                This removes your account and every session you started, including their recordings.
                It cannot be undone. Subscriptions are managed separately in billing.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>
                  Keep my account
                </Button>
                <Button
                  variant="danger"
                  loading={deleting}
                  data-testid="confirm-delete-account"
                  onClick={() => {
                    // A visitor without an account has nothing to tell us about leaving.
                    if (signedIn) setAskingWhy(true);
                    else void performDelete();
                  }}
                >
                  Delete everything
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              data-testid="delete-account"
              onClick={() => {
                trackAction('account_delete_opened');
                setConfirmingDelete(true);
              }}
            >
              Delete account
            </Button>
          )}
        </Section>

        <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
      </div>
    </ShellPage>
  );
}
