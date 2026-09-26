import type { ParticipantRepository } from '@pen/db';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { Billing, type Interval } from '../src/billing.js';
import { loadConfig } from '../src/config.js';
import { observer } from '../src/observability.js';

interface Row {
  id: string;
  name: string;
  plan: 'free' | 'standard' | 'professional';
  anonymous: boolean;
  email: string | null;
  provider: string | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/** In-memory stand-in for the participant table: only `get` and `setPlan` are used by Billing. */
class FakeParticipants {
  readonly rows = new Map<string, Row>();
  readonly setPlanCalls: Array<{ id: string; plan: Row['plan']; customer: string | undefined }> =
    [];
  add(partial: Partial<Row> & { id: string }): Row {
    const row: Row = {
      name: 'Sam',
      plan: 'free',
      anonymous: true,
      email: null,
      provider: null,
      stripeCustomerId: null,
      createdAt: new Date(0),
      lastSeenAt: new Date(0),
      ...partial,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async get(id: string): Promise<Row | null> {
    return this.rows.get(id) ?? null;
  }
  /**
   * Honours `since` the way the real repository does, because that ordering
   * guard is the whole subject of `a retried webhook…` below. Everything
   * else here is still the simplest thing that answers.
   */
  async setPlan(
    id: string,
    plan: Row['plan'],
    stripeCustomerId?: string,
    billing?: { interval?: 'month' | 'year' | null; status?: string | null; since?: Date },
  ): Promise<boolean> {
    this.setPlanCalls.push({ id, plan, customer: stripeCustomerId });
    const row = this.rows.get(id);
    if (!row) return false;
    const stored = (row as Row & { planSince?: Date }).planSince;
    if (billing?.since && stored) {
      // The real repository's rule: strictly newer wins, and a cancellation
      // wins a tie (packages/db/src/participants.ts).
      const older = stored.getTime() > billing.since.getTime();
      const tie = stored.getTime() === billing.since.getTime();
      if (older || (tie && plan !== 'free')) return false;
    }
    row.plan = plan;
    if (billing?.since) (row as Row & { planSince?: Date }).planSince = billing.since;
    if (stripeCustomerId) row.stripeCustomerId = stripeCustomerId;
    return true;
  }
  asRepository(): ParticipantRepository {
    return this as unknown as ParticipantRepository;
  }
}

const WEBHOOK_SECRET = 'whsec_test_secret_for_pen_academy';
const PRICES = {
  STRIPE_PRICE_STANDARD_MONTH: 'price_std_month',
  STRIPE_PRICE_STANDARD_YEAR: 'price_std_year',
  STRIPE_PRICE_PROFESSIONAL_MONTH: 'price_pro_month',
  STRIPE_PRICE_PROFESSIONAL_YEAR: 'price_pro_year',
};
const base = {
  NODE_ENV: 'test',
  PEN_JWT_SECRET: 'x'.repeat(40),
  PEN_PUBLIC_URL: 'https://pen.example',
};

function configured(extra: Record<string, string> = {}) {
  return loadConfig({
    ...base,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...PRICES,
    ...extra,
  });
}

/** Stripe's documented scheme: `t=<unix>,v1=HMAC-SHA256(secret, "<t>.<payload>")`. */
function sign(payload: string, secret = WEBHOOK_SECRET): string {
  return new Stripe('sk_test_signer').webhooks.generateTestHeaderString({ payload, secret });
}

function event(type: string, object: Record<string, unknown>, createdAt?: number): string {
  return JSON.stringify({
    id: `evt_${type.replace(/\W/g, '_')}_${createdAt ?? ''}`,
    object: 'event',
    api_version: '2026-06-24.dahlia',
    created: createdAt ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
}

/** Reaches the private Stripe client and stubs the Checkout network call. */
function stubCheckout(billing: Billing, result: { id: string; url: string | null }) {
  const s = (billing as unknown as { stripe: Stripe | null }).stripe;
  if (!s) throw new Error('stripe client not constructed');
  const create = vi.fn().mockResolvedValue(result);
  s.checkout.sessions.create = create as unknown as typeof s.checkout.sessions.create;
  return create;
}

describe('Billing configuration', () => {
  it('is disabled until the secret key and all four price ids exist', () => {
    const participants = new FakeParticipants();
    expect(new Billing(loadConfig(base), participants.asRepository()).enabled).toBe(false);
    for (const missing of Object.keys(PRICES)) {
      const env = { ...base, STRIPE_SECRET_KEY: 'sk_test_123', ...PRICES };
      delete (env as Record<string, string>)[missing];
      expect(new Billing(loadConfig(env), participants.asRepository()).enabled, missing).toBe(
        false,
      );
    }
    expect(new Billing(configured(), participants.asRepository()).enabled).toBe(true);
  });

  it('checkout() throws BILLING_DISABLED when prices are missing, even with a secret key', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1' });
    const billing = new Billing(
      loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_123' }),
      participants.asRepository(),
    );
    await expect(billing.checkout('p_1', 'standard', 'month')).rejects.toThrow('BILLING_DISABLED');
    await expect(
      new Billing(loadConfig(base), participants.asRepository()).checkout(
        'p_1',
        'standard',
        'year',
      ),
    ).rejects.toThrow('BILLING_DISABLED');
  });

  it('webhook() throws BILLING_DISABLED without a webhook secret', async () => {
    const participants = new FakeParticipants();
    const billing = new Billing(
      loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_123', ...PRICES }),
      participants.asRepository(),
    );
    const payload = event('checkout.session.completed', {});
    await expect(billing.webhook(payload, sign(payload))).rejects.toThrow('BILLING_DISABLED');
  });
});

/** Reaches the private Stripe client and answers `prices.retrieve` from a table. */
function stubPrices(billing: Billing, table: Record<string, Partial<Stripe.Price> | Error>) {
  const s = (billing as unknown as { stripe: Stripe | null }).stripe;
  if (!s) throw new Error('stripe client not constructed');
  const retrieve = vi.fn(async (id: string) => {
    const row = table[id];
    if (!row) throw new Error(`No such price: '${id}'`);
    if (row instanceof Error) throw row;
    return row as Stripe.Price;
  });
  s.prices.retrieve = retrieve as unknown as typeof s.prices.retrieve;
  return retrieve;
}

const price = (
  unit_amount: number,
  interval: Interval,
  extra: Partial<Stripe.Price> = {},
): Partial<Stripe.Price> => ({
  active: true,
  currency: 'usd',
  unit_amount,
  recurring: { interval } as Stripe.Price.Recurring,
  ...extra,
});

describe('Billing.verifyPrices (ADR-0056)', () => {
  const agreeing = {
    price_std_month: price(2900, 'month'),
    price_std_year: price(29000, 'year'),
    price_pro_month: price(4900, 'month'),
    price_pro_year: price(49000, 'year'),
  };

  it('is a no-op while billing is disabled', async () => {
    const billing = new Billing(loadConfig(base), new FakeParticipants().asRepository());
    await expect(billing.verifyPrices()).resolves.toEqual([]);
  });

  it('passes the four configured prices when Stripe agrees with the contract', async () => {
    const billing = new Billing(configured(), new FakeParticipants().asRepository());
    const retrieve = stubPrices(billing, agreeing);
    const error = vi.spyOn(observer, 'error');
    const checks = await billing.verifyPrices();
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(retrieve.mock.calls.map((c) => c[0])).toEqual([
      'price_std_month',
      'price_std_year',
      'price_pro_month',
      'price_pro_year',
    ]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it.each([
    ['a stale amount', { price_std_month: price(1900, 'month') }, 'expected 2900 usd, found 1900'],
    ['the wrong currency', { price_pro_year: price(49000, 'year', { currency: 'eur' }) }, 'eur'],
    ['the wrong interval', { price_pro_month: price(4900, 'year') }, 'per year'],
    [
      'an archived price',
      { price_std_year: price(29000, 'year', { active: false }) },
      'active=false',
    ],
    [
      'an id Stripe does not know',
      { price_std_month: new Error("No such price: 'price_std_month'") },
      'No such price',
    ],
  ] as const)(
    'reports %s to Sentry and in the log, and never throws',
    async (_name, wrong, said) => {
      const billing = new Billing(configured(), new FakeParticipants().asRepository());
      stubPrices(billing, { ...agreeing, ...wrong });
      const error = vi.spyOn(observer, 'error').mockImplementation(() => undefined);
      const checks = await billing.verifyPrices();
      expect(checks.filter((c) => !c.ok)).toHaveLength(1);
      expect(error).toHaveBeenCalledTimes(1);
      const [area, err] = error.mock.calls[0] ?? [];
      expect(area).toBe('billing.price_mismatch');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(said);
      error.mockRestore();
    },
  );
});

describe('Billing.checkout', () => {
  const combos: Array<['standard' | 'professional', Interval, string]> = [
    ['standard', 'month', PRICES.STRIPE_PRICE_STANDARD_MONTH],
    ['standard', 'year', PRICES.STRIPE_PRICE_STANDARD_YEAR],
    ['professional', 'month', PRICES.STRIPE_PRICE_PROFESSIONAL_MONTH],
    ['professional', 'year', PRICES.STRIPE_PRICE_PROFESSIONAL_YEAR],
  ];

  it.each(combos)('maps %s/%s to price %s', async (plan, interval, price) => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_new', email: 'sam@example.test' });
    const billing = new Billing(configured(), participants.asRepository());
    const create = stubCheckout(billing, { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });

    await expect(billing.checkout('p_new', plan, interval)).resolves.toBe(
      'https://checkout.stripe.test/cs_1',
    );
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([{ price, quantity: 1 }]);
    expect(params.client_reference_id).toBe('p_new');
    expect(params.metadata).toEqual({ participantId: 'p_new', plan });
    expect(params.subscription_data?.metadata).toEqual({ participantId: 'p_new', plan });
    expect(params.allow_promotion_codes).toBe(true);
    expect(params.success_url).toBe('https://pen.example/pricing?checkout=success');
    expect(params.cancel_url).toBe('https://pen.example/pricing?checkout=cancelled');
    // No Stripe customer yet: the known email prefills Checkout instead.
    expect(params.customer).toBeUndefined();
    expect(params.customer_email).toBe('sam@example.test');
  });

  it('sends Stripe back to the app under its base path', async () => {
    // PEN_PUBLIC_URL carries the prefix when the product is served under one;
    // a return URL without it lands on the coming-soon page, not the app.
    const participants = new FakeParticipants();
    participants.add({ id: 'p_base' });
    const billing = new Billing(
      configured({ PEN_PUBLIC_URL: 'https://sdjust.pen.example/testingxyzbdc' }),
      participants.asRepository(),
    );
    const create = stubCheckout(billing, { id: 'cs_b', url: 'https://checkout.stripe.test/cs_b' });
    await billing.checkout('p_base', 'standard', 'month');
    const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.success_url).toBe(
      'https://sdjust.pen.example/testingxyzbdc/pricing?checkout=success',
    );
    expect(params.cancel_url).toBe(
      'https://sdjust.pen.example/testingxyzbdc/pricing?checkout=cancelled',
    );
  });

  it('reuses an existing Stripe customer instead of the email', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_old', email: 'sam@example.test', stripeCustomerId: 'cus_42' });
    const billing = new Billing(configured(), participants.asRepository());
    const create = stubCheckout(billing, { id: 'cs_2', url: 'https://checkout.stripe.test/cs_2' });
    await billing.checkout('p_old', 'professional', 'year');
    const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.customer).toBe('cus_42');
    expect(params.customer_email).toBeUndefined();
  });

  it('omits both customer fields for an anonymous participant without email', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_anon' });
    const billing = new Billing(configured(), participants.asRepository());
    const create = stubCheckout(billing, { id: 'cs_3', url: 'https://checkout.stripe.test/cs_3' });
    await billing.checkout('p_anon', 'standard', 'month');
    const params = create.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.customer).toBeUndefined();
    expect(params.customer_email).toBeUndefined();
  });

  it('fails fast for an unknown participant and when Stripe returns no URL', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const create = stubCheckout(billing, { id: 'cs_4', url: null });
    await expect(billing.checkout('p_missing', 'standard', 'month')).rejects.toThrow(
      'PARTICIPANT_NOT_FOUND',
    );
    expect(create).not.toHaveBeenCalled();
    await expect(billing.checkout('p_1', 'standard', 'month')).rejects.toThrow('CHECKOUT_NO_URL');
  });
});

