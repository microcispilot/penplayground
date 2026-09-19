import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfigDocument, RuntimeConfigHistory } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type GoogleProfile, GoogleTokenError, type GoogleTokenVerifier } from '../src/google.js';
import type { RoomRegistry } from '../src/rooms.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The Settings console's own routes (ADR-0025): who may open them, what a
 * save does to the audit trail, what two people saving at once get, and the
 * one rule that makes a live change safe — a room keeps the settings it was
 * built with.
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
  email: 'Owner@Pen.test',
  emailVerified: true,
  name: 'Sam Owner',
  avatarUrl: null,
};
const bystander: GoogleProfile = {
  sub: '9001-bystander',
  email: 'someone@else.test',
  emailVerified: true,
  name: 'Someone Else',
  avatarUrl: null,
};

const dataDir = mkdtempSync(join(tmpdir(), 'pen-admin-config-'));
let services: Services;
let app: Hono;
let rooms: RoomRegistry;
let ownerAuth: Record<string, string>;
let bystanderAuth: Record<string, string>;

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
    // Case and spacing are the operator's business, not the check's.
    PEN_ADMIN_EMAILS: ' owner@pen.test , second@pen.test ',
  });
  services = await buildServices(cfg, {
    googleVerifier: new FakeVerifier({
      'tok:owner-0123456789abcdef': owner,
      'tok:bystander-0123456789abcdef': bystander,
    }),
  });
  ({ app, rooms } = buildApp(services));
  ownerAuth = await signIn('tok:owner-0123456789abcdef');
  bystanderAuth = await signIn('tok:bystander-0123456789abcdef');
}, 60_000);

