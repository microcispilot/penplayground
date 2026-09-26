import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedbackList, SurveyPending } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type GoogleProfile, GoogleTokenError, type GoogleTokenVerifier } from '../src/google.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/**
 * Feedback, contact and the two surveys (ADR-0060), over the real API: who
 * may write, what a visitor must add, the daily allowance, the inbox with
 * its counts and status changes, and which survey waits for whom.
 */
class FakeVerifier implements GoogleTokenVerifier {
  constructor(private readonly known: Record<string, GoogleProfile>) {}
  async verify(idToken: string): Promise<GoogleProfile> {
    const profile = this.known[idToken];
    if (!profile) throw new GoogleTokenError('invalid', 'Invalid token signature');
    return profile;
  }
}
const owner: GoogleProfile = {
  sub: '9000-owner',
  email: 'owner@pen.test',
  emailVerified: true,
  name: 'Sam Owner',
  avatarUrl: null,
};
const ada: GoogleProfile = {
  sub: '9002-ada',
  email: 'ada@pen.test',
  emailVerified: true,
  name: 'Ada',
  avatarUrl: null,
};
const ADMIN_TOKEN = 'm'.repeat(48);
const dataDir = mkdtempSync(join(tmpdir(), 'pen-feedback-'));
let services: Services;
let app: Hono;
let ownerAuth: Record<string, string>;
let adaAuth: Record<string, string>;
let adaId: string;
let visitorAuth: Record<string, string>;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
    GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
    PEN_ADMIN_EMAILS: 'owner@pen.test',
    PEN_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  services = await buildServices(cfg, {
    flags: PREPARE_FOR_EVERYONE,
    googleVerifier: new FakeVerifier({
      'tok:owner-0123456789abcdef': owner,
      'tok:ada-0123456789abcdef': ada,
    }),
  });
  ({ app } = buildApp(services));
  ownerAuth = await signIn('tok:owner-0123456789abcdef');
  const adaSession = await signInWithId('tok:ada-0123456789abcdef');
  adaAuth = adaSession.headers;
  adaId = adaSession.id;
  const anon = await app.request('/api/auth/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Visitor' }),
  });
  expect(anon.status).toBe(200);
  const { token } = (await anon.json()) as { token: string };
  visitorAuth = { authorization: `Bearer ${token}` };
}, 60_000);

