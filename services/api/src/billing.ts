import { type BillingInterval, PLAN_PRICES_USD, type PlanCode } from '@pen/contracts';
import type { ParticipantRepository, StatsRepository } from '@pen/db';
import Stripe from 'stripe';
import type { Config } from './config.js';
import { logger } from './logger.js';
import { observer } from './observability.js';
import { publicUrl } from './urls.js';

export type Interval = 'month' | 'year';

/** The Stripe events `Billing.webhook` acts on; the endpoint registration script subscribes to exactly these. */
export const BILLING_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export interface BillingPlanPrices {
  standard: Record<Interval, string>;
  professional: Record<Interval, string>;
}

/** One configured Stripe price held against the contract (`PLAN_PRICES_USD`). */
export interface PriceCheck {
  plan: Exclude<PlanCode, 'free'>;
  interval: BillingInterval;
  ok: boolean;
  expectedCents: number;
  unitAmount: number | null;
  currency: string | null;
  recurring: string | null;
  active: boolean | null;
  /** Stripe's own words when the price could not be read at all. */
  error?: string;
}

/**
 * Stripe Billing behind three operations: start checkout, open the portal,
 * apply a webhook. Plans live on the participant row; every authenticated
 * request re-reads it, so a webhook changes entitlements immediately.
 */
export class Billing {
  readonly enabled: boolean;
  private readonly stripe: Stripe | null;
  private readonly prices: BillingPlanPrices | null;

  constructor(
    private readonly cfg: Config,
    private readonly participants: ParticipantRepository,
    /**
     * The subscription's own history (ADR-0027). `participants.plan` is the
     * present tense; conversion, churn and the monthly/yearly split are all
     * questions about how the present came about, and only a log answers
     * them. Optional so a test can build `Billing` without one.
     */
    private readonly stats?: Pick<StatsRepository, 'recordPlanEvent'>,
    /** PostHog: every plan change is an event with the plan and the interval, never an amount a person typed (ADR-0060). */
    private readonly analytics?: {
      capture(
        distinctId: string,
        event: string,
        props?: Record<string, string | number | boolean | null>,
      ): void;
    },
  ) {
    const complete =
      cfg.STRIPE_SECRET_KEY &&
      cfg.STRIPE_PRICE_STANDARD_MONTH &&
      cfg.STRIPE_PRICE_STANDARD_YEAR &&
      cfg.STRIPE_PRICE_PROFESSIONAL_MONTH &&
      cfg.STRIPE_PRICE_PROFESSIONAL_YEAR;
    this.enabled = Boolean(complete);
    this.stripe = cfg.STRIPE_SECRET_KEY
      ? new Stripe(cfg.STRIPE_SECRET_KEY, {
          apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
          appInfo: { name: 'pen-academy' },
        })
      : null;
    this.prices = complete
      ? {
          standard: {
            month: cfg.STRIPE_PRICE_STANDARD_MONTH ?? '',
            year: cfg.STRIPE_PRICE_STANDARD_YEAR ?? '',
          },
          professional: {
            month: cfg.STRIPE_PRICE_PROFESSIONAL_MONTH ?? '',
            year: cfg.STRIPE_PRICE_PROFESSIONAL_YEAR ?? '',
          },
        }
      : null;
    if (!this.enabled)
      logger.warn('billing disabled: set STRIPE_SECRET_KEY and the four STRIPE_PRICE_* ids');
  }

