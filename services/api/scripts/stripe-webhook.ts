import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { z } from 'zod';
import { BILLING_WEBHOOK_EVENTS } from '../src/billing.js';
import { decideWebhookEndpoint, upsertEnvLine } from '../src/stripe-webhook-setup.js';

/**
 * Register (idempotently) the Stripe webhook endpoint the API's billing
 * handler answers, and put its signing secret into `.env`:
 *
 *   pnpm --filter @pen/api stripe:webhook            # https://penplayground.com/api/billing/webhook
 *   PEN_WEBHOOK_URL=https://staging.example/api/billing/webhook pnpm --filter @pen/api stripe:webhook
 *   pnpm --filter @pen/api stripe:webhook -- --rotate   # delete + recreate to mint a new secret
 *
 * Stripe only reveals a signing secret at creation, so an endpoint that
 * already exists is reused (its events extended if needed) and `.env` keeps
 * the secret it has — `--rotate` is the way to get a fresh one. The secret
 * key comes from `.env` (`node --env-file`), and the file written is the
 * repository's `.env` unless `--env <path>` says otherwise.
 */
const Env = z.object({
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required (sandbox key in .env)'),
  PEN_WEBHOOK_URL: z.string().url().default('https://penplayground.com/api/billing/webhook'),
});

const args = process.argv.slice(2);
const rotate = args.includes('--rotate');
const envFlag = args.indexOf('--env');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envPath = resolve(envFlag >= 0 ? (args[envFlag + 1] ?? '.env') : join(repoRoot, '.env'));

const env = Env.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')),
);
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion,
  appInfo: { name: 'pen-academy' },
});
const mode = env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'sandbox';
const events = [...BILLING_WEBHOOK_EVENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[];

async function listAll(): Promise<Stripe.WebhookEndpoint[]> {
  const all: Stripe.WebhookEndpoint[] = [];
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) all.push(endpoint);
  return all;
}

function writeSecret(secret: string): void {
  const before = readFileSync(envPath, 'utf8');
  writeFileSync(envPath, upsertEnvLine(before, 'STRIPE_WEBHOOK_SECRET', secret));
  console.log(`STRIPE_WEBHOOK_SECRET written to ${envPath}`);
}

console.log(`Stripe ${mode} · endpoint ${env.PEN_WEBHOOK_URL}`);
let existing = await listAll();
let decision = decideWebhookEndpoint(existing, env.PEN_WEBHOOK_URL, events);
if (rotate && decision.action !== 'create') {
  console.log(`--rotate: deleting ${decision.id}`);
  await stripe.webhookEndpoints.del(decision.id);
  decision = { action: 'create' };
}

let id: string;
switch (decision.action) {
  case 'create': {
    const created = await stripe.webhookEndpoints.create({
      url: env.PEN_WEBHOOK_URL,
      enabled_events: events,
      api_version: '2026-06-24.dahlia',
      description: 'Pen Playground billing (services/api/src/billing.ts)',
      metadata: { app: 'pen-academy', managed_by: 'services/api/scripts/stripe-webhook.ts' },
    });
    id = created.id;
    if (!created.secret) throw new Error('Stripe returned no signing secret for the new endpoint');
    writeSecret(created.secret);
    console.log(`created ${id}`);
    break;
  }
  case 'update': {
    await stripe.webhookEndpoints.update(decision.id, {
      enabled_events: decision.enabled_events as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
    });
    id = decision.id;
    console.log(`updated ${id}: events extended to ${decision.enabled_events.join(', ')}`);
    console.log(
      'secret unchanged (Stripe only reveals it at creation; pass --rotate for a new one)',
    );
    break;
  }
  case 'reuse':
    id = decision.id;
    console.log(`reusing ${id}; secret unchanged (pass --rotate for a new one)`);
    break;
}

// Verify through the API, not through what we think we did.
existing = await listAll();
const verified = existing.find((e) => e.id === id);
if (!verified) throw new Error(`endpoint ${id} not found after registration`);
const missing = events.filter((e) => !verified.enabled_events.includes(e));
if (missing.length > 0 && !verified.enabled_events.includes('*'))
  throw new Error(`endpoint ${id} is missing events: ${missing.join(', ')}`);
console.log(
  JSON.stringify(
    {
      id: verified.id,
      url: verified.url,
      status: verified.status,
      apiVersion: verified.api_version,
      enabledEvents: verified.enabled_events,
      livemode: verified.livemode,
    },
    null,
    2,
  ),
);
console.log(`\nendpoint id: ${verified.id}`);