afterAll(async () => {
  services.exports.close();
  services.meta.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(idToken: string): Promise<Record<string, string>> {
  const res = await app.request('/api/identity/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return { authorization: `Bearer ${body.token}` };
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function read(headers = ownerAuth): Promise<RuntimeConfigDocument> {
  const res = await call('GET', '/api/admin/runtime-config', headers);
  expect(res.status).toBe(200);
  return (await res.json()) as RuntimeConfigDocument;
}

function settingOf(doc: RuntimeConfigDocument, name: string) {
  const row = doc.settings.find((s) => s.name === name);
  if (!row) throw new Error(`${name} is not in the document`);
  return row;
}

describe('who may open the console', () => {
  it('lets an allow-listed address in and turns everyone else away', async () => {
    const mine = await call('GET', '/api/admin/session', ownerAuth);
    expect(await mine.json()).toMatchObject({ admin: true, email: 'owner@pen.test' });

    const theirs = await call('GET', '/api/admin/session', bystanderAuth);
    expect(await theirs.json()).toEqual({ admin: false });

    for (const path of ['/api/admin/runtime-config', '/api/admin/runtime-config/history']) {
      expect((await call('GET', path, bystanderAuth)).status).toBe(403);
      expect((await call('GET', path, {})).status).toBe(403);
    }
    expect(
      (
        await call('PUT', '/api/admin/runtime-config', bystanderAuth, {
          expectedRevision: 0,
          reason: 'trying it on',
          settings: {},
        })
      ).status,
    ).toBe(403);
  });

  it('never caches an admin answer', async () => {
    const res = await call('GET', '/api/admin/runtime-config', ownerAuth);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the document', () => {
  it('lists every setting with its default, what is stored and what is in force', async () => {
    const doc = await read();
    expect(doc.revision).toBe(0);
    expect(doc.stale).toBe(false);
    const quality = settingOf(doc, 'PEN_THUMBNAIL_QUALITY');
    expect(quality).toMatchObject({
      kind: 'choice',
      options: ['low', 'medium', 'high'],
      defaultValue: 'low',
      storedValue: null,
      effectiveValue: 'low',
      source: 'default',
      pinnedByEnv: false,
      scope: 'session',
    });
    // The environment pinned this one for the test run, and the row says so.
    expect(settingOf(doc, 'PEN_LLM_PROVIDER')).toMatchObject({
      source: 'env',
      pinnedByEnv: true,
      effectiveValue: 'fake',
    });
    // Jev ships on (ADR-0025).
    expect(settingOf(doc, 'PEN_INTENT_PROVIDER').defaultValue).toBe('jev');
    // A setting that may legitimately have no value offers "unset".
    expect(settingOf(doc, 'PEN_LLM_SERVICE_TIER').options).toEqual([
      'unset',
      'auto',
      'default',
      'flex',
      'priority',
    ]);
  });
});

describe('saving', () => {
  it('records who changed what and why, and the process runs on it at once', async () => {
    const before = await read();
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: before.revision,
      reason: 'Sharper cards for the launch page',
      settings: { PEN_THUMBNAIL_QUALITY: 'high' },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as RuntimeConfigDocument;
    expect(doc.revision).toBe(before.revision + 1);
    expect(doc.updatedByName).toBe('Sam Owner');
    expect(settingOf(doc, 'PEN_THUMBNAIL_QUALITY')).toMatchObject({
      storedValue: 'high',
      effectiveValue: 'high',
      source: 'stored',
    });
    // No poll needed: the process that took the save is already on it.
    expect(services.config.get('PEN_THUMBNAIL_QUALITY')).toBe('high');

    const history = (await (
      await call('GET', '/api/admin/runtime-config/history', ownerAuth)
    ).json()) as RuntimeConfigHistory;
    expect(history.entries[0]).toMatchObject({
      revision: doc.revision,
      updatedByName: 'Sam Owner',
      reason: 'Sharper cards for the launch page',
      restoredFromRevision: null,
      settings: { PEN_THUMBNAIL_QUALITY: 'high' },
    });
    expect(history.entries[0]?.updatedAt).toBeGreaterThan(0);
  });

  it('refuses a stale revision instead of quietly overwriting the other editor', async () => {
    const doc = await read();
    const ok = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'first writer',
      settings: { PEN_ADS_EVERY_SEGMENTS: 4 },
    });
    expect(ok.status).toBe(200);

    // The second editor was still looking at the old revision.
    const clash = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'second writer',
      settings: { PEN_ADS_EVERY_SEGMENTS: 9 },
    });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: 'CONFLICT', current: doc.revision + 1 });
    // And the first writer's value is still the one in force.
    expect(services.config.get('PEN_ADS_EVERY_SEGMENTS')).toBe(4);
  });

  it('refuses a value the environment schema would have refused, naming the setting', async () => {
    const doc = await read();
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'a quality that does not exist',
      settings: { PEN_THUMBNAIL_QUALITY: 'ultra' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toContain('Picture quality');
    // Nothing moved.
    expect((await read()).revision).toBe(doc.revision);
  });

  it('refuses a number outside the bounds the registry declares', async () => {
    const doc = await read();
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'a body limit that would break every write',
      settings: { PEN_MAX_BODY_BYTES: 12 },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a save with no reason, because history without a why is not history', async () => {
    const doc = await read();
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: '   ',
      settings: {},
    });
    expect(res.status).toBe(400);
  });

  it('clears an override back to the default when it is left out', async () => {
    // A save carries the whole override document, so leaving a name out is
    // how it is cleared. Set it first, so this test does not depend on what
    // the one before it happened to leave behind.
    const start = await read();
    const set = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: start.revision,
      reason: 'sharper for a moment',
      settings: { PEN_THUMBNAIL_QUALITY: 'high', PEN_ADS_EVERY_SEGMENTS: 4 },
    });
    const doc = (await set.json()) as RuntimeConfigDocument;
    expect(settingOf(doc, 'PEN_THUMBNAIL_QUALITY').storedValue).toBe('high');
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'back to the cheap picture',
      settings: { PEN_ADS_EVERY_SEGMENTS: 4 },
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as RuntimeConfigDocument;
    expect(settingOf(after, 'PEN_THUMBNAIL_QUALITY')).toMatchObject({
      storedValue: null,
      effectiveValue: 'low',
      source: 'default',
    });
  });
});

describe('a setting that may legitimately have no value', () => {
  it('round-trips through `unset`, which stores nothing rather than the word', async () => {
    const start = await read();
    // Choose one.
    const chosen = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: start.revision,
      reason: 'flex tier for the weekend',
      settings: { PEN_LLM_SERVICE_TIER: 'flex' },
    });
    expect(chosen.status).toBe(200);
    expect(
      settingOf((await chosen.json()) as RuntimeConfigDocument, 'PEN_LLM_SERVICE_TIER'),
    ).toMatchObject({ storedValue: 'flex', effectiveValue: 'flex', source: 'stored' });
    expect(services.config.get('PEN_LLM_SERVICE_TIER')).toBe('flex');

    // Choose nothing. `unset` is how the screen says it, and the document
    // holds no value at all afterwards rather than the string "unset".
    const doc = await read();
    const cleared = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'back to the account default',
      settings: { PEN_LLM_SERVICE_TIER: 'unset' },
    });
    expect(cleared.status).toBe(200);
    const after = (await cleared.json()) as RuntimeConfigDocument;
    expect(settingOf(after, 'PEN_LLM_SERVICE_TIER')).toMatchObject({
      storedValue: null,
      effectiveValue: null,
      source: 'default',
    });
    expect(services.config.get('PEN_LLM_SERVICE_TIER')).toBeUndefined();
    // And the history records the clearing as an empty document, not as "unset".
    const history = (await (
      await call('GET', '/api/admin/runtime-config/history?limit=1', ownerAuth)
    ).json()) as RuntimeConfigHistory;
    expect(history.entries[0]?.settings.PEN_LLM_SERVICE_TIER).toBeUndefined();
  });

  it('refuses `unset` on a setting that must always have a value', async () => {
    const doc = await read();
    const res = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'there is no such thing as no picture quality',
      settings: { PEN_THUMBNAIL_QUALITY: 'unset' },
    });
    expect(res.status).toBe(422);
  });
});

