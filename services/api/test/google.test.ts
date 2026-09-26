import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  type GoogleCodeExchanger,
  type GoogleProfile,
  GoogleSignIn,
  GoogleTokenError,
  type GoogleTokenVerifier,
} from '../src/google.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * Stands in for Google: tokens are looked up by value. `expired:` and
 * `audience:` prefixes fail the way the real verifier does, everything
 * unknown is `invalid`.
 */
class FakeVerifier implements GoogleTokenVerifier {
  readonly calls: string[] = [];
  constructor(private readonly known: Record<string, GoogleProfile>) {}
  async verify(idToken: string): Promise<GoogleProfile> {
    this.calls.push(idToken);
    if (idToken.startsWith('expired:'))
      throw new GoogleTokenError('expired', 'Token used too late, 1 > 0');
    if (idToken.startsWith('audience:'))
      throw new GoogleTokenError(
        'wrong_audience',
        'Wrong recipient, payload audience != requiredAudience',
      );
    const profile = this.known[idToken];
    if (!profile) throw new GoogleTokenError('invalid', 'Invalid token signature');
    return profile;
  }
}

/**
 * Stands in for the exchange (ADR-0042): a popup code is looked up by value
 * and becomes the ID token the verifier above knows; anything unknown fails
 * the way Google's `invalid_grant` does.
 */
class FakeExchanger implements GoogleCodeExchanger {
  readonly calls: string[] = [];
  constructor(private readonly known: Record<string, string>) {}
  async exchange(code: string): Promise<string> {
    this.calls.push(code);
    const idToken = this.known[code];
    if (!idToken) throw new GoogleTokenError('invalid', 'invalid_grant');
    return idToken;
  }
}

const ada: GoogleProfile = {
  sub: '1000-ada',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada Lovelace',
  avatarUrl: 'https://lh3.googleusercontent.com/a/ada',
};
const grace: GoogleProfile = {
  sub: '1000-grace',
  email: 'grace@example.com',
  emailVerified: false,
  name: 'Grace Hopper',
  avatarUrl: null,
};

/** A Google identity nobody above has used: the code path's own, so its outcome is its own. */
const lin: GoogleProfile = {
  sub: '1000-lin',
  email: 'lin@example.com',
  emailVerified: true,
  name: 'Lin Zhao',
  avatarUrl: null,
};

const dataDir = mkdtempSync(join(tmpdir(), 'pen-google-'));
let services: Services;
let app: Hono;
let identity: Identity;
let verifier: FakeVerifier;
let exchanger: FakeExchanger;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
  });
  verifier = new FakeVerifier({ 'ok:ada': ada, 'ok:grace': grace, 'ok:lin': lin });
  exchanger = new FakeExchanger({ 'code:lin-4/0AbCdEfGhIjKlMnOp': 'ok:lin' });
  services = await buildServices(cfg, { googleVerifier: verifier, googleExchanger: exchanger });
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const json = (path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function anonymous(name?: string) {
  const res = await json('/api/auth/anonymous', name ? { name } : {});
  expect(res.status).toBe(200);
  return (await res.json()) as {
    token: string;
    participant: { id: string; name: string; anonymous: boolean };
  };
}

describe('GoogleSignIn (link/upgrade logic)', () => {
  const signIn = () => new GoogleSignIn(verifier, services.participants, services.lists, 'free');

  it('upgrades an anonymous participant in place: same id, Google profile, no longer anonymous', async () => {
    const anon = await services.participants.ensure({
      id: 'p_anon_upgrade_1',
      name: 'Learner',
      plan: 'free',
      anonymous: true,
    });
    const result = await signIn().signIn('ok:ada', anon);
    expect(result.outcome).toBe('linked');
    expect(result.participant.id).toBe('p_anon_upgrade_1');
    expect(result.participant.anonymous).toBe(false);
    expect(result.participant.googleSub).toBe('1000-ada');
    expect(result.participant.email).toBe('ada@example.com');
    expect(result.participant.name).toBe('Ada Lovelace');
    expect(result.participant.avatarUrl).toBe(ada.avatarUrl);
    expect(result.participant.provider).toBe('google');
  });

  it('a name the learner chose survives the upgrade; an unverified email is not stored', async () => {
    const anon = await services.participants.ensure({
      id: 'p_anon_named_1',
      name: 'Gracie',
      plan: 'free',
      anonymous: true,
    });
    const result = await signIn().signIn('ok:grace', anon);
    expect(result.outcome).toBe('linked');
    expect(result.participant.name).toBe('Gracie');
    expect(result.participant.email).toBeNull();
    expect(result.participant.anonymous).toBe(false);
  });

  it('a second sign-in for the same Google account lands on the existing row, and adopts an anonymous caller’s sessions', async () => {
    const other = await services.participants.ensure({
      id: 'p_anon_other_1',
      name: 'Learner',
      plan: 'free',
      anonymous: true,
    });
    await services.sessions.upsert({
      id: 's_adopt_1',
      topic: 'Swift',
      language: 'en-US',
      title: 'Swift',
      promise: '',
      expertId: 'juno',
      hostId: other.id,
      hostName: 'Learner',
      band: 'beginner',
      domain: 'computing-data',
      visibility: 'public',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      segments: 0,
      questions: 0,
      recap: [],
      views: 0,
      thumbnail: null,
      canonicalId: null,
      description: '',
      keywords: [],
      likes: 0,
    });
    const result = await signIn().signIn('ok:ada', other);
    expect(result.outcome).toBe('existing');
    expect(result.participant.id).toBe('p_anon_upgrade_1');
    expect(result.adoptedSessions).toBe(1);
    expect((await services.sessions.get('s_adopt_1'))?.hostId).toBe('p_anon_upgrade_1');
    // The abandoned anonymous row is left as it was (nothing references it any more).
    expect((await services.participants.get(other.id))?.anonymous).toBe(true);
  });

  it('with no caller and an unknown Google account, creates a fresh account row', async () => {
    const fresh = new FakeVerifier({
      'ok:new': { ...ada, sub: '1000-new', email: 'new@example.com', name: 'Newcomer' },
    });
    const result = await new GoogleSignIn(
      fresh,
      services.participants,
      services.lists,
      'free',
    ).signIn('ok:new', null);
    expect(result.outcome).toBe('created');
    expect(result.participant.id).toMatch(/^p_/);
    expect(result.participant.anonymous).toBe(false);
    expect(result.participant.name).toBe('Newcomer');
  });

  it('a signed-in account switching to a different Google identity gets its own row, not a hijacked one', async () => {
    const signed = await services.participants.get('p_anon_upgrade_1');
    if (!signed) throw new Error('fixture missing');
    const other = new FakeVerifier({
      'ok:someone': { ...grace, sub: '1000-someone', emailVerified: true },
    });
    const result = await new GoogleSignIn(
      other,
      services.participants,
      services.lists,
      'free',
    ).signIn('ok:someone', signed);
    expect(result.outcome).toBe('created');
    expect(result.participant.id).not.toBe(signed.id);
    expect((await services.participants.get(signed.id))?.googleSub).toBe('1000-ada');
  });

  it('propagates verifier failures untouched (expired, wrong audience, invalid)', async () => {
    for (const [token, reason] of [
      ['expired:x', 'expired'],
      ['audience:x', 'wrong_audience'],
      ['garbage-token-value', 'invalid'],
    ] as const) {
      const error = await signIn()
        .signIn(token, null)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoogleTokenError);
      expect((error as GoogleTokenError).reason).toBe(reason);
    }
  });
});

