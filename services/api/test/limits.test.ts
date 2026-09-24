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

async function participant(plan: PlanCode, anonymous = true): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous });
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

function start(
  caller: Caller,
  ip: string,
  topic = 'How Transformers work in LLMs',
): Promise<Response> {
  return Promise.resolve(
    app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...caller.headers },
      body: JSON.stringify({ topic, visibility: 'private' }),
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

  it('tells a free learner sessions are unlimited, twenty minutes each, with one custom session (ADR-0040)', async () => {
    const free = await participant('free', false);
    expect(await usageOf(free)).toMatchObject({
      plan: 'free',
      sessionsToday: 0,
      sessionsPerDay: null,
      remaining: null,
      maxSessionMinutes: 20,
      canStart: true,
      reason: null,
      customSessionsUsed: 0,
      customSessions: 1,
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

describe('the free plan: unlimited sessions, one custom one (ADR-0040)', () => {
  it('never stops a free learner for the day, however many sessions they had', async () => {
    const free = await participant('free', false);
    const today = utcDayStart(Date.now()) + 1_000;
    for (let i = 0; i < 5; i += 1) await seedSession(free.id, today + i);
    expect(await usageOf(free)).toMatchObject({
      sessionsToday: 5,
      remaining: null,
      canStart: true,
      reason: null,
    });
    // A topic nobody has prepared: the account's one custom session.
    const res = await start(free, '198.51.100.10');
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await usageOf(free)).toMatchObject({ customSessionsUsed: 1, customSessions: 1 });
  }, 30_000);

  it('asks a free account for an upgrade on its second custom session, kindly, with the lessons that are ready', async () => {
    const free = await participant('free', false);
    const first = await start(free, '198.51.100.12');
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await start(free, '198.51.100.12', 'Reading an ECG strip, a custom lesson');
    expect(second.status).toBe(402);
    const body = (await second.json()) as {
      error: string;
      message: string;
      upgrade: string;
      ready: unknown[];
    };
    expect(body.error).toBe('PREPARATION_REQUIRED');
    expect(body.upgrade).toBe('Pricing');
    expect(body.message).toMatch(/upgrade/i);
    expect(/(^|\s)(error|denied|blocked|forbidden|violation)/i.test(body.message)).toBe(false);
    expect(Array.isArray(body.ready)).toBe(true);
    // (That a prepared lesson stays theirs to start, as often as they like,
    // is proved in features.test.ts, where the packs are seeded.)
  }, 60_000);
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
