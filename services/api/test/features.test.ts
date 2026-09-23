import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureFlagsDocument, FeatureFlagsHistory, MyFeatures } from '@pen/contracts';
import { FEATURE_NAMES, PLATFORM_HEADER } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
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
 * Feature flags end to end (ADR-0036), and the two things they decide for a
 * learner (ADR-0035): whether a topic nobody has prepared gets prepared for
 * them, and what "replay" is. Every rule is proved through the routes a
 * client uses, against the real store.
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

const dataDir = mkdtempSync(join(tmpdir(), 'pen-features-'));
let services: Services;
let app: Hono;
let rooms: RoomRegistry;
let identity: Identity;
let ownerAuth: Record<string, string>;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(plan: 'free' | 'standard' | 'professional' = 'free'): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous: true });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
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

/** An ended, recorded session, as a real room leaves behind. */
async function seedSession(hostId: string, visibility: 'public' | 'private' = 'public') {
  const startedAt = Date.now() - 60_000;
  const id = `s_${Math.random().toString(36).slice(2, 10)}`;
  const record: SessionRecord = {
    id,
    topic: 'How Transformers work in LLMs',
    title: 'How Transformers Work in LLMs',
    promise: '',
    expertId: 'niko-database-expert',
    hostId,
    hostName: 'Ada',
    band: 'beginner',
    domain: 'ml',
    visibility,
    startedAt,
    endedAt: startedAt + 60_000,
    durationMs: 60_000,
    segments: 1,
    questions: 1,
    recap: ['One thing'],
    views: 0,
    thumbnail: null,
    canonicalId: null,
    language: 'en-US',
    description: '',
    keywords: [],
    likes: 0,
  };
  await services.sessions.upsert(record);
  services.ledger.append(id, { kind: 'join', t: startedAt, participantId: hostId, name: 'Ada' });
  services.ledger.append(id, {
    kind: 'cue',
    t: startedAt + 1,
    cue: {
      seq: 0,
      segment: 0,
      thread: 'lesson',
      at: startedAt + 1,
      event: { type: 'say', id: 'L0.s1', text: 'A first sentence.', tone: 'neutral' },
    },
  });
  services.ledger.append(id, {
    kind: 'caption',
    t: startedAt + 2_000,
    participantId: hostId,
    text: 'Why is that?',
  });
  services.ledger.append(id, {
    kind: 'cue',
    t: startedAt + 2_100,
    cue: {
      seq: 1,
      segment: 0,
      thread: 't1',
      at: startedAt + 2_100,
      event: { type: 'say', id: 't1.s0', text: 'Good question.', tone: 'warm' },
    },
  });
  return record;
}

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
  // The seeded pack, as `main.ts` loads it: a saved lesson on a prepared
  // topic is what a replay starts from, and a replay of an unprepared one
  // is a contradiction the gate refuses like any other miss.
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
  services.exports.close();
  services.meta.close();
  services.features.stop();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function saveRules(rules: unknown, reason = 'test'): Promise<FeatureFlagsDocument> {
  const current = (await (
    await call('GET', '/api/admin/features', ownerAuth)
  ).json()) as FeatureFlagsDocument;
  const res = await call('PUT', '/api/admin/features', ownerAuth, {
    expectedRevision: current.revision,
    reason,
    rules,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as FeatureFlagsDocument;
}

describe('the learner’s own cell', () => {
  it('answers every feature for the caller’s plan on the platform they name', async () => {
    const free = await participant('free');
    const web = (await (await call('GET', '/api/me/features', free.headers)).json()) as MyFeatures;
    expect(web.platform).toBe('web');
    expect(Object.keys(web.features).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(web.features.prepare_new_topics).toBe(false);
    expect(web.features.google_sign_in).toBe(true);
    expect(web.features.ads).toBe(true);

    const mac = (await (
      await call('GET', '/api/me/features', { ...free.headers, [PLATFORM_HEADER]: 'desktop-mac' })
    ).json()) as MyFeatures;
    expect(mac.platform).toBe('desktop-mac');
    expect(mac.features.google_sign_in).toBe(false);

    const pro = await participant('professional');
    const proWeb = (await (
      await call('GET', '/api/me/features', pro.headers)
    ).json()) as MyFeatures;
    expect(proWeb.features.prepare_new_topics).toBe(true);
    expect(proWeb.features.ads).toBe(false);
    expect(proWeb.features.rooms).toBe(true);
  });

  it('treats a platform it does not know as the web', async () => {
    const free = await participant('free');
    const odd = (await (
      await call('GET', '/api/me/features', { ...free.headers, [PLATFORM_HEADER]: 'visionos' })
    ).json()) as MyFeatures;
    expect(odd.platform).toBe('web');
  });
});

describe('the console', () => {
  it('turns everyone but an operator away', async () => {
    const free = await participant('free');
    expect((await call('GET', '/api/admin/features', free.headers)).status).toBe(403);
    expect((await call('GET', '/api/admin/features/history', free.headers)).status).toBe(403);
    expect(
      (
        await call('PUT', '/api/admin/features', free.headers, {
          expectedRevision: 0,
          reason: 'x',
          rules: {},
        })
      ).status,
    ).toBe(403);
  });

  it('serves the whole catalogue with every rule resolved for every plan on every platform', async () => {
    const doc = (await (
      await call('GET', '/api/admin/features', ownerAuth)
    ).json()) as FeatureFlagsDocument;
    expect(doc.stale).toBe(false);
    expect(doc.features.map((f) => f.name).sort()).toEqual([...FEATURE_NAMES].sort());
    const prepare = doc.features.find((f) => f.name === 'prepare_new_topics');
    expect(prepare?.storedRule).toBeNull();
    expect(prepare?.matrix.free.web).toBe(false);
    expect(prepare?.matrix.standard.web).toBe(true);
  });

  it('saves a rule, records who and why, applies it at once, and stores nothing for a rule at its built-in value', async () => {
    const saved = await saveRules(
      {
        prepare_new_topics: { default: false, plans: { free: true }, platforms: {}, cells: {} },
        // Exactly the compiled-in rule: not a decision, not stored.
        ads: {
          default: true,
          plans: { standard: false, professional: false },
          platforms: {},
          cells: {},
        },
      },
      'launch week',
    );
    expect(saved.revision).toBeGreaterThan(0);
    expect(saved.updatedByName).toBe('Sam Owner');
    const prepare = saved.features.find((f) => f.name === 'prepare_new_topics');
    expect(prepare?.storedRule?.plans).toEqual({ free: true });
    expect(prepare?.matrix.free.web).toBe(true);
    expect(saved.features.find((f) => f.name === 'ads')?.storedRule).toBeNull();
    // The serving store took it in the same tick.
    expect(services.features.enabled('prepare_new_topics', { plan: 'free', platform: 'web' })).toBe(
      true,
    );
    const history = (await (
      await call('GET', '/api/admin/features/history', ownerAuth)
    ).json()) as FeatureFlagsHistory;
    expect(history.entries[0]).toMatchObject({
      revision: saved.revision,
      reason: 'launch week',
      updatedByName: 'Sam Owner',
    });
    expect(Object.keys(history.entries[0]?.rules ?? {})).toEqual(['prepare_new_topics']);
  });

  it('refuses a stale revision, a rule that is not one, and a feature that does not exist', async () => {
    const stale = await call('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: 0,
      reason: 'stale',
      rules: {},
    });
    expect(stale.status).toBe(409);
    const current = (await (
      await call('GET', '/api/admin/features', ownerAuth)
    ).json()) as FeatureFlagsDocument;
    const bad = await call('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: current.revision,
      reason: 'bad',
      rules: { prepare_new_topics: { default: 'yes' } },
    });
    expect(bad.status).toBe(400);
    const unknown = await call('PUT', '/api/admin/features', ownerAuth, {
      expectedRevision: current.revision,
      reason: 'bad',
      rules: { teleport: { default: true, plans: {}, platforms: {}, cells: {} } },
    });
    expect(unknown.status).toBe(400);
  });

  it('rolls back by writing the old document forward, and says which it restored', async () => {
    const current = (await (
      await call('GET', '/api/admin/features', ownerAuth)
    ).json()) as FeatureFlagsDocument;
    const res = await call('POST', '/api/admin/features/rollback', ownerAuth, {
      expectedRevision: current.revision,
      targetRevision: 0,
      reason: 'back to the built-in rules',
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as FeatureFlagsDocument;
    expect(doc.revision).toBe(current.revision + 1);
    expect(doc.features.every((f) => f.storedRule === null)).toBe(true);
    expect(services.features.enabled('prepare_new_topics', { plan: 'free', platform: 'web' })).toBe(
      false,
    );
    const history = (await (
      await call('GET', '/api/admin/features/history', ownerAuth)
    ).json()) as FeatureFlagsHistory;
    expect(history.entries[0]?.restoredFromRevision).toBe(0);
  });
});

describe('preparing a topic nobody has prepared', () => {
  it('is refused for a free learner with the way forward and the lessons that are ready, and costs them nothing', async () => {
    const free = await participant('free');
    const ready = await seedSession((await participant('standard')).id, 'public');
    const before = await services.sessions.countSince(free.id, 0);
    const res = await call('POST', '/api/sessions', free.headers, {
      topic: 'Reading an ECG strip',
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: string;
      message: string;
      ready: Array<{ id: string; hostId: string }>;
    };
    expect(body.error).toBe('PREPARATION_REQUIRED');
    expect(body.message).toMatch(/Upgrade/);
    expect(body.ready.some((s) => s.id === ready.id)).toBe(true);
    for (const s of body.ready) expect(s.hostId).toBe('');
    // Not a session: nothing was written, nothing was counted against the day.
    expect(await services.sessions.countSince(free.id, 0)).toBe(before);
  });

  it('goes ahead for a plan the rule allows, and for a free learner once the rule is opened', async () => {
    const standard = await participant('standard');
    const paid = await call('POST', '/api/sessions', standard.headers, {
      topic: 'Reading an ECG strip',
    });
    expect(paid.status).toBe(201);
    const { session } = (await paid.json()) as { session: { id: string } };
    await rooms.end(session.id);

    await saveRules({
      prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} },
    });
    const free = await participant('free');
    const opened = await call('POST', '/api/sessions', free.headers, {
      topic: 'How a pendulum clock keeps time',
    });
    expect(opened.status).toBe(201);
    await rooms.end(((await opened.json()) as { session: { id: string } }).session.id);
    await saveRules({ prepare_new_topics: null });
  });
});

describe('replay is a fresh session of your own (ADR-0035)', () => {
  it('starts the saved lesson again for anyone, with its expert, band and language, and the room knows it is a replay', async () => {
    const author = await participant('standard');
    const saved = await seedSession(author.id, 'public');
    const other = await participant('free');
    const res = await call('POST', '/api/sessions', other.headers, { replayOf: saved.id });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionRecord };
    expect(session.id).not.toBe(saved.id);
    expect(session.hostId).toBe(other.id);
    expect(session.topic).toBe(saved.topic);
    expect(session.expertId).toBe(saved.expertId);
    expect(session.band).toBe(saved.band);
    expect(session.language).toBe(saved.language);
    await rooms.end(session.id);
  });

  it('never starts from a private session that is not yours, and never from a lesson that is gone', async () => {
    const author = await participant('standard');
    const hidden = await seedSession(author.id, 'private');
    const other = await participant('free');
    expect(
      (await call('POST', '/api/sessions', other.headers, { replayOf: hidden.id })).status,
    ).toBe(404);
    expect(
      (await call('POST', '/api/sessions', other.headers, { replayOf: 'AAAAAAAAAAAA' })).status,
    ).toBe(404);
    const own = await call('POST', '/api/sessions', author.headers, { replayOf: hidden.id });
    expect(own.status).toBe(201);
    await rooms.end(((await own.json()) as { session: { id: string } }).session.id);
  });

  it('is a flag: off, the saved page cannot start it', async () => {
    await saveRules({ quick_start: { default: false, plans: {}, platforms: {}, cells: {} } });
    const author = await participant('standard');
    const saved = await seedSession(author.id, 'public');
    const res = await call('POST', '/api/sessions', (await participant('free')).headers, {
      replayOf: saved.id,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('FEATURE_OFF');
    await saveRules({ quick_start: null });
  });
});

describe('a recording is its host’s', () => {
  it('opens for the host by bearer or by token, and for nobody else — the words in it are theirs', async () => {
    const host = await participant('standard');
    const saved = await seedSession(host.id, 'public');
    const mine = await call('GET', `/api/sessions/${saved.id}/ledger`, host.headers);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { entries: Array<{ kind: string; text?: string }> };
    expect(body.entries.some((e) => e.kind === 'caption' && e.text === 'Why is that?')).toBe(true);

    const token = await services.downloadTokens.issue(host.id, saved.id);
    expect((await app.request(`/api/sessions/${saved.id}/ledger?token=${token}`)).status).toBe(200);

    const stranger = await participant('professional');
    expect((await call('GET', `/api/sessions/${saved.id}/ledger`, stranger.headers)).status).toBe(
      403,
    );
    expect((await app.request(`/api/sessions/${saved.id}/ledger`)).status).toBe(401);
    const theirs = await services.downloadTokens.issue(stranger.id, saved.id);
    expect((await app.request(`/api/sessions/${saved.id}/ledger?token=${theirs}`)).status).toBe(
      403,
    );
    // The record itself stays public, with the host stripped: the lesson is public, the hour is not.
    const record = (await (await app.request(`/api/sessions/${saved.id}`)).json()) as {
      session: { hostId: string };
    };
    expect(record.session.hostId).toBe('');
  });

  it('is a flag too: off for a plan, even the host cannot watch it', async () => {
    await saveRules({
      recording_playback: { default: true, plans: { free: false }, platforms: {}, cells: {} },
    });
    const free = await participant('free');
    const saved = await seedSession(free.id, 'public');
    const res = await call('GET', `/api/sessions/${saved.id}/ledger`, free.headers);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('FEATURE_OFF');
    await saveRules({ recording_playback: null });
  });
});

describe('the download, with or without the learner in it', () => {
  it('renders two different files, names which is which, and lists the newest on the shelf', async () => {
    const host = await participant('standard');
    const saved = await seedSession(host.id, 'public');
    const rendered: Array<{ variant: string; path: string }> = [];
    services.exports = new (await import('../src/export/jobs.js')).ExportJobs({
      sessionsDir: join(dataDir, 'sessions'),
      renderer: {
        async render({ variant, outputPath }) {
          rendered.push({ variant, path: outputPath });
          const { writeFileSync } = await import('node:fs');
          writeFileSync(outputPath, Buffer.from(`mp4:${variant}`));
          return { durationMs: 1000, syncDriftMs: 0, sayStartsMs: [0], tapeStartsMs: [0] };
        },
      },
    });
    services.renderUnavailable = null;
    const full = await call('POST', `/api/sessions/${saved.id}/export`, host.headers);
    expect(full.status).toBe(202);
    expect(((await full.json()) as { variant: string }).variant).toBe('full');
    const lesson = await call(
      'POST',
      `/api/sessions/${saved.id}/export?interactions=0`,
      host.headers,
    );
    expect(lesson.status).toBe(202);
    expect(((await lesson.json()) as { variant: string }).variant).toBe('lesson');
    await services.exports.idle();
    expect(rendered.map((r) => r.variant)).toEqual(['full', 'lesson']);
    expect(rendered[0]?.path.endsWith('export.mp4')).toBe(true);
    expect(rendered[1]?.path.endsWith('export-lesson.mp4')).toBe(true);

    const status = (await (
      await call('GET', `/api/sessions/${saved.id}/export?interactions=0`, host.headers)
    ).json()) as { status: string; variant: string; downloadUrl: string };
    expect(status.status).toBe('ready');
    expect(status.variant).toBe('lesson');
    expect(status.downloadUrl).toMatch(/interactions=0&token=/);
    const url = new URL(status.downloadUrl);
    const file = await app.request(`${url.pathname}${url.search}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('mp4:lesson');

    const shelf = (await (await call('GET', '/api/me/downloads', host.headers)).json()) as {
      sessions: Array<{ id: string; export: { variant: string } }>;
    };
    expect(shelf.sessions.find((s) => s.id === saved.id)?.export.variant).toBe('lesson');
  });

  it('is the session_download flag, not the plan, that decides', async () => {
    await saveRules({
      session_download: { default: false, plans: { free: true }, platforms: {}, cells: {} },
    });
    const free = await participant('free');
    const saved = await seedSession(free.id, 'public');
    const res = await call('POST', `/api/sessions/${saved.id}/export`, free.headers);
    expect(res.status).not.toBe(402);
    const standard = await participant('standard');
    const theirs = await seedSession(standard.id, 'public');
    expect((await call('POST', `/api/sessions/${theirs.id}/export`, standard.headers)).status).toBe(
      402,
    );
    await saveRules({ session_download: null });
  });
});

describe('sign-in is a flag per platform', () => {
  it('refuses Google where the rule says so, and email sign-in the same way', async () => {
    const onMac = { [PLATFORM_HEADER]: 'desktop-mac', 'content-type': 'application/json' };
    const google = await app.request('/api/identity/google', {
      method: 'POST',
      headers: onMac,
      body: JSON.stringify({ idToken: 'tok:owner-0123456789abcdef' }),
    });
    expect(google.status).toBe(503);
    await saveRules({
      email_sign_in: { default: true, platforms: { android: false }, plans: {}, cells: {} },
    });
    const start = await app.request('/api/auth/register/start', {
      method: 'POST',
      headers: { [PLATFORM_HEADER]: 'android', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    expect(start.status).toBe(503);
    expect(((await start.json()) as { error: string }).error).toBe('EMAIL_SIGN_IN_DISABLED');
    await saveRules({ email_sign_in: null });
  });
});
