import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PlanCode, PlanUsage, utcDayStart } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * What stands between a learner and a new session: the plan's daily allowance,
 * the day's spend cap (ADR-0016), the per-IP room cap and the body limit. All
 * four are enforced server-side, so all four are asserted through the real app.
 *
 * The spend cap is deliberately tiny here and pushed over the line in the last
 * describe: once the day's budget is spent it cannot be un-spent, so every test
 * that needs a free session to start runs before it.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-limits-'));
const SPEND_CAP_USD = 1;
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

/** A session row as the host already started it, dated into a chosen day. */
async function seedSession(hostId: string, startedAt: number): Promise<SessionRecord> {
  const record: SessionRecord = {
    id: `s_${Math.random().toString(36).slice(2, 10)}`,
    topic: 'How Transformers work in LLMs',
    title: 'How Transformers Work in LLMs',
    promise: '',
    expertId: 'ada',
    hostId,
    hostName: 'Ada',
    band: 'beginner',
    domain: 'ml',
    visibility: 'public',
    startedAt,
    endedAt: startedAt + 60_000,
    durationMs: 60_000,
    segments: 1,
    questions: 0,
    recap: [],
    views: 0,
    thumbnail: null,
    canonicalId: null,
    language: 'en-US',
    description: '',
    keywords: [],
    likes: 0,
  };
  await services.sessions.upsert(record);
  return record;
}

function start(caller: Caller, ip: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...caller.headers },
      body: JSON.stringify({ topic: 'How Transformers work in LLMs', visibility: 'private' }),
    }),
  );
}

async function usageOf(caller: Caller): Promise<PlanUsage> {
  const res = await app.request('/api/me/usage', { headers: caller.headers });
  expect(res.status).toBe(200);
  return PlanUsage.parse(await res.json());
}

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_DAILY_SPEND_CAP_USD: String(SPEND_CAP_USD),
    PEN_DAILY_SPEND_PAID_MULTIPLE: '3',
    PEN_MAX_SESSIONS_PER_IP: '2',
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

describe('GET /api/me/usage', () => {
  it('401 without a bearer, because an allowance belongs to its owner', async () => {
    expect((await app.request('/api/me/usage')).status).toBe(401);
  });

  it('tells a free learner they have all three sessions and twenty minutes each', async () => {
    const free = await participant('free');
    expect(await usageOf(free)).toMatchObject({
      plan: 'free',
      sessionsToday: 0,
      sessionsPerDay: 3,
      remaining: 3,
      maxSessionMinutes: 20,
      canStart: true,
      reason: null,
    });
  });

  it('tells a paying learner the count is unlimited and the session longer', async () => {
    const standard = await participant('standard');
    expect(await usageOf(standard)).toMatchObject({
      plan: 'standard',
      sessionsPerDay: null,
      remaining: null,
      maxSessionMinutes: 45,
      canStart: true,
      reason: null,
    });
    const professional = await participant('professional');
    expect(await usageOf(professional)).toMatchObject({
      sessionsPerDay: null,
      remaining: null,
      maxSessionMinutes: 60,
    });
  });

  it('resets at the next UTC midnight', async () => {
    const free = await participant('free');
    const usage = await usageOf(free);
    expect(usage.resetsAt).toBe(utcDayStart(Date.now()) + 86_400_000);
  });
});

describe('the free plan daily allowance', () => {
  it('stops the fourth session of the day kindly, and says so in the usage payload', async () => {
    const free = await participant('free');
    const today = utcDayStart(Date.now()) + 1_000;
    for (let i = 0; i < 3; i += 1) await seedSession(free.id, today + i);

    const res = await start(free, '198.51.100.10');
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: string;
      message: string;
      usage: unknown;
      upgrade: string;
    };
    expect(body.error).toBe('ENTITLEMENT_REQUIRED');
    expect(body.upgrade).toBe('Pricing');
    expect(PlanUsage.parse(body.usage)).toMatchObject({ remaining: 0, reason: 'daily_limit' });
    // A limit, explained — not an accusation.
    expect(body.message).toContain('3');
    expect(/(^|\s)(error|denied|blocked|forbidden|violation)/i.test(body.message)).toBe(false);

    expect(await usageOf(free)).toMatchObject({
      sessionsToday: 3,
      remaining: 0,
      canStart: false,
      reason: 'daily_limit',
    });
  });

  it('does not count a session started before the current UTC midnight', async () => {
    const free = await participant('free');
    const yesterday = utcDayStart(Date.now()) - 1_000;
    for (let i = 0; i < 3; i += 1) await seedSession(free.id, yesterday - i);

    expect(await usageOf(free)).toMatchObject({
      sessionsToday: 0,
      remaining: 3,
      canStart: true,
      reason: null,
    });
    const res = await start(free, '198.51.100.11');
    expect(res.status).toBe(201);
  }, 30_000);
});

describe('one machine may not host a farm of rooms', () => {
  it('caps live sessions per IP and leaves another address alone', async () => {
    const host = await participant('professional');
    const ip = '203.0.113.7';
    expect((await start(host, ip)).status).toBe(201);
    expect((await start(host, ip)).status).toBe(201);

    const third = await start(host, ip);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string; message: string };
    expect(body.error).toBe('RATE_LIMITED');
    expect(/(^|\s)(error|denied|blocked|forbidden|violation)/i.test(body.message)).toBe(false);

    expect((await start(host, '203.0.113.8')).status).toBe(201);
  }, 60_000);
});

describe('request size', () => {
  it('413s a body larger than the limit before any route sees it', async () => {
    const free = await participant('free');
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...free.headers },
      body: JSON.stringify({ topic: 'x'.repeat(70_000) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('TOO_LARGE');
  });
});

describe("the day's spend cap", () => {
  it('holds free sessions back at the cap and keeps paid plans running', async () => {
    // One line past the cap, booked the way every priced provider call books its own.
    services.spend.record({
      component: 'llm',
      unit: 'tokens_in',
      units: 1,
      usd: SPEND_CAP_USD * 1.5,
      meta: {},
    });
    expect(services.spend.check('free').ok).toBe(false);

    const free = await participant('free');
    expect(await usageOf(free)).toMatchObject({ canStart: false, reason: 'capacity' });

    const held = await start(free, '203.0.113.20');
    expect(held.status).toBe(503);
    const body = (await held.json()) as { error: string; message: string; upgrade: string };
    expect(body.error).toBe('CAPACITY');
    expect(body.upgrade).toBe('Pricing');
    expect(/(^|\s)(error|denied|blocked|forbidden|violation)/i.test(body.message)).toBe(false);

    // Paying learners keep going to the paid multiple of the same cap.
    const professional = await participant('professional');
    expect(await usageOf(professional)).toMatchObject({ canStart: true, reason: null });
    expect((await start(professional, '203.0.113.21')).status).not.toBe(503);

    // Past the multiple, everyone waits for midnight.
    services.spend.record({
      component: 'llm',
      unit: 'tokens_in',
      units: 1,
      usd: SPEND_CAP_USD * 3,
      meta: {},
    });
    expect(await usageOf(professional)).toMatchObject({ canStart: false, reason: 'capacity' });
    expect((await start(professional, '203.0.113.22')).status).toBe(503);
  }, 60_000);
});
