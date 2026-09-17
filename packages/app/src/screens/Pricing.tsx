import { Button, cn, Pill } from '@pen/design';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppHeader } from '../components/AppHeader.js';
import { useApp } from '../lib/context.js';

const PLANS = [
  {
    code: 'free',
    name: 'Free',
    monthly: 0,
    annual: 0,
    blurb: 'Learn anything, with a short ad between segments.',
    features: [
      'Solo sessions with any expert',
      'Replay your own sessions',
      '3 sessions a day',
      'Standard voices',
      'Skippable ad cards between segments',
    ],
  },
  {
    code: 'plus',
    name: 'Plus',
    monthly: 12,
    annual: 120,
    blurb: 'No ads. Unlimited sessions. Share what you learned.',
    features: [
      'Everything in Free, no ads',
      'Unlimited sessions',
      'Export sessions as video',
      'Share to YouTube and social',
      'Premium voices and legends',
      'Priority preparation on new topics',
    ],
    highlight: true,
  },
  {
    code: 'classroom',
    name: 'Classroom',
    monthly: 29,
    annual: 290,
    blurb: 'Host rooms with up to 12 people, like a class over a call.',
    features: [
      'Everything in Plus',
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
  const buy = async (plan: 'plus' | 'classroom') => {
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
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1 px-7 pt-14 pb-20">
        <div className="mx-auto flex max-w-[1100px] flex-col items-center">
          <h1 className="text-center text-2xl tracking-[-0.03em]">
            Free to learn. Pay only for more.
          </h1>
          <p className="mt-3 max-w-[560px] text-center text-[15px] text-fg-2 text-pretty">
            Sessions are cheap enough to run that the free plan is real. Plus removes ads and
            unlocks sharing; Classroom turns a session into a room.
          </p>
          <div className="mt-7 inline-flex overflow-hidden rounded-[var(--radius-md)] hairline">
            {(['month', 'year'] as const).map((i) => (
              <button
                key={i}
                type="button"
                className={cn(
                  'px-4 py-2 text-sm',
                  interval === i ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-surface-2',
                )}
                onClick={() => setInterval(i)}
              >
                {i === 'month' ? 'Monthly' : 'Yearly · 2 months free'}
              </button>
            ))}
          </div>
          <div className="mt-10 grid w-full grid-cols-1 gap-4 md:grid-cols-3">
            {PLANS.map((p) => {
              const current = participant?.plan === p.code;
              const price = interval === 'month' ? p.monthly : Math.round(p.annual / 12);
              return (
                <div
                  key={p.code}
                  className={cn(
                    'flex flex-col gap-5 rounded-[var(--radius-xl)] bg-surface p-6 hairline',
                    'highlight' in p && p.highlight && 'shadow-pop ring-1 ring-accent',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg">{p.name}</h3>
                    {'highlight' in p && p.highlight ? (
                      <Pill tone="accent">Most popular</Pill>
                    ) : null}
                    {current ? <Pill tone="live">Your plan</Pill> : null}
                  </div>
                  <div>
                    <span className="font-display text-[40px] leading-none tracking-[-0.03em]">
                      ${price}
                    </span>
                    <span className="ml-1 text-sm text-fg-2">
                      / month{interval === 'year' ? ', billed yearly' : ''}
                    </span>
                  </div>
                  <p className="text-sm text-fg-2">{p.blurb}</p>
                  <ul className="flex flex-col gap-2">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant={'highlight' in p && p.highlight ? 'primary' : 'secondary'}
                    size="lg"
                    className="mt-auto"
                    disabled={current || p.code === 'free'}
                    onClick={() => undefined}
                  >
                    {current ? 'Current plan' : p.code === 'free' ? 'Included' : 'Coming soon'}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mt-8 text-center text-xs text-fg-3">
            Prices are proposals pending a business decision; checkout opens once billing is
            connected.
          </p>
        </div>
      </main>
    </div>
  );
}
