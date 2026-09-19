import { LEGENDS_BY_PLAN } from '@pen/contracts';
import { Button, cn, Pill, SegmentedButtons, useToast } from '@pen/design';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useApp } from '../lib/context.js';

const PLANS = [
  {
    code: 'free',
    name: 'Free',
    monthly: 0,
    annual: 0,
    blurb: 'Learn anything, with a short ad between segments.',
    features: [
      'Solo sessions with every modern expert',
      'Replay your own sessions',
      '3 sessions a day',
      'Standard voices',
      'Skippable ad cards between segments',
    ],
  },
  {
    code: 'standard',
    name: 'Standard',
    monthly: 19,
    annual: 190,
    blurb: 'No ads. Unlimited sessions. Share what you learned.',
    features: [
      'Everything in Free, no ads',
      'Unlimited sessions',
      'Export sessions as video',
      'Share to YouTube and social',
      `${LEGENDS_BY_PLAN.standard} legendary teachers, including Socrates and Ada Lovelace`,
      'Premium voices',
      'Priority preparation on new topics',
    ],
    highlight: true,
  },
  {
    code: 'professional',
    name: 'Professional',
    monthly: 38,
    annual: 380,
    blurb: 'Host rooms with up to 12 people, like a class over a call.',
    features: [
      'Everything in Standard',
      `All ${LEGENDS_BY_PLAN.professional} legendary teachers, Newton and Shakespeare among them`,
      'Rooms with up to 12 participants',
      'Guests ask questions by voice',
      'Shared replays and transcripts',
      'Questions pinned by name',
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
    setBusy(plan);
    try {
      const url = await api.checkout(plan, interval);
      platform.openExternal(url);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not start checkout', 'danger');
    } finally {
      setBusy(null);
    }
  };
  const manage = async () => {
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
            onChange={setInterval}
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
