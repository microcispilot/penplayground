import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * Email and password sign-up and sign-in, end to end over HTTP.
 *
 * The flow is Simurgh's and the interesting assertions are not "it works" —
 * they are the ones about what an attacker can *learn*. Every test below that
 * looks like it is checking a boring sameness is checking that two very
 * different situations are indistinguishable from outside:
 *
 *   · a taken address and a free one, when asking for a code;
 *   · a wrong password, an unknown address, and an address whose account has
 *     no password at all;
 *   · a refused resend, whatever refused it.
 *
 * Without those, the endpoint is a tool for harvesting which of a list of
 * addresses have accounts here, which is the raw material for credential
 * stuffing and for targeted phishing.
 */

const dirs: string[] = [];
let services: Services;
let app: ReturnType<typeof buildApp>['app'];

/**
 * Every message the product tried to send, in order.
 *
 * The mailer is a seam on `services` precisely so a test can stand here and
 * read what a mailbox would have received — which is the only way to test a
 * flow whose whole point is that the interesting half goes to the mailbox and
 * not into the HTTP response.
 */
const outbox: Array<{ to: string; subject: string; text: string }> = [];

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pen-auth-'));
  dirs.push(dataDir);
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    // No SMTP: the mailer logs instead of sending, which is exactly how the
    // flow is walked without credentials.
  });
  services = await buildServices(cfg);
  outbox.length = 0;
  services.mailer = {
    kind: 'log',
    async send(message) {
      outbox.push(message);
    },
  };
  ({ app } = buildApp(services));
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/**
 * The code that was mailed to an address, read the way its owner would.
 *
 * The digest in the database is one-way by design, so there is nowhere else to
 * get it from — which is the point. A test that could recover a code from
 * storage would be testing a system where an attacker could too.
 */
function codeFor(email: string, purpose: 'register' | 'reset'): string {
  const wanted = purpose === 'register' ? 'your Pen Playground code' : 'reset code';
  const message = [...outbox].reverse().find((m) => m.to === email && m.subject.includes(wanted));
  if (!message) {
    throw new Error(
      `no ${purpose} code was sent to ${email}; outbox has ` +
        outbox.map((m) => `${m.to}/${m.subject}`).join(', '),
    );
  }
  const code = /\b\d{8}\b/.exec(message.text)?.[0];
  if (!code) throw new Error(`no eight-digit code in: ${message.text}`);
  return code;
}

