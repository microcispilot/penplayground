import {
  BOARDS_BY_PLAN,
  INKS_BY_PLAN,
  LEGENDS_BY_PLAN,
  monthlyEquivalentUsd,
} from '@pen/contracts';
import { Button, cn, Pill, SegmentedButtons, useToast } from '@pen/design';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.js';
import { RETURN_TO_KEY } from '../components/RoomInviteGate.js';
import { SurveyDialog } from '../components/SurveyDialog.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

/**
 * What each plan says for itself. The prices are `PLAN_PRICES_USD` in
 * contracts (ADR-0056); this file never writes a number.
 *
 * The voice (the owner, 2026-09-25): professional and unhurried, never
 * cheap; nothing that shows the machinery ("nobody has prepared it yet" said
 * how a lesson is made, not what the learner gets); and no dashes as
 * punctuation, which read as written by a machine. A sentence ends and the
 * next begins.
 *
 * One rule, and it is the owner’s: a line earns its place only if it names
 * something this plan has that the plan below it does not. Voice is not a
 * feature of Professional — the whole product is voice, on every plan, and a
 * bullet reading “Guests ask questions by voice” made the most expensive tier
 * sound like it was selling the thing everybody already has. What is actually
 * new up there is that the expert hears a *room*: several people, by name,
 * taking turns. That is what the line says now.
 *
 * The same edit went through the rest. “Solo sessions with every modern
 * expert” described the product, not the tier; “Share to YouTube and social”
 * named the destinations without saying what leaves the building. Every line
 * below is a difference, and none of them is a restatement of what Pen is.
 *
 * Free is the exception, because it is the baseline and has nothing beneath it
 * to differ from. Its lines say plainly what a free session is, both limits
 * included and neither softened — a limit a learner meets for the first time
 * on the third session is worse than one printed on the card.
 *
 * Nothing here claims a capability the product does not already ship. The
 * legend counts are read from `LEGENDS_BY_PLAN` rather than written down, so
 * the card cannot drift from the catalogue.
 */
const PLANS = [
  {
    code: 'free',
    name: 'Free',
    blurb: 'Real lessons, taught one to one, with a short ad between segments.',
    features: [
      'Every lesson in the library, taught one to one, as often as you like',
      'One lesson on a topic of your choosing, once you sign in',
      'Every modern expert',
      'Check-ins, your pace, your choice of board',
      'Your history, saves and likes, kept on your account',
      'Standard voices, with one short skippable ad between segments',
    ],
  },
  {
    code: 'standard',
    name: 'Standard',
    blurb:
      'No ads. Ask the expert anything as you learn, keep every lesson, and share it with friends.',
    features: [
      'Everything in Free, without the ads',
      'Ask anything at any moment, and the expert answers live',
      `${LEGENDS_BY_PLAN.standard} legendary teachers, including Socrates and Ada Lovelace`,
      'Premium voices with the range to carry a long explanation',
      `${BOARDS_BY_PLAN.standard} boards, including whiteboard, blackboard and green board, written in chalk or marker in ${INKS_BY_PLAN.standard} colours`,
      'Any topic you can name, taught as a full lesson',
      'Your lessons as video, with or without your questions, yours to keep',
      'Share any lesson with friends by link',
    ],
    highlight: true,
  },
  {
    code: 'professional',
    name: 'Professional',
    blurb: 'Bring your whole group into one room, with one expert, live.',
    features: [
      'Everything in Standard',
      `All ${LEGENDS_BY_PLAN.professional} legendary teachers, including Newton and Shakespeare`,
      'Every board, including smoked glass',
      'Live rooms for up to 12 people, each on a plan of their own',
      'The expert hears the whole room and answers each person by name',
      'A chat that shows who asked what, so no one is talked over',
      'The whole class recorded, to watch again or export',
      'Host controls to pause, resume and end the session',
    ],
  },
] as const;