describe('Billing.webhook', () => {
  it('checkout.session.completed sets the plan and the Stripe customer', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      client_reference_id: 'p_1',
      customer: 'cus_1',
      metadata: { participantId: 'p_1', plan: 'standard' },
    });
    await expect(billing.webhook(payload, sign(payload))).resolves.toEqual({
      handled: true,
      type: 'checkout.session.completed',
    });
    expect(participants.setPlanCalls).toEqual([{ id: 'p_1', plan: 'standard', customer: 'cus_1' }]);
    expect(participants.rows.get('p_1')).toMatchObject({
      plan: 'standard',
      stripeCustomerId: 'cus_1',
    });
  });

  it('checkout.session.completed reads the participant from metadata and an expanded customer object', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_2' });
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('checkout.session.completed', {
      id: 'cs_2',
      object: 'checkout.session',
      client_reference_id: null,
      customer: { id: 'cus_2', object: 'customer' },
      metadata: { participantId: 'p_2', plan: 'professional' },
    });
    await billing.webhook(payload, sign(payload));
    expect(participants.setPlanCalls).toEqual([
      { id: 'p_2', plan: 'professional', customer: 'cus_2' },
    ]);
  });

  it('checkout.session.completed with an unknown plan changes nothing but is still handled', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_3' });
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('checkout.session.completed', {
      id: 'cs_3',
      object: 'checkout.session',
      client_reference_id: 'p_3',
      customer: 'cus_3',
      metadata: { participantId: 'p_3', plan: 'enterprise' },
    });
    await expect(billing.webhook(payload, sign(payload))).resolves.toMatchObject({ handled: true });
    expect(participants.setPlanCalls).toEqual([]);
    expect(participants.rows.get('p_3')?.plan).toBe('free');
  });

  it('customer.subscription.deleted resets the participant to free', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1', plan: 'standard', stripeCustomerId: 'cus_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('customer.subscription.deleted', {
      id: 'sub_1',
      object: 'subscription',
      status: 'canceled',
      customer: 'cus_1',
      metadata: { participantId: 'p_1', plan: 'standard' },
    });
    await expect(billing.webhook(payload, sign(payload))).resolves.toEqual({
      handled: true,
      type: 'customer.subscription.deleted',
    });
    expect(participants.setPlanCalls).toEqual([{ id: 'p_1', plan: 'free', customer: 'cus_1' }]);
    expect(participants.rows.get('p_1')?.plan).toBe('free');
  });

  it('customer.subscription.updated keeps the plan while active/past_due and drops it otherwise', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1', plan: 'professional', stripeCustomerId: 'cus_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const sub = (status: string) =>
      event('customer.subscription.updated', {
        id: 'sub_1',
        object: 'subscription',
        status,
        customer: { id: 'cus_1', object: 'customer' },
        metadata: { participantId: 'p_1', plan: 'professional' },
      });
    for (const status of ['active', 'trialing', 'past_due']) {
      const payload = sub(status);
      await billing.webhook(payload, sign(payload));
      expect(participants.rows.get('p_1')?.plan, status).toBe('professional');
    }
    const unpaid = sub('unpaid');
    await billing.webhook(unpaid, sign(unpaid));
    expect(participants.rows.get('p_1')?.plan).toBe('free');
  });

  it('a subscription event without a participantId is not handled', async () => {
    const participants = new FakeParticipants();
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('customer.subscription.deleted', {
      id: 'sub_x',
      object: 'subscription',
      status: 'canceled',
      customer: 'cus_x',
      metadata: {},
    });
    await expect(billing.webhook(payload, sign(payload))).resolves.toEqual({
      handled: false,
      type: 'customer.subscription.deleted',
    });
    expect(participants.setPlanCalls).toEqual([]);
  });

  it('an unrelated event is acknowledged but not handled', async () => {
    const participants = new FakeParticipants();
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('invoice.paid', { id: 'in_1', object: 'invoice' });
    await expect(billing.webhook(payload, sign(payload))).resolves.toEqual({
      handled: false,
      type: 'invoice.paid',
    });
    expect(participants.setPlanCalls).toEqual([]);
  });

  it('rejects a bad signature, a tampered payload and a stale timestamp without touching plans', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const payload = event('checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      client_reference_id: 'p_1',
      customer: 'cus_1',
      metadata: { participantId: 'p_1', plan: 'standard' },
    });
    await expect(billing.webhook(payload, sign(payload, 'whsec_wrong'))).rejects.toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
    const tampered = payload.replace('"plan":"standard"', '"plan":"professional"');
    await expect(billing.webhook(tampered, sign(payload))).rejects.toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
    const stale = new Stripe('sk_test_signer').webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    await expect(billing.webhook(payload, stale)).rejects.toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
    await expect(billing.webhook(payload, 'garbage')).rejects.toThrow();
    expect(participants.setPlanCalls).toEqual([]);
    expect(participants.rows.get('p_1')?.plan).toBe('free');
  });
});