describe('POST /api/identity/google', () => {
  it('400 on a malformed body', async () => {
    expect((await json('/api/identity/google', {})).status).toBe(400);
    expect((await json('/api/identity/google', { idToken: 'short' })).status).toBe(400);
    const raw = await app.request('/api/identity/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(raw.status).toBe(400);
  });

  it('401 for expired, wrong-audience and invalid tokens, with the reason', async () => {
    for (const [token, reason] of [
      ['expired:0123456789abcdef', 'expired'],
      ['audience:0123456789abcdef', 'wrong_audience'],
      ['invalid:0123456789abcdef', 'invalid'],
    ] as const) {
      const res = await json('/api/identity/google', { idToken: token });
      expect(res.status, token).toBe(401);
      const body = (await res.json()) as { error: string; reason: string; message: string };
      expect(body.error).toBe('INVALID_TOKEN');
      expect(body.reason).toBe(reason);
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it('200: an anonymous bearer is upgraded in place and keeps its id; /api/me reflects the account', async () => {
    const fresh = new FakeVerifier({
      'ok:route-ada-0123456789': { ...ada, sub: '2000-ada' },
    });
    services.google = new GoogleSignIn(fresh, services.participants, services.lists, 'free');
    const anon = await anonymous('Sam');
    expect(anon.participant.anonymous).toBe(true);
    const res = await json(
      '/api/identity/google',
      { idToken: 'ok:route-ada-0123456789' },
      anon.token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      outcome: string;
      participant: {
        id: string;
        name: string;
        anonymous: boolean;
        email: string | null;
        avatarUrl: string | null;
      };
    };
    expect(body.outcome).toBe('linked');
    expect(body.participant.id).toBe(anon.participant.id);
    expect(body.participant.anonymous).toBe(false);
    expect(body.participant.name).toBe('Sam');
    expect(body.participant.email).toBe('ada@example.com');
    expect(body.participant.avatarUrl).toBe(ada.avatarUrl);
    // Both bearers name the same participant; the new one carries the account claims.
    const oldClaims = await identity.verify(anon.token);
    const newClaims = await identity.verify(body.token);
    expect(oldClaims?.sub).toBe(newClaims?.sub);
    expect(newClaims?.anonymous).toBe(false);
    for (const token of [anon.token, body.token]) {
      const me = await app.request('/api/me', { headers: { authorization: `Bearer ${token}` } });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as {
        participant: { id: string; anonymous: boolean; avatarUrl: string | null };
      };
      expect(meBody.participant.id).toBe(anon.participant.id);
      expect(meBody.participant.anonymous).toBe(false);
      expect(meBody.participant.avatarUrl).toBe(ada.avatarUrl);
    }
    // Signing in again without any bearer (a new device) returns the same account.
    const again = await json('/api/identity/google', { idToken: 'ok:route-ada-0123456789' });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { outcome: string; participant: { id: string } };
    expect(againBody.outcome).toBe('existing');
    expect(againBody.participant.id).toBe(anon.participant.id);
  });

  it('503 when GOOGLE_CLIENT_ID is not configured, and health says google:false', async () => {
    const saved = services.google;
    services.google = null;
    try {
      const res = await json('/api/identity/google', { idToken: 'ok:0123456789abcdef' });
      expect(res.status).toBe(503);
      const health = (await (await app.request('/api/health')).json()) as { google: boolean };
      expect(health.google).toBe(false);
    } finally {
      services.google = saved;
    }
    const health = (await (await app.request('/api/health')).json()) as { google: boolean };
    expect(health.google).toBe(true);
  });
});

describe('PATCH /api/me', () => {
  it('renames in place without touching the id or the bearer', async () => {
    const anon = await anonymous('Sam');
    const res = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${anon.token}` },
      body: JSON.stringify({ name: '  Samantha <b>x</b> ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { participant: { id: string; name: string } };
    expect(body.participant.id).toBe(anon.participant.id);
    expect(body.participant.name).toBe('Samantha bx/b');
    const bad = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${anon.token}` },
      body: JSON.stringify({ name: '' }),
    });
    expect(bad.status).toBe(400);
    expect((await app.request('/api/me', { method: 'PATCH' })).status).toBe(401);
  });
});

describe('config', () => {
  it('GOOGLE_CLIENT_ID is optional and an empty value means unset', () => {
    const base = { NODE_ENV: 'test', PEN_JWT_SECRET: 'x'.repeat(40) };
    expect(loadConfig(base).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...base, GOOGLE_CLIENT_ID: '' }).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...base, GOOGLE_CLIENT_ID: 'abc' }).GOOGLE_CLIENT_ID).toBe('abc');
  });
});

