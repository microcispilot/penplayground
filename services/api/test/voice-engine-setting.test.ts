import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureFlagsDocument, FeatureFlagsHistory } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type GoogleProfile, GoogleTokenError, type GoogleTokenVerifier } from '../src/google.js';
import { Identity } from '../src/identity.js';
import type { RoomRegistry } from '../src/rooms.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';

/**
 * The voice engine setting end to end (ADR-0048): saved through the console's
 * route beside the flags, read back with the flags, kept when a save leaves
 * it out, restored by a rollback, and — the point of it — bound into the
 * next session for exactly the learner it names.
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

const dataDir = mkdtempSync(join(tmpdir(), 'pen-voice-setting-'));
let services: Services;
let app: Hono;
let rooms: RoomRegistry;
let identity: Identity;
let ownerAuth: Record<string, string>;

async function account(plan: 'free' | 'standard' | 'professional') {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: false });
  await services.participants.ensure({
    id: issued.claims.sub,
    name: 'Ada',
    plan,
    anonymous: false,
  });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const json = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

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
    PEN_MAX_SESSIONS_PER_IP: '100',
  });
  services = await buildServices(cfg, {
    googleVerifier: new FakeVerifier({ 'tok:owner-0123456789abcdef': owner }),
  });
  await seedPacks(services.onten, join(DATA_DIR, 'packs'));
  ({ app, rooms } = buildApp(services));
  identity = new Identity(cfg.PEN_JWT_SECRET);
  const res = await app.request('/api/identity/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'tok:owner-0123456789abcdef' }),
  });
  ownerAuth = { authorization: `Bearer ${((await res.json()) as { token: string }).token}` };
}, 60_000);

afterAll(async () => {
  rooms.sweep(Number.MAX_SAFE_INTEGER);
  services.exports.close();
  services.meta.close();
  services.features.stop();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function document(): Promise<FeatureFlagsDocument> {
  const res = await json('GET', '/api/admin/features', ownerAuth);
  expect(res.status).toBe(200);
  return (await res.json()) as FeatureFlagsDocument;
}

async function startSession(headers: Record<string, string>): Promise<string> {
  const res = await json('POST', '/api/sessions', headers, {
    topic: 'How Transformers work in LLMs',
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { session: { id: string } }).session.id;
}

describe('the voice engine setting', () => {
  it('is in the console document with Cartesia as the built-in default', async () => {
    const doc = await document();
    const row = doc.settings.find((s) => s.name === 'voice_engine');
    expect(row).toMatchObject({
      label: 'Voice engine',
      values: ['cartesia', 'fish'],
      storedRule: null,
      defaultRule: { default: 'cartesia' },
    });
    expect(row?.matrix.free.web).toBe('cartesia');
  });

  it('binds the engine into the next session for exactly the learner the rule names', async () => {
    const pro = await account('professional');
    const free = await account('free');
    const doc = await document();
    const saved = await json('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'Fish for Professional, and for one account',
      rules: {},
      settings: {
        voice_engine: {
          default: 'cartesia',
          plans: { professional: 'fish' },
          platforms: {},
          cells: {},
          participants: { [free.id]: 'fish' },
        },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const after = (await saved.json()) as FeatureFlagsDocument;
    expect(after.settings.find((s) => s.name === 'voice_engine')?.matrix.professional.web).toBe(
      'fish',
    );
    // Both bind Fish: one by plan, one by name. The engine the room carries is the policy's answer.
    const proSession = await startSession(pro.headers);
    expect(rooms.get(proSession)?.voice.engine).toBe('fish');
    const freeSession = await startSession(free.headers);
    expect(rooms.get(freeSession)?.voice.engine).toBe('fish');
    // Anyone else on the free plan is on the default.
    const other = await account('free');
    const otherSession = await startSession(other.headers);
    expect(rooms.get(otherSession)?.voice.engine).toBe('cartesia');
    // And a change never reaches a room already made.
    const revert = await json('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: after.revision,
      reason: 'back to the default',
      rules: {},
      settings: { voice_engine: null },
    });
    expect(revert.status).toBe(200);
    expect(rooms.get(proSession)?.voice.engine).toBe('fish');
    for (const id of [proSession, freeSession, otherSession]) await rooms.end(id, 'host');
  });

  it('keeps the setting when a save leaves it out, refuses a value it does not know, and rolls back with the flags', async () => {
    const doc = await document();
    const set = await json('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'Fish everywhere on Linux',
      rules: {},
      settings: {
        voice_engine: {
          default: 'cartesia',
          plans: {},
          platforms: { 'desktop-linux': 'fish' },
          cells: {},
          participants: {},
        },
      },
    });
    expect(set.status).toBe(200);
    const rev1 = ((await set.json()) as FeatureFlagsDocument).revision;
    // A flags-only save: the setting stays as stored.
    const flagsOnly = await json('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: rev1,
      reason: 'flags only',
      rules: { chat: { default: false, plans: {}, platforms: {}, cells: {} } },
    });
    expect(flagsOnly.status).toBe(200);
    const afterFlags = (await flagsOnly.json()) as FeatureFlagsDocument;
    expect(
      afterFlags.settings.find((s) => s.name === 'voice_engine')?.storedRule?.platforms,
    ).toEqual({ 'desktop-linux': 'fish' });
    // An engine nobody has is refused, with the place named.
    const bad = await json('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: afterFlags.revision,
      reason: 'typo',
      rules: {},
      settings: {
        voice_engine: { default: 'eleven', plans: {}, platforms: {}, cells: {}, participants: {} },
      },
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toMatch(/default: \\"eleven\\"/);
    // History carries the settings apart from the flags; a rollback restores both.
    const history = (await (
      await json('GET', '/api/admin/features/history', ownerAuth)
    ).json()) as FeatureFlagsHistory;
    const latest = history.entries[0];
    expect(latest?.settings.voice_engine?.platforms).toEqual({ 'desktop-linux': 'fish' });
    expect(latest?.rules.chat?.default).toBe(false);
    const rolled = await json('POST', '/api/admin/features/rollback', ownerAuth, {
      expectedRevision: afterFlags.revision,
      targetRevision: doc.revision,
      reason: 'undo',
    });
    expect(rolled.status, await rolled.clone().text()).toBe(200);
    const restored = (await rolled.json()) as FeatureFlagsDocument;
    expect(restored.settings.find((s) => s.name === 'voice_engine')?.storedRule).toBeNull();
    expect(restored.features.find((f) => f.name === 'chat')?.storedRule).toBeNull();
  });
});