export function Pricing() {
  const { participant, api, platform } = useApp();
  const toast = useToast();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Where a successful checkout goes next, held while the arrival survey is up (ADR-0060). */
  const [afterCheckout, setAfterCheckout] = useState<{ returnTo: string | null } | null>(null);
  useEffect(() => {
    api
      .billingStatus()
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, [api]);
  useEffect(() => {
    const r = params.get('checkout');
    if (r === 'success') {
      toast('Welcome aboard. Your plan is active.', 'success');
      // Back to the room whose link brought them here (ADR-0058), if one did.
      let returnTo: string | null = null;
      try {
        returnTo = sessionStorage.getItem(RETURN_TO_KEY);
        sessionStorage.removeItem(RETURN_TO_KEY);
      } catch {
        /* nothing remembered */
      }
      const next = returnTo?.startsWith('/room/') ? returnTo : null;
      // One question first, if the server has it waiting (ADR-0060): how they heard of us.
      // Anything but a clear yes goes straight on; the survey never holds a new subscriber.
      api
        .pendingSurveys()
        .then((p) => {
          if (p.pending.some((s) => s.kind === 'signup_source'))
            setAfterCheckout({ returnTo: next });
          else if (next) navigate(next, { replace: true });
        })
        .catch(() => {
          if (next) navigate(next, { replace: true });
        });
    }
    if (r === 'cancelled') toast('Checkout cancelled.');
  }, [params, toast, navigate, api]);
  const buy = async (plan: 'standard' | 'professional') => {
    trackAction('plan_selected', { plan, interval, from: participant?.plan ?? 'free' });
    setBusy(plan);
    try {
      const url = await api.checkout(plan, interval);
      platform.openExternal(url);
    } catch (error) {
      trackAction('checkout_failed', {
        plan,
        code: error instanceof ApiError ? error.code : 'NETWORK',
      });
      toast(error instanceof Error ? error.message : 'Could not start checkout', 'danger');
    } finally {
      setBusy(null);
    }
  };
  const manage = async () => {
    trackAction('manage_subscription_clicked');
    try {
      platform.openExternal(await api.billingPortal());
    } catch {
      toast('No billing account yet.', 'danger');
    }
  };
  return (
    <div className="flex flex-1 flex-col">
      {afterCheckout ? (
        <SurveyDialog
          open
          kind="signup_source"
          trigger="checkout"
          onDone={() => {
            const next = afterCheckout.returnTo;
            setAfterCheckout(null);
            if (next) navigate(next, { replace: true });
          }}
        />
      ) : null}
      <div className="flex-1 px-6 pt-14 pb-20 sm:px-8">
        <div className="mx-auto flex max-w-[1100px] flex-col items-center">
          <h1 className="text-center text-headline-small">Free to learn. Pay only for more.</h1>
          <p className="mt-3 max-w-[560px] text-center text-body-medium text-on-surface-variant text-pretty">
            Free is a full lesson, every time. Standard removes the ads and lets you ask, keep and
            share. Professional turns a session into a room for your whole group.
          </p>
          {/* Exactly what M3 calls a segmented button: one question, two
              answers, the chosen one filled rather than merely coloured. */}
          <SegmentedButtons
            label="Billing period"
            className="mt-7"
            value={interval}
            onChange={(next) => {
              trackAction('billing_interval_changed', { interval: next });
              setInterval(next);
            }}
            options={[
              { value: 'month', label: 'Monthly' },
              { value: 'year', label: 'Yearly · 2 months free' },
            ]}
          />
          <div className="mt-10 grid w-full grid-cols-1 gap-4 md:grid-cols-3">
            {PLANS.map((p) => {
              const current = participant?.plan === p.code;
              const price = monthlyEquivalentUsd(p.code, interval);
              return (
                <div
                  key={p.code}
                  className={cn(
                    'flex flex-col gap-5 rounded-xl bg-surface-container-low p-6 hairline',
                    'highlight' in p && p.highlight && 'shadow-level3 ring-1 ring-primary',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-title-medium">{p.name}</h3>
                    {'highlight' in p && p.highlight ? (
                      <Pill tone="accent">Most popular</Pill>
                    ) : null}
                    {current ? <Pill tone="live">Your plan</Pill> : null}
                  </div>
                  <div>
                    <span className="font-display text-headline-large font-medium">${price}</span>
                    <span className="ml-1 text-body-medium text-on-surface-variant">
                      / month{interval === 'year' ? ', billed yearly' : ''}
                    </span>
                  </div>
                  <p className="text-body-medium text-on-surface-variant">{p.blurb}</p>
                  <ul className="flex flex-col gap-2">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-body-medium">
                        <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {current && p.code !== 'free' ? (
                    <Button variant="secondary" size="lg" className="mt-auto" onClick={manage}>
                      Manage subscription
                    </Button>
                  ) : (
                    <Button
                      variant={'highlight' in p && p.highlight ? 'primary' : 'secondary'}
                      size="lg"
                      className="mt-auto"
                      disabled={current || p.code === 'free' || enabled === false}
                      loading={busy === p.code}
                      onClick={() =>
                        p.code === 'standard' || p.code === 'professional'
                          ? void buy(p.code)
                          : undefined
                      }
                    >
                      {current
                        ? 'Current plan'
                        : p.code === 'free'
                          ? 'Included'
                          : enabled === false
                            ? 'Coming soon'
                            : `Get ${p.name}`}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-8 text-center text-body-small text-on-surface-dim">
            Cancel any time. Our{' '}
            <Link to="/refunds" className="underline underline-offset-[3px] hover:text-on-surface">
              refund policy
            </Link>{' '}
            applies. Prices in USD.
          </p>
        </div>
      </div>
    </div>
  );
}