describe('the app’s own button: a popup code, exchanged (ADR-0042)', () => {
  // A test above swaps in a Google service of its own without the exchanger
  // and leaves it there; this block installs the one it is about, and puts
  // back whatever it found.
  let before: Services['google'];
  beforeAll(() => {
    before = services.google;
    services.google = new GoogleSignIn(
      verifier,
      services.participants,
      services.lists,
      'free',
      exchanger,
    );
  });
  afterAll(() => {
    services.google = before;
  });

  it('signs in with a code exactly as with the ID token behind it', async () => {
    const anon = await anonymous('Learner');
    const res = await json(
      '/api/identity/google',
      { code: 'code:lin-4/0AbCdEfGhIjKlMnOp' },
      anon.token,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      participant: { id: string; anonymous: boolean; email: string | null };
    };
    // The same row, upgraded in place: the code path ends where the token path does.
    expect(body.outcome).toBe('linked');
    expect(body.participant.id).toBe(anon.participant.id);
    expect(body.participant.anonymous).toBe(false);
    expect(body.participant.email).toBe('lin@example.com');
    expect(exchanger.calls.at(-1)).toBe('code:lin-4/0AbCdEfGhIjKlMnOp');
    expect(verifier.calls.at(-1)).toBe('ok:lin');
  });

  it('refuses a code Google will not exchange with "try again", never a 500', async () => {
    const anon = await anonymous();
    const res = await json(
      '/api/identity/google',
      { code: 'code:used-or-forged-0000' },
      anon.token,
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toMatchObject({
      error: 'INVALID_TOKEN',
      reason: 'invalid',
    });
  });

  it('says so when the host has the id but not the secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pen-google-nosecret-'));
    const cfg = loadConfig({
      NODE_ENV: 'test',
      PEN_JWT_SECRET: 'x'.repeat(40),
      PEN_DATA_DIR: dir,
      DATABASE_URL: 'pglite://memory',
      PEN_LLM_PROVIDER: 'fake',
      PEN_TTS_PROVIDER: 'silent',
      GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
    });
    const bare = await buildServices(cfg, {
      googleVerifier: new FakeVerifier({ 'ok:ada-0123456789abcdef': ada }),
    });
    try {
      const { app: bareApp } = buildApp(bare);
      const health = (await (await bareApp.request('/api/health')).json()) as {
        google: boolean;
        googleCode: boolean;
      };
      expect(health.google).toBe(true);
      expect(health.googleCode).toBe(false);
      const post = (body: unknown) =>
        bareApp.request('/api/identity/google', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const res = await post({ code: 'code:lin-4/0AbCdEfGhIjKlMnOp' });
      expect(res.status).toBe(503);
      expect((await res.json()) as object).toMatchObject({ error: 'GOOGLE_DISABLED' });
      // The token path is untouched by the missing secret.
      const viaToken = await post({ idToken: 'ok:ada-0123456789abcdef' });
      expect(viaToken.status, await viaToken.clone().text()).toBe(200);
    } finally {
      bare.exports.close();
      await bare.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