  /**
   * Read each configured price back from Stripe and hold it against the
   * contract: the amount the page shows is `PLAN_PRICES_USD`, and the amount
   * Checkout charges is whatever the `STRIPE_PRICE_*` id points at. The two
   * are set in different places by different hands, so the API checks at boot
   * that they agree and says so loudly (Sentry, `billing.price_mismatch`)
   * when they do not. It never throws, and never blocks the boot: a wrong
   * price is a fault to report, not a reason to serve nothing.
   */
  async verifyPrices(): Promise<PriceCheck[]> {
    if (!this.stripe || !this.prices) return [];
    const checks: PriceCheck[] = [];
    for (const plan of ['standard', 'professional'] as const) {
      for (const interval of ['month', 'year'] as const) {
        const expectedCents = PLAN_PRICES_USD[plan][interval] * 100;
        try {
          const price = await this.stripe.prices.retrieve(this.prices[plan][interval]);
          const recurring = price.recurring?.interval ?? null;
          checks.push({
            plan,
            interval,
            expectedCents,
            unitAmount: price.unit_amount,
            currency: price.currency,
            recurring,
            active: price.active,
            ok:
              price.active &&
              price.unit_amount === expectedCents &&
              price.currency === 'usd' &&
              recurring === interval,
          });
        } catch (error) {
          checks.push({
            plan,
            interval,
            expectedCents,
            unitAmount: null,
            currency: null,
            recurring: null,
            active: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const wrong = checks.filter((c) => !c.ok);
    if (wrong.length > 0) {
      const detail = wrong
        .map(
          (c) =>
            `${c.plan}/${c.interval}: expected ${c.expectedCents} usd, ` +
            (c.error ??
              `found ${c.unitAmount} ${c.currency} per ${c.recurring}, active=${c.active}`),
        )
        .join('; ');
      logger.error(
        { wrong },
        `billing: configured Stripe prices disagree with the contract: ${detail}`,
      );
      observer.error('billing.price_mismatch', new Error(detail), { wrong });
    } else {
      logger.info('billing: the four Stripe prices match the contract');
    }
    return checks;
  }

  /** Returns the Checkout URL for a plan; the participant id rides in client_reference_id and metadata. */
  async checkout(
    participantId: string,
    plan: Exclude<PlanCode, 'free'>,
    interval: Interval,
  ): Promise<string> {
    if (!this.stripe || !this.prices) throw new Error('BILLING_DISABLED');
    const participant = await this.participants.get(participantId);
    if (!participant) throw new Error('PARTICIPANT_NOT_FOUND');
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: this.prices[plan][interval], quantity: 1 }],
      client_reference_id: participantId,
      ...(participant.stripeCustomerId
        ? { customer: participant.stripeCustomerId }
        : participant.email
          ? { customer_email: participant.email }
          : {}),
      subscription_data: { metadata: { participantId, plan } },
      metadata: { participantId, plan },
      allow_promotion_codes: true,
      // Stripe sends the learner back to the app itself, which may be served
      // under a path prefix — `publicUrl` is what carries it (urls.ts).
      success_url: publicUrl(this.cfg.PEN_PUBLIC_URL, '/pricing?checkout=success'),
      cancel_url: publicUrl(this.cfg.PEN_PUBLIC_URL, '/pricing?checkout=cancelled'),
    });
    if (!session.url) throw new Error('CHECKOUT_NO_URL');
    return session.url;
  }

  async portal(participantId: string): Promise<string> {
    if (!this.stripe) throw new Error('BILLING_DISABLED');
    const participant = await this.participants.get(participantId);
    if (!participant?.stripeCustomerId) throw new Error('NO_CUSTOMER');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: participant.stripeCustomerId,
      return_url: publicUrl(this.cfg.PEN_PUBLIC_URL, '/pricing'),
      ...(this.cfg.STRIPE_PORTAL_CONFIGURATION_ID
        ? { configuration: this.cfg.STRIPE_PORTAL_CONFIGURATION_ID }
        : {}),
    });
    return session.url;
  }

  /** Verifies the signature and applies subscription lifecycle events. Idempotent by construction (plan is derived from the event). */
  async webhook(rawBody: string, signature: string): Promise<{ handled: boolean; type: string }> {
    if (!this.stripe || !this.cfg.STRIPE_WEBHOOK_SECRET) throw new Error('BILLING_DISABLED');
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.cfg.STRIPE_WEBHOOK_SECRET,
    );
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const participantId = s.client_reference_id ?? s.metadata?.participantId;
        const plan = planFrom(s.metadata?.plan);
        const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        // Stripe is the only place that knows monthly from yearly, and the
        // checkout event does not carry the price. Reading the subscription
        // is one call, and failing it costs the interval and nothing else.
        const terms = await this.termsOf(s.subscription);
        if (participantId && plan) {
          const before = await this.participants.get(participantId);
          const applied = await this.participants.setPlan(participantId, plan, customer, {
            interval: terms.interval,
            status: terms.status ?? 'active',
            since: new Date(event.created * 1000),
          });
          // The ledger is written either way: an event that arrived out of
          // order still happened, and `recordPlanEvent` is deduplicated by
          // event, so the history stays true even when the row does not move.
          this.record(event.created * 1000, participantId, before?.plan ?? null, plan, terms);
          if (!applied) observer.event('billing.out_of_order', { type: event.type, plan });
          this.analytics?.capture(participantId, 'checkout_completed', {
            plan,
            interval: terms.interval,
            amountCents: terms.amountCents,
          });
        }
        observer.event('billing.checkout_completed', {
          plan: plan ?? 'unknown',
          hasCustomer: Boolean(customer),
          interval: terms.interval ?? 'unknown',
        });
        return { handled: true, type: event.type };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const participantId = sub.metadata?.participantId;
        if (!participantId) return { handled: false, type: event.type };
        const active =
          sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
        const plan =
          event.type === 'customer.subscription.deleted' || !active
            ? 'free'
            : (planFrom(sub.metadata?.plan) ?? 'free');
        const terms = termsOfSubscription(sub);
        const before = await this.participants.get(participantId);
        const applied = await this.participants.setPlan(
          participantId,
          plan,
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          {
            // A cancellation keeps the interval it was on: it is how the row
            // reads afterwards, and churn is counted by interval.
            interval: plan === 'free' ? (before?.planInterval ?? terms.interval) : terms.interval,
            // `cancelling` while Stripe still bills to the period's end (ADR-0060): the row
            // says a leaving is under way before the plan itself changes.
            status: terms.status,
            since: new Date(event.created * 1000),
          },
        );
        this.record(event.created * 1000, participantId, before?.plan ?? null, plan, terms);
        this.analytics?.capture(participantId, 'subscription_changed', {
          type: event.type,
          plan,
          fromPlan: before?.plan ?? null,
          status: terms.status,
          interval: terms.interval,
        });
        observer.event('billing.subscription', {
          type: event.type,
          status: sub.status,
          plan,
          // False is the interesting one: a retry that arrived after the
          // event which superseded it, and was refused rather than applied.
          applied,
        });
        return { handled: true, type: event.type };
      }
      default:
        return { handled: false, type: event.type };
    }
  }
  /**
   * What a subscription is billed at. Never throws: an interval we could not
   * read is null, which reads as "unknown" in the statistics rather than as a
   * wrong answer.
   */
  private async termsOf(subscription: unknown): Promise<SubscriptionTerms> {
    if (subscription && typeof subscription === 'object')
      return termsOfSubscription(subscription as Stripe.Subscription);
    if (typeof subscription !== 'string' || !this.stripe) return NO_TERMS;
    try {
      return termsOfSubscription(await this.stripe.subscriptions.retrieve(subscription));
    } catch (error) {
      observer.error('billing.subscription_lookup', error);
      return NO_TERMS;
    }
  }

  /** A plan change, for the subscription report. Never fatal to the webhook. */
  private record(
    at: number,
    participantId: string,
    fromPlan: string | null,
    toPlan: string,
    terms: SubscriptionTerms,
  ): void {
    void this.stats
      ?.recordPlanEvent({
        participantId,
        at,
        fromPlan,
        toPlan,
        interval: terms.interval,
        status: terms.status,
        amountCents: terms.amountCents,
        currency: terms.currency,
      })
      .catch((error: unknown) => observer.error('billing.plan_event', error, { participantId }));
  }
}

export interface SubscriptionTerms {
  interval: Interval | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
}

const NO_TERMS: SubscriptionTerms = {
  interval: null,
  status: null,
  amountCents: null,
  currency: null,
};

/** The first item's price is the plan's price: every checkout here has exactly one line. */
export function termsOfSubscription(sub: Stripe.Subscription): SubscriptionTerms {
  const price = sub.items?.data?.[0]?.price;
  // Stripe types the interval as an open string union, so it is narrowed here
  // rather than trusted: anything but the two we sell is recorded as unknown.
  const interval: string | undefined = price?.recurring?.interval;
  return {
    interval: interval === 'month' || interval === 'year' ? interval : null,
    // A subscription set to end at the period's close is still `active` to Stripe; to us it is
    // leaving, and the exit survey asks why while the learner is still here (ADR-0060).
    status: sub.cancel_at_period_end ? 'cancelling' : (sub.status ?? null),
    amountCents: typeof price?.unit_amount === 'number' ? price.unit_amount : null,
    currency: price?.currency ?? null,
  };
}

function planFrom(value: unknown): Exclude<PlanCode, 'free'> | null {
  return value === 'standard' || value === 'professional' ? value : null;
}
