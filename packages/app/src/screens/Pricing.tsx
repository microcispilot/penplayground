import { BOARDS_BY_PLAN, LEGENDS_BY_PLAN } from '@pen/contracts';
import { Button, cn, Pill, SegmentedButtons, useToast } from '@pen/design';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../api/client.js';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';

/**
 * What each plan says for itself.
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
    monthly: 0,
    annual: 0,
    blurb: 'Real sessions, not a trial — three a day, with a short ad between segments.',
    features: [
      'Every lesson that is already prepared, taught one to one',
      'Three sessions a day',
      'Every modern expert',
      'Replay any lesson as a session of your own, questions and all',
      'Standard voices',
      'One short, skippable ad between segments',
    ],
  },
  {
    code: 'standard',
    name: 'Standard',
    monthly: 19,
    annual: 190,
    blurb: 'No ads, no daily count, and what you learn is yours to keep and to send on.',
    features: [
      'Everything in Free, with the ads gone',
      'Unlimited sessions — no daily count',
      `${LEGENDS_BY_PLAN.standard} legendary teachers, Socrates and Ada Lovelace among them`,
      'Premium voices, with the range to carry a long explanation',
      `${BOARDS_BY_PLAN.standard} boards to be taught on \u2014 whiteboard, blackboard, green board \u2014 and the chalk or marker to match`,
      'Any topic you can name: nobody has prepared it yet, so it is prepared for you',
      'Your recording as video, with or without your questions, yours to keep',
      'Share a link to any lesson',
    ],
    highlight: true,
  },
  {
    code: 'professional',
    name: 'Professional',
    monthly: 38,
    annual: 380,
    blurb: 'Turn a session into a room: one expert, your whole group, at the same time.',
    features: [
      'Everything in Standard',
      `All ${LEGENDS_BY_PLAN.professional} legendary teachers — Newton and Shakespeare among them`,
      'Every board, smoked glass and the full chalk set included',
      'Rooms for up to 12 people, taught live',
      'The expert hears the whole room and takes each question by name',
      'Who asked what, in the chat, so nobody is talked over',
      'The whole class recorded for you to watch or export, like a call recording',
      'Host controls: pause, resume, end',
    ],
  },
] as const;

export function Pricing() {
  const { participant, api, platform } = useApp();
  const toast = useToast();
  const [params] = useSearchParams();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api
      .billingStatus()
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, [api]);
  useEffect(() => {
    const r = params.get('checkout');
    if (r === 'success') toast('Welcome aboard — your plan is active.', 'success');
    if (r === 'cancelled') toast('Checkout cancelled.');
  }, [params, toast]);
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
      <div className="flex-1 px-6 pt-14 pb-20 sm:px-8">
        <div className="mx-auto flex max-w-[1100px] flex-col items-center">
          <h1 className="text-center text-headline-small">Free to learn. Pay only for more.</h1>
          <p className="mt-3 max-w-[560px] text-center text-body-medium text-on-surface-variant text-pretty">
            Sessions are cheap enough to run that the free plan is real. Standard removes ads and
            unlocks sharing; Professional turns a session into a room.
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
              const price = interval === 'month' ? p.monthly : Math.round(p.annual / 12);
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
            Cancel any time. Prices in USD.
          </p>
        </div>
      </div>
    </div>
  );
}
