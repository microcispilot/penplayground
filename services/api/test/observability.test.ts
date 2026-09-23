import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCode } from '@pen/contracts';
import { PLATFORM_HEADER } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * What the API tells PostHog about a visitor who never signs in (ADR-0038):
 * that they arrived, every way a start was turned away and why, and what
 * they looked at — plus the one net under every route, so a throw is a
 * captured error and a JSON answer rather than Hono's plain-text 500.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-observability-'));
let services: Services;
let app: Hono;
let identity: Identity;

interface Captured {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}
const captured: Captured[] = [];

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(plan: PlanCode = 'free'): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous: true });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const start = (
  caller: Caller,
  ip: string,
  body: unknown = { topic: 'How Transformers work in LLMs' },
) =>
  app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...caller.headers },
    body: JSON.stringify(body),
  });

async function end(caller: Caller, res: Response): Promise<void> {
  if (res.status !== 201) return;
  const { session } = (await res.clone().json()) as { session: { id: string } };
  const ended = await app.request(`/api/sessions/${session.id}/end`, {
    method: 'POST',
    headers: caller.headers,
  });
  expect(ended.status).toBe(200);
}

const refusals = (id: string) =>
  captured.filter((c) => c.event === 'session_refused' && c.distinctId === id);

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    // One free session per address per day: the second participant from the
    // same address is the whole point of the cap.
    PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY: '1',
  });
  services = await buildServices(cfg, { flags: PREPARE_FOR_EVERYONE });
  // Observe what would go to PostHog without a token.
  services.analytics = {
    capture: (distinctId: string, event: string, properties: Record<string, unknown> = {}) => {
      captured.push({ distinctId, event, properties });
    },
    setOptOut: () => undefined,
    optedOutOf: () => false,
    flush: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as Services['analytics'];
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
  // A route that throws, added before the first request builds the matcher:
  // the test of the net under every route.
  app.get('/api/test/boom', () => {
    throw new Error('deliberate');
  });
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  captured.length = 0;
});

describe('a visitor arriving', () => {
  it('is one event, under the id every later event will carry, with the platform they came on', async () => {
    const res = await app.request('/api/auth/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PLATFORM_HEADER]: 'desktop-mac' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { participant: p } = (await res.json()) as { participant: { id: string } };
    expect(captured).toEqual([
      {
        distinctId: p.id,
        event: 'participant_issued',
        properties: { plan: 'free', platform: 'desktop-mac' },
      },
    ]);
  });
});

describe('every refusal is a session_refused with its reason', () => {
  it('a replay of a lesson that does not exist', async () => {
    const me = await participant();
    const res = await start(me, '203.0.113.50', { replayOf: 'AAAAAAAAAAAA' });
    expect(res.status).toBe(404);
    expect(refusals(me.id)).toEqual([
      {
        distinctId: me.id,
        event: 'session_refused',
        properties: { reason: 'replay_not_found', plan: 'free' },
      },
    ]);
  });

  it('the address has had its free sessions for the day, whoever is asking — and a paid plan is not counted', async () => {
    const first = await participant('free');
    const second = await participant('free');
    const paid = await participant('standard');
    const ip = '203.0.113.60';

    const a = await start(first, ip);
    expect(a.status, await a.clone().text()).toBe(201);
    await end(first, a);

    // A fresh participant — what clearing the bearer and minting again looks like.
    const b = await start(second, ip);
    expect(b.status).toBe(402);
    const body = (await b.json()) as { error: string; message: string; usage: { reason: string } };
    expect(body.error).toBe('ENTITLEMENT_REQUIRED');
    expect(body.message).toMatch(/from this connection/);
    expect(body.usage.reason).toBe('daily_limit');
    expect(refusals(second.id).map((r) => r.properties)).toEqual([
      { reason: 'ip_daily_limit', plan: 'free', started: 1 },
    ]);

    // Paid learners on the same address are never held by a free-plan ceiling.
    const c = await start(paid, ip);
    expect(c.status, await c.clone().text()).toBe(201);
    await end(paid, c);

    // Another address starts fresh.
    const elsewhere = await participant('free');
    const d = await start(elsewhere, '203.0.113.61');
    expect(d.status, await d.clone().text()).toBe(201);
    await end(elsewhere, d);
  }, 120_000);
});

describe('what a visitor looked at', () => {
  it('records a view of somebody else’s saved session, never the host looking at their own', async () => {
    const host = await participant('standard');
    const res = await start(host, '203.0.113.70');
    expect(res.status, await res.clone().text()).toBe(201);
    const { session } = (await res.clone().json()) as { session: { id: string } };
    await end(host, res);
    captured.length = 0;

    const own = await app.request(`/api/sessions/${session.id}`, { headers: host.headers });
    expect(own.status).toBe(200);
    expect(captured.filter((c) => c.event === 'session_viewed')).toEqual([]);

    const stranger = await participant();
    const theirs = await app.request(`/api/sessions/${session.id}`, { headers: stranger.headers });
    expect(theirs.status).toBe(200);
    expect(captured.filter((c) => c.event === 'session_viewed')).toEqual([
      {
        distinctId: stranger.id,
        event: 'session_viewed',
        // An ended room lingers in the registry for `ROOM_RELEASE_MS`, so
        // `live` here is whatever the registry says; the view is the point.
        properties: { sessionId: session.id, live: expect.any(Boolean) },
      },
    ]);
  }, 60_000);
});

describe('the net under every route', () => {
  it('turns a throw into a JSON 500 with a code, not Hono’s plain text', async () => {
    const res = await app.request('/api/test/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: 'INTERNAL',
      message: 'Something went wrong on our side.',
      // No Sentry in tests, so no reference; the shape is what the client reads.
      ref: null,
    });
  });
});