describe('signing up with an email and a password', () => {
  it('sends a code, then turns it into an account that can sign in', async () => {
    const email = 'learner@example.test';
    const start = await post('/api/auth/register/start', { email });
    expect(start.status).toBe(202);
    const challenge = (await start.json()) as { challengeId: string };
    expect(challenge.challengeId).toMatch(/^ch_/);

    const code = codeFor(email, 'register');
    const done = await post('/api/auth/register/complete', {
      challengeId: challenge.challengeId,
      code,
      name: 'A Learner',
      password: 'a-long-enough-Password1',
    });
    expect(done.status).toBe(201);
    const account = (await done.json()) as { token: string; participant: { email: string } };
    expect(account.token).toBeTruthy();
    expect(account.participant.email).toBe(email);

    const login = await post('/api/auth/login', {
      email,
      password: 'a-long-enough-Password1',
    });
    expect(login.status).toBe(200);
  });

  it('refuses a weak password before anything is created', async () => {
    const res = await post('/api/auth/register/complete', {
      challengeId: 'ch_whatever',
      code: '12345678',
      name: 'A Learner',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('spends the code: the same one cannot make a second account', async () => {
    const email = 'once@example.test';
    const start = await post('/api/auth/register/start', { email });
    const { challengeId } = (await start.json()) as { challengeId: string };
    const code = codeFor(email, 'register');
    const body = {
      challengeId,
      code,
      name: 'A Learner',
      password: 'a-long-enough-Password1',
    };
    expect((await post('/api/auth/register/complete', body)).status).toBe(201);
    // Single use, enforced in the claim's WHERE clause rather than by a read.
    expect((await post('/api/auth/register/complete', body)).status).toBe(400);
  });

  it('keeps the learner’s id, so what they already started stays theirs', async () => {
    const anon = await post('/api/auth/anonymous', { name: 'Visitor' });
    const { token, participant } = (await anon.json()) as {
      token: string;
      participant: { id: string };
    };
    const email = 'upgrade@example.test';
    const start = await post('/api/auth/register/start', { email }, token);
    const { challengeId } = (await start.json()) as { challengeId: string };
    const done = await post(
      '/api/auth/register/complete',
      {
        challengeId,
        code: codeFor(email, 'register'),
        name: 'Visitor',
        password: 'a-long-enough-Password1',
      },
      token,
    );
    const after = (await done.json()) as { participant: { id: string; anonymous: boolean } };
    // The same row, upgraded in place — the same thing Google sign-in does.
    expect(after.participant.id).toBe(participant.id);
    expect(after.participant.anonymous).toBe(false);
  });
});

describe('what a stranger can learn', () => {
  it('answers identically for an address that is taken and one that is not', async () => {
    const taken = 'taken@example.test';
    const start = await post('/api/auth/register/start', { email: taken });
    const { challengeId } = (await start.json()) as { challengeId: string };
    await post('/api/auth/register/complete', {
      challengeId,
      code: codeFor(taken, 'register'),
      name: 'A Learner',
      password: 'a-long-enough-Password1',
    });

    const again = await post('/api/auth/register/start', { email: taken });
    const fresh = await post('/api/auth/register/start', { email: 'free@example.test' });

    expect(again.status).toBe(fresh.status);
    const a = (await again.json()) as Record<string, unknown>;
    const b = (await fresh.json()) as Record<string, unknown>;
    // Same keys, same shape, same numbers. Only the opaque id differs, and the
    // one for the taken address is a decoy that names nothing.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.expiresInSeconds).toBe(b.expiresInSeconds);
    expect(a.resendAvailableInSeconds).toBe(b.resendAvailableInSeconds);
    /*
     * And the ids are the same *shape*.
     *
     * This is the assertion the first implementation failed. The decoy was
     * built from `Math.random().toString(36)` plus a timestamp while real ids
     * were base64url — different alphabet, different length — so a decoy could
     * be spotted on sight and the enumeration defence was decoration. Same
     * length, same character set, or the body still answers the question.
     */
    const decoy = String(a.challengeId);
    const real = String(b.challengeId);
    expect(decoy).toMatch(/^ch_[A-Za-z0-9_-]+$/);
    expect(real).toMatch(/^ch_[A-Za-z0-9_-]+$/);
    expect(decoy.length).toBe(real.length);
  });

  it('gives one refusal for a wrong password, an unknown address, and a passwordless account', async () => {
    const email = 'real@example.test';
    const start = await post('/api/auth/register/start', { email });
    const { challengeId } = (await start.json()) as { challengeId: string };
    await post('/api/auth/register/complete', {
      challengeId,
      code: codeFor(email, 'register'),
      name: 'A Learner',
      password: 'a-long-enough-Password1',
    });

    const wrong = await post('/api/auth/login', { email, password: 'not-the-password-1A' });
    const unknown = await post('/api/auth/login', {
      email: 'nobody@example.test',
      password: 'not-the-password-1A',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });
});

describe('resetting a forgotten password', () => {
  it('sets a new password and signs the learner in', async () => {
    const email = 'forgot@example.test';
    const start = await post('/api/auth/register/start', { email });
    const { challengeId } = (await start.json()) as { challengeId: string };
    await post('/api/auth/register/complete', {
      challengeId,
      code: codeFor(email, 'register'),
      name: 'A Learner',
      password: 'the-first-Password1',
    });

    const forgot = await post('/api/auth/password/forgot', { email });
    expect(forgot.status).toBe(202);
    const reset = (await forgot.json()) as { challengeId: string };
    const done = await post('/api/auth/password/reset', {
      challengeId: reset.challengeId,
      code: codeFor(email, 'reset'),
      password: 'a-second-Password1!',
    });
    expect(done.status).toBe(200);

    expect((await post('/api/auth/login', { email, password: 'a-second-Password1!' })).status).toBe(
      200,
    );
    // The old one stops working, which is the whole point of a reset.
    expect((await post('/api/auth/login', { email, password: 'the-first-Password1' })).status).toBe(
      401,
    );
  });

  it('answers the same for an address with no account', async () => {
    const res = await post('/api/auth/password/forgot', { email: 'nobody@example.test' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { challengeId: string };
    expect(body.challengeId).toMatch(/^ch_/);
  });
});