describe('rollback', () => {
  it('restores an old document as a NEW revision, leaving the history it came from intact', async () => {
    const start = await read();
    const marked = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: start.revision,
      reason: 'the revision we will come back to',
      settings: { PEN_ADS_EVERY_SEGMENTS: 6, PEN_THUMBNAIL_QUALITY: 'medium' },
    });
    const good = ((await marked.json()) as RuntimeConfigDocument).revision;

    const broke = await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: good,
      reason: 'a change we regret',
      settings: { PEN_ADS_EVERY_SEGMENTS: 1 },
    });
    const bad = ((await broke.json()) as RuntimeConfigDocument).revision;

    const res = await call('POST', '/api/admin/runtime-config/rollback', ownerAuth, {
      expectedRevision: bad,
      targetRevision: good,
      reason: 'the cadence was wrong',
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as RuntimeConfigDocument;
    // Forward, never backward.
    expect(doc.revision).toBe(bad + 1);
    expect(settingOf(doc, 'PEN_ADS_EVERY_SEGMENTS').effectiveValue).toBe(6);
    expect(settingOf(doc, 'PEN_THUMBNAIL_QUALITY').effectiveValue).toBe('medium');

    const history = (await (
      await call('GET', '/api/admin/runtime-config/history?limit=3', ownerAuth)
    ).json()) as RuntimeConfigHistory;
    expect(history.entries.map((e) => e.revision)).toEqual([bad + 1, bad, good]);
    expect(history.entries[0]?.restoredFromRevision).toBe(good);
    // The revision that was rolled back is still there, exactly as it was.
    expect(history.entries[1]).toMatchObject({
      reason: 'a change we regret',
      settings: { PEN_ADS_EVERY_SEGMENTS: 1 },
    });
  });

  it('refuses a target that is not older than the current revision, and one that never existed', async () => {
    const doc = await read();
    for (const target of [doc.revision, doc.revision + 1]) {
      const res = await call('POST', '/api/admin/runtime-config/rollback', ownerAuth, {
        expectedRevision: doc.revision,
        targetRevision: target,
        reason: 'nope',
      });
      expect(res.status).toBe(422);
    }
    const missing = await call('POST', '/api/admin/runtime-config/rollback', ownerAuth, {
      expectedRevision: doc.revision,
      targetRevision: 1_000_000,
      reason: 'nope',
    });
    // Not older than current, so it is refused before the lookup even happens.
    expect(missing.status).toBe(422);
  });

  it('can go all the way back to the empty document', async () => {
    const doc = await read();
    const res = await call('POST', '/api/admin/runtime-config/rollback', ownerAuth, {
      expectedRevision: doc.revision,
      targetRevision: 0,
      reason: 'start again',
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as RuntimeConfigDocument;
    expect(after.settings.every((s) => s.storedValue === null)).toBe(true);
  });
});

describe('a session keeps the settings it was built with', () => {
  it('does not change its mind half way through when the document changes', async () => {
    const host = await app.request('/api/auth/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Learner' }),
    });
    const { token, participant } = (await host.json()) as {
      token: string;
      participant: { id: string; name: string };
    };

    const doc = await read();
    await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: doc.revision,
      reason: 'before the lesson starts',
      settings: { PEN_LLM_MODEL: 'model-at-build-time' },
    });

    const created = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    const live = rooms.get(session.id);
    if (!live) throw new Error('the room should be live');
    expect(live.settings.PEN_LLM_MODEL).toBe('model-at-build-time');

    // The dashboard changes while the lesson is running.
    const mid = await read();
    await call('PUT', '/api/admin/runtime-config', ownerAuth, {
      expectedRevision: mid.revision,
      reason: 'mid-lesson change',
      settings: { PEN_LLM_MODEL: 'model-changed-mid-lesson' },
    });
    expect(services.config.get('PEN_LLM_MODEL')).toBe('model-changed-mid-lesson');

    // This room is untouched, and will report what it ran on.
    expect(live.settings.PEN_LLM_MODEL).toBe('model-at-build-time');
    expect(participant.id).toBe(live.record.hostId);
    await rooms.end(session.id);
  }, 60_000);
});
