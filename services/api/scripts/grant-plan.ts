/**
 * Put a real account on a plan, without Stripe. For test accounts.
 *
 *   pnpm --filter @pen/api plan:grant -- --email you@example.com
 *   pnpm --filter @pen/api plan:grant -- --email you@example.com --plan professional --apply
 *   pnpm --filter @pen/api plan:grant -- --list
 *
 * Paid plans normally arrive from a Stripe webhook (`billing.ts`), and the one
 * other way in — `POST /api/dev/me/google` — is never mounted in production.
 * So there was no way to sit in front of the deployed product as a subscriber
 * and look at what subscribers get: the gated boards and inks, the legends,
 * rooms, export. That is what this is for.
 *
 * ── the safety rules, and why each one is here ─────────────────────────────
 *
 * **Dry run by default.** It prints what it would do and writes nothing until
 * `--apply`. This is a script that edits entitlements on a live database.
 *
 * **It refuses an account Stripe is paying for.** If the row has a
 * `stripeCustomerId`, granting by hand would put the database and Stripe into
 * disagreement, and the next webhook would overwrite it — silently, and
 * possibly in the wrong direction. Those accounts are Stripe's to move.
 *
 * **It writes no billing metadata.** `setPlan` takes an interval, a status and
 * an event timestamp, all of which feed the owner's subscription statistics
 * (ADR-0027). A hand-granted plan is not a subscription and must not appear in
 * that count as one, so only the plan code is written and the row stays
 * legible as what it is: an account somebody granted.
 *
 * **It names the account it is about to change.** An email is not a key —
 * nothing enforces one row per address — so an ambiguous match stops rather
 * than picking one.
 */
import { PLAN_NAME, PlanCode } from '@pen/contracts';
import { connect, ParticipantRepository } from '@pen/db';
import { loadConfig } from '../src/config.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const apply = process.argv.includes('--apply');
const list = process.argv.includes('--list');
const email = arg('email');
const id = arg('id');
const planArg = arg('plan') ?? 'standard';

const cfg = loadConfig();
const conn = await connect(cfg.DATABASE_URL);
const repo = new ParticipantRepository(conn.db);

/** Every account with an email, newest first — enough to find yours. */
if (list) {
  const rows = await repo.recentAccounts();
  if (rows.length === 0) console.log('no accounts with an email yet');
  for (const r of rows) {
    const paid = r.stripeCustomerId ? ' [stripe]' : '';
    console.log(
      `${r.id}  ${(r.email ?? '').padEnd(34)} ${PLAN_NAME[r.plan].padEnd(13)} ${r.name}${paid}`,
    );
  }
  process.exit(0);
}

if (!email && !id) {
  console.error('give --email <address> or --id <participant id>, or --list to see accounts');
  process.exit(2);
}

const plan = PlanCode.safeParse(planArg);
if (!plan.success) {
  console.error(`--plan must be one of ${PlanCode.options.join(', ')} (got "${planArg}")`);
  process.exit(2);
}

const matches = id
  ? [await repo.get(id)].filter((r) => r !== null)
  : await repo.findByEmail(email as string);

if (matches.length === 0) {
  console.error(`no account matches ${id ? `id ${id}` : `email ${email}`}`);
  process.exit(1);
}
// An email is not a key here. Picking one of several would be picking somebody.
if (matches.length > 1) {
  console.error(`${matches.length} accounts share that email; re-run with --id:`);
  for (const r of matches) console.error(`  ${r.id}  ${PLAN_NAME[r.plan]}  ${r.name}`);
  process.exit(1);
}

const row = matches[0];
if (!row) process.exit(1);

console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${cfg.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
console.log(`  account  ${row.id}  ${row.email ?? '(no email)'}  ${row.name}`);
console.log(`  plan     ${PLAN_NAME[row.plan]} → ${PLAN_NAME[plan.data]}`);

if (row.stripeCustomerId) {
  console.error(
    `\nrefusing: this account is paying through Stripe (${row.stripeCustomerId}).\n` +
      'Granting by hand would disagree with Stripe, and the next webhook would ' +
      'overwrite it. Change the subscription in Stripe instead.',
  );
  process.exit(1);
}

if (row.plan === plan.data) {
  console.log('\nalready on that plan; nothing to do');
  process.exit(0);
}

if (!apply) {
  console.log('\nnothing written; add --apply to do it');
  process.exit(0);
}

// The plan code and nothing else: no interval, no status, no event timestamp.
// A hand-granted plan is not a subscription and must not be counted as one.
const applied = await repo.setPlan(row.id, plan.data);
if (!applied) {
  console.error('the write did not take; the row may have been removed');
  process.exit(1);
}
console.log(`\ngranted ${PLAN_NAME[plan.data]} to ${row.email ?? row.id}`);
console.log('The account picks it up on its next token refresh (sign out and in to be sure).');
process.exit(0);
