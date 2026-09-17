import type { PlanCode } from '@pen/contracts';
import type { ParticipantRepository } from '@pen/db';
import Stripe from 'stripe';
import type { Config } from './config.js';
import { logger } from './logger.js';
import { observer } from './observability.js';

export type Interval = 'month' | 'year';

export interface BillingPlanPrices {
  plus: Record<Interval, string>;
  classroom: Record<Interval, string>;
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
  ) {
    const complete =
      cfg.STRIPE_SECRET_KEY &&
      cfg.STRIPE_PRICE_PLUS_MONTH &&
      cfg.STRIPE_PRICE_PLUS_YEAR &&
      cfg.STRIPE_PRICE_CLASSROOM_MONTH &&
      cfg.STRIPE_PRICE_CLASSROOM_YEAR;
    this.enabled = Boolean(complete);
    this.stripe = cfg.STRIPE_SECRET_KEY
      ? new Stripe(cfg.STRIPE_SECRET_KEY, {
          apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
          appInfo: { name: 'pen-academy' },
        })
      : null;
    this.prices = complete
      ? {
          plus: {
            month: cfg.STRIPE_PRICE_PLUS_MONTH ?? '',
            year: cfg.STRIPE_PRICE_PLUS_YEAR ?? '',
          },
          classroom: {
            month: cfg.STRIPE_PRICE_CLASSROOM_MONTH ?? '',
            year: cfg.STRIPE_PRICE_CLASSROOM_YEAR ?? '',
          },
        }
      : null;
    if (!this.enabled)
      logger.warn('billing disabled: set STRIPE_SECRET_KEY and the four STRIPE_PRICE_* ids');
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
      success_url: `${this.cfg.PEN_PUBLIC_URL}/pricing?checkout=success`,
      cancel_url: `${this.cfg.PEN_PUBLIC_URL}/pricing?checkout=cancelled`,
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
      return_url: `${this.cfg.PEN_PUBLIC_URL}/pricing`,
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
        const participantId = s.client_reference_id ?? s.metadata?.['participantId'];
        const plan = planFrom(s.metadata?.['plan']);
        const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        if (participantId && plan) await this.participants.setPlan(participantId, plan, customer);
        observer.event('billing.checkout_completed', {
          plan: plan ?? 'unknown',
          hasCustomer: Boolean(customer),
        });
        return { handled: true, type: event.type };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const participantId = sub.metadata?.['participantId'];
        if (!participantId) return { handled: false, type: event.type };
        const active =
          sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
        const plan =
          event.type === 'customer.subscription.deleted' || !active
            ? 'free'
            : (planFrom(sub.metadata?.['plan']) ?? 'free');
        await this.participants.setPlan(
          participantId,
          plan,
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        );
        observer.event('billing.subscription', { type: event.type, status: sub.status, plan });
        return { handled: true, type: event.type };
      }
      default:
        return { handled: false, type: event.type };
    }
  }
}

function planFrom(value: unknown): Exclude<PlanCode, 'free'> | null {
  return value === 'plus' || value === 'classroom' ? value : null;
}