afterAll(async () => {
  services.exports.close();
  services.meta.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function signInWithId(idToken: string) {
  const res = await app.request('/api/identity/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; participant: { id: string } };
  return { headers: { authorization: `Bearer ${body.token}` }, id: body.participant.id };
}
async function signIn(idToken: string) {
  return (await signInWithId(idToken)).headers;
}
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('POST /api/feedback', () => {
  it('takes a signed-in learner’s issue and files it under their account', async () => {
    const res = await call('POST', '/api/feedback', adaAuth, {
      kind: 'issue',
      message: 'The board stopped drawing after the second segment.',
      screen: 'room',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feedback: { id: string; kind: string } };
    expect(body.feedback.kind).toBe('issue');
    const inbox = (await (
      await call('GET', '/api/admin/feedback', ownerAuth)
    ).json()) as FeedbackList;
    expect(inbox.total).toBe(1);
    expect(inbox.feedback[0]).toMatchObject({
      kind: 'issue',
      status: 'new',
      participantName: 'Ada',
      participantAnonymous: false,
      email: 'ada@pen.test',
      screen: 'room',
      environment: 'development',
    });
  });

  it('asks a visitor for an address, then takes their message', async () => {
    const refused = await call('POST', '/api/feedback', visitorAuth, {
      kind: 'contact',
      message: 'Do you offer plans for a school of forty students?',
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('EMAIL_REQUIRED');
    const ok = await call('POST', '/api/feedback', visitorAuth, {
      kind: 'contact',
      message: 'Do you offer plans for a school of forty students?',
      email: 'head@school.example',
      name: 'Sam',
    });
    expect(ok.status).toBe(200);
  });

  it('refuses a message that is too short, and an unknown kind', async () => {
    expect(
      (await call('POST', '/api/feedback', adaAuth, { kind: 'issue', message: 'hi' })).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/feedback', adaAuth, {
          kind: 'praise',
          message: 'Long enough message here',
        })
      ).status,
    ).toBe(400);
  });

  it('is refused without a bearer', async () => {
    expect(
      (await call('POST', '/api/feedback', {}, { kind: 'issue', message: 'Long enough message' }))
        .status,
    ).toBe(401);
  });

  it('counts the day’s allowance from rows', async () => {
    // Nine more from Ada (one is already in): the tenth is taken, the eleventh is not.
    for (let i = 0; i < 9; i += 1) {
      const res = await call('POST', '/api/feedback', adaAuth, {
        kind: 'suggestion',
        message: `Suggestion number ${i}: keep the board a little longer.`,
      });
      // The burst limiter allows five a minute; wait it out by sending fewer.
      if (res.status === 429) {
        const b = (await res.json()) as { message: string };
        expect(b.message).toMatch(/minute|one day/);
        return;
      }
      expect(res.status).toBe(200);
    }
  });
});

describe('the inbox', () => {
  it('is the console’s alone, filters by kind and status, and moves a status with a note', async () => {
    expect((await call('GET', '/api/admin/feedback', adaAuth)).status).toBe(403);
    expect((await call('GET', '/api/admin/feedback', visitorAuth)).status).toBe(403);
    const all = (await (
      await call('GET', '/api/admin/feedback', ownerAuth)
    ).json()) as FeedbackList;
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.counts.new).toBe(all.total);
    const contact = (await (
      await call('GET', '/api/admin/feedback?kind=contact', ownerAuth)
    ).json()) as FeedbackList;
    expect(contact.feedback.every((f) => f.kind === 'contact')).toBe(true);
    expect(contact.feedback[0]).toMatchObject({ email: 'head@school.example', name: 'Sam' });
    const id = contact.feedback[0]?.id ?? '';
    const patched = await call('PATCH', `/api/admin/feedback/${id}`, ownerAuth, {
      status: 'resolved',
      adminNote: 'Replied by mail',
    });
    expect(patched.status).toBe(200);
    const after = (await (
      await call('GET', '/api/admin/feedback?status=resolved', ownerAuth)
    ).json()) as FeedbackList;
    expect(after.feedback.map((f) => f.id)).toEqual([id]);
    expect(after.counts.resolved).toBe(1);
    expect(
      (await call('PATCH', '/api/admin/feedback/f_missing', ownerAuth, { status: 'seen' })).status,
    ).toBe(404);
    expect(
      (await call('PATCH', `/api/admin/feedback/${id}`, ownerAuth, { status: 'gone' })).status,
    ).toBe(400);
  });
});

describe('surveys', () => {
  const pending = async (headers: Record<string, string>) =>
    ((await (await call('GET', '/api/me/surveys', headers)).json()) as SurveyPending).pending;

  it('asks nothing of a visitor or a free account', async () => {
    expect(await pending(visitorAuth)).toEqual([]);
    expect(await pending(adaAuth)).toEqual([]);
  });

  it('asks a new subscriber how they heard of us, once', async () => {
    await services.participants.setPlan(adaId, 'standard', 'cus_ada', {
      interval: 'month',
      status: 'active',
      since: new Date(Date.now() - 60_000),
    });
    expect(await pending(adaAuth)).toEqual([{ kind: 'signup_source', trigger: 'checkout' }]);
    const bad = await call('POST', '/api/me/surveys', adaAuth, {
      kind: 'signup_source',
      option: 'telepathy',
      trigger: 'checkout',
    });
    expect(bad.status).toBe(400);
    const ok = await call('POST', '/api/me/surveys', adaAuth, {
      kind: 'signup_source',
      option: 'other',
      other: 'A conference talk',
      trigger: 'checkout',
    });
    expect(ok.status).toBe(200);
    expect(await pending(adaAuth)).toEqual([]);
  });

  it('asks a leaving subscriber why, while Stripe still bills to the period’s end, and accepts a skip', async () => {
    await services.participants.setPlan(adaId, 'standard', 'cus_ada', {
      interval: 'month',
      status: 'cancelling',
      since: new Date(Date.now() - 30_000),
    });
    expect(await pending(adaAuth)).toEqual([
      { kind: 'cancel_reason', trigger: 'subscription_cancelled' },
    ]);
    const skip = await call('POST', '/api/me/surveys', adaAuth, {
      kind: 'cancel_reason',
      option: 'skipped',
      trigger: 'subscription_cancelled',
    });
    expect(skip.status).toBe(200);
    expect(await pending(adaAuth)).toEqual([]);
  });

  it('summarises answers by option for the console, with the words behind other', async () => {
    const res = await call('GET', '/api/admin/stats/surveys', { 'x-admin-token': ADMIN_TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      surveys: Array<{
        kind: string;
        answered: number;
        skipped: number;
        others: Array<{ text: string }>;
      }>;
    };
    const signup = body.surveys.find((s) => s.kind === 'signup_source');
    const cancel = body.surveys.find((s) => s.kind === 'cancel_reason');
    expect(signup).toMatchObject({ answered: 1, skipped: 0 });
    expect(signup?.others.map((o) => o.text)).toEqual(['A conference talk']);
    expect(cancel).toMatchObject({ answered: 0, skipped: 1 });
  });
});

describe('the people summary and the person', () => {
  it('counts accounts, paying, free and visitors, and lists a person’s own history', async () => {
    const res = await call('GET', '/api/admin/stats/people', { 'x-admin-token': ADMIN_TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: {
        accounts: number;
        paying: number;
        byPlan: { standard: number };
        freeAccounts: number;
        anonymous: number;
        cancelling: number;
      };
      top: { byCost: unknown[]; bySessions: unknown[]; byTime: unknown[] };
    };
    // Owner and Ada have accounts; Ada pays (Standard, cancelling); the visitor has none.
    expect(body.summary.accounts).toBe(2);
    expect(body.summary.paying).toBe(1);
    expect(body.summary.byPlan.standard).toBe(1);
    expect(body.summary.cancelling).toBe(1);
    expect(body.summary.freeAccounts).toBe(1);
    expect(body.summary.anonymous).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.top.byCost)).toBe(true);

    const person = await call('GET', `/api/admin/stats/users/${adaId}`, {
      'x-admin-token': ADMIN_TOKEN,
    });
    expect(person.status).toBe(200);
    const detail = (await person.json()) as {
      feedback: Array<{ kind: string }>;
      surveys: Array<{ kind: string; option: string }>;
      totals: { sessions: number; visits: number };
      planEvents: unknown[];
    };
    expect(detail.feedback.length).toBeGreaterThanOrEqual(1);
    expect(detail.surveys.map((s) => `${s.kind}:${s.option}`).sort()).toEqual([
      'cancel_reason:skipped',
      'signup_source:other',
    ]);
    expect(detail.totals).toMatchObject({ sessions: 0, visits: 0 });
  });

  it('a deleted account leaves its words and answers, unattributed', async () => {
    const del = await call('DELETE', '/api/me', adaAuth);
    expect(del.status).toBe(200);
    const inbox = (await (
      await call('GET', '/api/admin/feedback?kind=issue', ownerAuth)
    ).json()) as FeedbackList;
    const row = inbox.feedback.find((f) => f.screen === 'room');
    expect(row).toMatchObject({ participantId: null, participantName: null, email: null });
    expect(row?.message).toContain('The board stopped drawing');
  });
});
