import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCode } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Admissions } from '../src/admissions.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * Both ceilings on `POST /api/sessions` were check-then-act across a long
 * `await`, and `limits.test.ts` could not see it because it starts sessions
 * one after another.
 *
 * The window is `rooms.create()` — the intake model call, a second and a half
 * of real provider. The plan's allowance is read before it; the row that
 * makes the allowance smaller is written after it. Every request that arrives
 * inside the window reads the world as it was before any of them, and every
 * one of them is admitted. Same shape for `PEN_MAX_SESSIONS_PER_IP`, which
 * counts rooms in `liveByIp` — a map written after the same await.
 *
 * Both exist to bound spend on real providers, so neither is a formality:
 * the price of losing them is N sessions' worth of model and voice calls from
 * one caller who sent N requests at once.
 *
 * These are the concurrent cases. The sequential ones stay in
 * `limits.test.ts`, which they already covered.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-admissions-'));
const IP_CAP = 2;
let services: Services;
let app: Hono;
let identity: Identity;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(plan: PlanCode): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous: true });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const start = (caller: Caller, ip: string): Promise<Response> =>
  Promise.resolve(
    app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...caller.headers },
      body: JSON.stringify({ topic: 'How Transformers work in LLMs', visibility: 'private' }),
    }),
  );

/** Every request sent before any of them has answered — the window itself. */
const allAtOnce = (n: number, send: (i: number) => Promise<Response>) =>
  Promise.all(Array.from({ length: n }, (_, i) => send(i)));

/**
 * End every room a burst created, through the route a host would use.
 *
 * Not tidiness: a live room holds a slot against its address and keeps the
 * fake providers busy, and either of those changes how far the *next* burst
 * gets before its first creation lands. Without this, whichever of the two
 * tests below ran second stopped being able to tell a working guard from a
 * missing one — it passed either way, which is a test that agrees with a bug.
 */
async function endEverything(caller: Caller, responses: Response[]): Promise<void> {
  for (const res of responses) {
    if (res.status !== 201) continue;
    const { session } = (await res.clone().json()) as { session: { id: string } };
    const ended = await app.request(`/api/sessions/${session.id}/end`, {
      method: 'POST',
      headers: caller.headers,
    });
    expect(ended.status, `ending ${session.id}`).toBe(200);
  }
}

const tally = (responses: Response[]) => {
  const byStatus = new Map<number, number>();
  for (const r of responses) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  return byStatus;
};

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_MAX_SESSIONS_PER_IP: String(IP_CAP),
  });
  services = await buildServices(cfg, { flags: PREPARE_FOR_EVERYONE });
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the ceilings hold when the requests arrive together', () => {
  it('one address hosts PEN_MAX_SESSIONS_PER_IP rooms however many it asks for at once', async () => {
    // A paid plan, so the daily allowance is not what is being measured here.
    const pro = await participant('professional');
    const responses = await allAtOnce(6, () => start(pro, '203.0.113.20'));
    const byStatus = tally(responses);

    expect(byStatus.get(201) ?? 0, `statuses: ${[...byStatus]}`).toBe(IP_CAP);
    expect(byStatus.get(429) ?? 0).toBe(6 - IP_CAP);
    await endEverything(pro, responses);
  }, 120_000);

  it('one address hosts PEN_MAX_SESSIONS_PER_IP rooms however many it asks for at once', async () => {
    // A paid plan, so the daily allowance is not what is being measured here.
    const pro = await participant('professional');
    const responses = await allAtOnce(6, () => start(pro, '203.0.113.20'));
    const byStatus = tally(responses);

    expect(byStatus.get(201) ?? 0, `statuses: ${[...byStatus]}`).toBe(IP_CAP);
    expect(byStatus.get(429) ?? 0).toBe(6 - IP_CAP);
    await endEverything(pro, responses);
  }, 120_000);

  it('a free plan gets three sessions a day however many it asks for at once', async () => {
    const free = await participant('free');
    // One address each, because `PEN_MAX_SESSIONS_PER_IP` is 2 here and would
    // otherwise be the ceiling that bites — which would make this a second
    // test of the address cap wearing the allowance's name.
    const responses = await allAtOnce(8, (i) => start(free, `203.0.113.${100 + i}`));
    const byStatus = tally(responses);

    expect(byStatus.get(201) ?? 0, `statuses: ${[...byStatus]}`).toBe(3);
    // The rest are refused for the allowance, not for the address: the answer
    // a learner reads has to be the true reason.
    expect(byStatus.get(402) ?? 0).toBe(5);
    await endEverything(free, responses);
  }, 120_000);

  it('gives the place back when the creation fails, rather than holding it for ever', async () => {
    // Directly, because making `rooms.create` throw inside the real app needs
    // a provider that fails, and what is being asserted is the bookkeeping.
    const admissions = new Admissions();
    const held = admissions.hold('p_1', '203.0.113.30');
    expect(admissions.pendingForHost('p_1')).toBe(1);
    held.release();
    expect(admissions.pendingForHost('p_1')).toBe(0);
    expect(admissions.pendingForAddress('203.0.113.30')).toBe(0);
  });
});

describe('Admissions', () => {
  it('counts each host and each address on its own', () => {
    const a = new Admissions();
    const first = a.hold('p_1', '198.51.100.1');
    a.hold('p_2', '198.51.100.1');
    expect(a.pendingForHost('p_1')).toBe(1);
    expect(a.pendingForHost('p_2')).toBe(1);
    expect(a.pendingForAddress('198.51.100.1')).toBe(2);
    first.release();
    expect(a.pendingForAddress('198.51.100.1')).toBe(1);
  });

  /** A `finally` that runs twice must not let an extra session through. */
  it('is idempotent, so a double release cannot go negative', () => {
    const a = new Admissions();
    const held = a.hold('p_1', '198.51.100.2');
    held.release();
    held.release();
    held.release();
    expect(a.pendingForHost('p_1')).toBe(0);
    expect(a.pendingForAddress('198.51.100.2')).toBe(0);
  });

  /** Neither map may grow with traffic: a counter at zero is a counter deleted. */
  it('forgets a host and an address once nothing is in flight for them', () => {
    const a = new Admissions();
    for (let i = 0; i < 1_000; i++) a.hold(`p_${i}`, `198.51.100.${i % 255}`).release();
    expect(a.pendingForHost('p_1')).toBe(0);
    expect(a.pendingForAddress('198.51.100.1')).toBe(0);
  });
});
