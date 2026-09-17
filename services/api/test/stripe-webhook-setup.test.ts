import { describe, expect, it } from 'vitest';
import { BILLING_WEBHOOK_EVENTS } from '../src/billing.js';
import { decideWebhookEndpoint, upsertEnvLine } from '../src/stripe-webhook-setup.js';

const URL = 'https://penplayground.com/api/billing/webhook';

describe('decideWebhookEndpoint', () => {
  it('creates when no endpoint has our URL (other apps’ endpoints are ignored)', () => {
    expect(
      decideWebhookEndpoint(
        [
          {
            id: 'we_other',
            url: 'https://api.example/hook',
            status: 'enabled',
            enabled_events: ['*'],
          },
        ],
        URL,
      ),
    ).toEqual({ action: 'create' });
    expect(decideWebhookEndpoint([], URL)).toEqual({ action: 'create' });
  });

  it('reuses an endpoint that already listens to every event we handle (or to everything)', () => {
    const ours = {
      id: 'we_1',
      url: URL,
      status: 'enabled',
      enabled_events: [...BILLING_WEBHOOK_EVENTS],
    };
    expect(decideWebhookEndpoint([ours], URL)).toEqual({ action: 'reuse', id: 'we_1' });
    expect(decideWebhookEndpoint([{ ...ours, enabled_events: ['*'] }], URL)).toEqual({
      action: 'reuse',
      id: 'we_1',
    });
  });

  it('extends the events of an endpoint that misses some, keeping the ones it had', () => {
    const partial = {
      id: 'we_1',
      url: URL,
      status: 'enabled',
      enabled_events: ['checkout.session.completed', 'invoice.paid'],
    };
    expect(decideWebhookEndpoint([partial], URL)).toEqual({
      action: 'update',
      id: 'we_1',
      enabled_events: [...new Set([...partial.enabled_events, ...BILLING_WEBHOOK_EVENTS])].sort(),
    });
  });

  it('does not reuse a disabled endpoint', () => {
    expect(
      decideWebhookEndpoint(
        [{ id: 'we_dead', url: URL, status: 'disabled', enabled_events: ['*'] }],
        URL,
      ),
    ).toEqual({ action: 'create' });
  });

  it('the handled events are exactly the ones billing.ts switches on', () => {
    expect([...BILLING_WEBHOOK_EVENTS].sort()).toEqual([
      'checkout.session.completed',
      'customer.subscription.deleted',
      'customer.subscription.updated',
    ]);
  });
});

describe('upsertEnvLine', () => {
  it('replaces the existing value in place', () => {
    const text =
      '# Billing\nSTRIPE_SECRET_KEY=sk_test_1\nSTRIPE_WEBHOOK_SECRET=whsec_old\nOTHER=1\n';
    expect(upsertEnvLine(text, 'STRIPE_WEBHOOK_SECRET', 'whsec_new')).toBe(
      '# Billing\nSTRIPE_SECRET_KEY=sk_test_1\nSTRIPE_WEBHOOK_SECRET=whsec_new\nOTHER=1\n',
    );
  });

  it('replaces an empty value and never touches a key that merely shares a prefix', () => {
    const text = 'STRIPE_WEBHOOK_SECRET_OLD=x\nSTRIPE_WEBHOOK_SECRET=\n';
    expect(upsertEnvLine(text, 'STRIPE_WEBHOOK_SECRET', 'whsec_1')).toBe(
      'STRIPE_WEBHOOK_SECRET_OLD=x\nSTRIPE_WEBHOOK_SECRET=whsec_1\n',
    );
  });

  it('appends when the key is missing, on its own line', () => {
    expect(upsertEnvLine('A=1', 'STRIPE_WEBHOOK_SECRET', 'whsec_1')).toBe(
      'A=1\nSTRIPE_WEBHOOK_SECRET=whsec_1\n',
    );
    expect(upsertEnvLine('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
    expect(upsertEnvLine('', 'B', '2')).toBe('B=2\n');
  });
});