/**
 * Stripe delivers at least once and in no particular order, and retries a
 * failed delivery for days. So the event that made a subscription active can
 * arrive *after* the one that cancelled it — and an unconditional write then
 * restores a cancelled subscriber's entitlements, permanently: the row
 * afterwards looks like an ordinary paying customer, and no later event is
 * coming to correct it.
 */
describe('a retried webhook that arrives after the one that superseded it', () => {
  const SUBSCRIBED = 1_789_000_000;
  const CANCELLED = SUBSCRIBED + 60;

  it('does not bring a cancelled subscription back', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_1', plan: 'standard', stripeCustomerId: 'cus_1' });
    const billing = new Billing(configured(), participants.asRepository());
    const subscription = {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      metadata: { participantId: 'p_1', plan: 'standard' },
    };

    const cancelled = event(
      'customer.subscription.deleted',
      { ...subscription, status: 'canceled' },
      CANCELLED,
    );
    await billing.webhook(cancelled, sign(cancelled));
    expect(participants.rows.get('p_1')?.plan).toBe('free');

    // A minute older, delivered now: the update Stripe could not deliver
    // when it happened.
    const retried = event(
      'customer.subscription.updated',
      { ...subscription, status: 'active' },
      SUBSCRIBED,
    );
    await expect(billing.webhook(retried, sign(retried))).resolves.toMatchObject({
      handled: true,
    });

    expect(participants.rows.get('p_1')?.plan, 'the cancellation stands').toBe('free');
  });

  it('still applies one that really is newer', async () => {
    const participants = new FakeParticipants();
    participants.add({ id: 'p_2', plan: 'free', stripeCustomerId: 'cus_2' });
    const billing = new Billing(configured(), participants.asRepository());
    const subscription = {
      id: 'sub_2',
      object: 'subscription',
      customer: 'cus_2',
      metadata: { participantId: 'p_2', plan: 'professional' },
    };
    const first = event(
      'customer.subscription.updated',
      { ...subscription, status: 'active' },
      SUBSCRIBED,
    );
    await billing.webhook(first, sign(first));
    expect(participants.rows.get('p_2')?.plan).toBe('professional');

    const cancelled = event(
      'customer.subscription.deleted',
      { ...subscription, status: 'canceled' },
      CANCELLED,
    );
    await billing.webhook(cancelled, sign(cancelled));
    expect(participants.rows.get('p_2')?.plan).toBe('free');
  });
});
