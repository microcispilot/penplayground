import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BillingInterval, PLAN_PRICES_USD } from '@pen/contracts';
import Stripe from 'stripe';
import { z } from 'zod';
import { upsertEnvLine } from '../src/stripe-webhook-setup.js';

/**
 * Create (idempotently) the four Stripe prices the contract names and print
 * the `STRIPE_PRICE_*` lines that point at them:
 *
 *   pnpm --filter @pen/api stripe:prices             # print the four lines
 *   pnpm --filter @pen/api stripe:prices -- --write  # and write them into .env
 *   pnpm --filter @pen/api stripe:prices -- --env deploy/api.env --write
 *   pnpm --filter @pen/api stripe:prices -- --product standard=prod_abc --product professional=prod_def
 *
 * `--product <plan>=<id>` hangs a plan's prices on a product that already
 * exists (a live account has one per plan from the dashboard) and tags it
 * with `pen_plan` so later runs find it by themselves; without it, a product
 * is found by that tag or created once.
 *
 * The amounts come from `PLAN_PRICES_USD` (ADR-0056) and from nowhere else.
 * A Stripe price is immutable, so a new amount is a new price: each carries
 * a `lookup_key` of `pen_<plan>_<interval>_<usd>` and is reused when it
 * already exists, so running this twice creates nothing. Old prices are left
 * active for the subscriptions already on them; Checkout only ever uses the
 * four ids in the environment. The key comes from `.env` (`node --env-file`);
 * `sk_live_` creates live prices, anything else sandbox ones.
 */
const Env = z.object({
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required'),
});

const args = process.argv.slice(2);
const write = args.includes('--write');
/** `--product standard=prod_x` pairs, as a map. */
const pinnedProducts = new Map<string, string>();
args.forEach((arg, i) => {
  if (arg !== '--product') return;
  const [plan, id] = (args[i + 1] ?? '').split('=');
  if (!plan || !id || !['standard', 'professional'].includes(plan))
    throw new Error(
      `--product wants <standard|professional>=<prod_id>, got "${args[i + 1] ?? ''}"`,
    );
  pinnedProducts.set(plan, id);
});
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

const PLANS = ['standard', 'professional'] as const;
const INTERVALS = ['month', 'year'] as const;
const PRODUCT_NAME: Record<(typeof PLANS)[number], string> = {
  standard: 'Pen Playground Standard',
  professional: 'Pen Playground Professional',
};
const ENV_KEY = (plan: string, interval: BillingInterval) =>
  `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;

/** The plan's product: found by its `pen_plan` metadata, created once when absent. */
async function productFor(plan: (typeof PLANS)[number]): Promise<Stripe.Product> {
  const pinned = pinnedProducts.get(plan);
  if (pinned) {
    const product = await stripe.products.update(pinned, {
      metadata: {
        app: 'pen-academy',
        pen_plan: plan,
        managed_by: 'services/api/scripts/stripe-prices.ts',
      },
    });
    console.log(
      `using product ${product.id} (${product.name}) for ${plan}, tagged pen_plan=${plan}`,
    );
    return product;
  }
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata.pen_plan === plan) return product;
  }
  const created = await stripe.products.create({
    name: PRODUCT_NAME[plan],
    metadata: {
      app: 'pen-academy',
      pen_plan: plan,
      managed_by: 'services/api/scripts/stripe-prices.ts',
    },
  });
  console.log(`created product ${created.id} (${created.name})`);
  return created;
}

/** The price at the contract's amount: reused by lookup key, created once when absent. */
async function priceFor(
  product: Stripe.Product,
  plan: (typeof PLANS)[number],
  interval: BillingInterval,
): Promise<Stripe.Price> {
  const usd = PLAN_PRICES_USD[plan][interval];
  const lookupKey = `pen_${plan}_${interval}_${usd}`;
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const found = existing.data[0];
  if (found) return found;
  const created = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: usd * 100,
    recurring: { interval },
    lookup_key: lookupKey,
    nickname: `${PRODUCT_NAME[plan]}, ${interval === 'month' ? 'monthly' : 'yearly'}`,
    metadata: { app: 'pen-academy', pen_plan: plan, pen_interval: interval },
  });
  console.log(`created price ${created.id} (${lookupKey})`);
  return created;
}

console.log(`Stripe ${mode} · prices from PLAN_PRICES_USD`);
const lines: string[] = [];
for (const plan of PLANS) {
  const product = await productFor(plan);
  for (const interval of INTERVALS) {
    const price = await priceFor(product, plan, interval);
    // Verify through the API, not through what we think we did.
    const back = await stripe.prices.retrieve(price.id);
    const expected = PLAN_PRICES_USD[plan][interval] * 100;
    if (
      !back.active ||
      back.unit_amount !== expected ||
      back.currency !== 'usd' ||
      back.recurring?.interval !== interval
    )
      throw new Error(
        `${price.id} reads ${back.unit_amount} ${back.currency} per ${back.recurring?.interval}, expected ${expected} usd per ${interval}`,
      );
    console.log(
      `${plan}/${interval}: ${price.id} = $${PLAN_PRICES_USD[plan][interval]} per ${interval}, verified`,
    );
    lines.push(`${ENV_KEY(plan, interval)}=${price.id}`);
  }
}

console.log(`\n${lines.join('\n')}`);
if (write) {
  let file = readFileSync(envPath, 'utf8');
  for (const line of lines) {
    const [key, value] = line.split('=') as [string, string];
    file = upsertEnvLine(file, key, value);
  }
  writeFileSync(envPath, file);
  console.log(`\nwritten to ${envPath}; restart the API so it re-reads them`);
} else {
  console.log('\n(pass --write to put these into .env)');
}
