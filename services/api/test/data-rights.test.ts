import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCode } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * What a learner may do with their own data: hide a session, delete one, take
 * everything away as JSON, delete the account, and opt out of analytics
 * (ADR-0018). Each is asserted against the real store, on disk included —
 * "deleted" has to mean the bytes are gone, not just the row.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-data-rights-'));
let services: Services;
let app: Hono;
let identity: Identity;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(plan: PlanCode = 'free'): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous: true });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const sessionDir = (id: string) => join(dataDir, 'sessions', id);

/** An ended session with a recording on disk, as a real room leaves behind. */
async function seedSession(hostId: string, visibility: 'public' | 'private' = 'public') {
  const startedAt = Date.now() - 60_000;
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
    visibility,
    startedAt,
    endedAt: startedAt + 60_000,
    durationMs: 60_000,
    segments: 1,
    questions: 0,
    recap: [],
    views: 0,
    thumbnail: null,
    canonicalId: null,
    description: '',
    keywords: [],
  };
  await services.sessions.upsert(record);
  services.ledger.append(record.id, {
    kind: 'join',
    t: startedAt,
    participantId: hostId,
    name: 'Ada',
  });
  expect(existsSync(sessionDir(record.id))).toBe(true);
  return record;
}

const json = (body: unknown, caller: Caller, method: 'PATCH' | 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', ...caller.headers },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
  });
  services = await buildServices(cfg);
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PATCH /api/sessions/:id — going private', () => {
  it("is the host's call alone, and the catalogue stops listing it at once", async () => {
    const host = await participant();
    const stranger = await participant();
    const record = await seedSession(host.id, 'public');

    const listedBefore = (await (await app.request('/api/sessions')).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(listedBefore.sessions.some((s) => s.id === record.id)).toBe(true);

    const anonymous = await app.request(`/api/sessions/${record.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(anonymous.status).toBe(401);

    const notHost = await app.request(
      `/api/sessions/${record.id}`,
      json({ visibility: 'private' }, stranger, 'PATCH'),
    );
    expect(notHost.status).toBe(403);
    expect(((await notHost.json()) as { error: string }).error).toBe('NOT_HOST');

    const ok = await app.request(
      `/api/sessions/${record.id}`,
      json({ visibility: 'private' }, host, 'PATCH'),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { session: SessionRecord }).session.visibility).toBe('private');

    const listedAfter = (await (await app.request('/api/sessions')).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(listedAfter.sessions.some((s) => s.id === record.id)).toBe(false);

    // The thumbnail answers the host only; a stranger is turned away before the file is even looked for.
    expect((await app.request(`/api/sessions/${record.id}/thumb.svg`)).status).toBe(401);
    expect(
      (await app.request(`/api/sessions/${record.id}/thumb.svg`, { headers: stranger.headers }))
        .status,
    ).toBe(403);
  });

  it('400s a visibility the product does not have', async () => {
    const host = await participant();
    const record = await seedSession(host.id);
    const res = await app.request(
      `/api/sessions/${record.id}`,
      json({ visibility: 'secret' }, host, 'PATCH'),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/sessions/:id', () => {
  it('erases the row and everything the session left on disk, for the host only', async () => {
    const host = await participant();
    const stranger = await participant();
    const record = await seedSession(host.id);

    const notHost = await app.request(`/api/sessions/${record.id}`, {
      method: 'DELETE',
      headers: stranger.headers,
    });
    expect(notHost.status).toBe(403);
    expect(existsSync(sessionDir(record.id))).toBe(true);

    const res = await app.request(`/api/sessions/${record.id}`, {
      method: 'DELETE',
      headers: host.headers,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    expect((await app.request(`/api/sessions/${record.id}`)).status).toBe(404);
    expect(await services.sessions.get(record.id)).toBeNull();
    expect(existsSync(sessionDir(record.id))).toBe(false);
  });
});

describe('GET /api/me/export', () => {
  it('hands the caller their own row and sessions as a downloadable file', async () => {
    expect((await app.request('/api/me/export')).status).toBe(401);

    const me = await participant('standard');
    const someoneElse = await participant();
    const mine = await seedSession(me.id);
    const theirs = await seedSession(someoneElse.id);

    const res = await app.request('/api/me/export', { headers: me.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment;\s*filename=".*\.json"/);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as {
      participant: { id: string; plan: string };
      sessions: Array<{ id: string; hostId: string }>;
    };
    expect(body.participant.id).toBe(me.id);
    expect(body.participant.plan).toBe('standard');
    expect(body.sessions.map((s) => s.id)).toEqual([mine.id]);
    expect(body.sessions.every((s) => s.hostId === me.id)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(theirs.id);
  });
});

describe('DELETE /api/me', () => {
  it('takes the account and every session it hosts, on disk included', async () => {
    const me = await participant('professional');
    const first = await seedSession(me.id);
    const second = await seedSession(me.id, 'private');

    const res = await app.request('/api/me', { method: 'DELETE', headers: me.headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionsDeleted: 2 });

    expect(await services.participants.get(me.id)).toBeNull();
    for (const record of [first, second]) {
      expect(await services.sessions.get(record.id)).toBeNull();
      expect(existsSync(sessionDir(record.id))).toBe(false);
    }

    /**
     * The token is still validly signed for another month, so the row being
     * gone has to be what decides: every authenticated route now refuses it.
     * Otherwise a deleted account could keep starting sessions on the plan
     * baked into its bearer.
     */
    for (const path of ['/api/me', '/api/sessions/mine', '/api/me/usage', '/api/me/export'])
      expect((await app.request(path, { headers: me.headers })).status, path).toBe(401);
    const patch = await app.request('/api/me', json({ name: 'Ada Again' }, me, 'PATCH'));
    expect(patch.status).toBe(401);
    const started = await app.request(
      '/api/sessions',
      json({ topic: 'Anything at all' }, me, 'POST'),
    );
    expect(started.status).toBe(401);
  });
});

describe('PATCH /api/me — the analytics choice', () => {
  it('stops counting this participant on the server, not only in the UI', async () => {
    const me = await participant();
    expect(services.analytics.optedOutOf(me.id)).toBe(false);

    const res = await app.request('/api/me', json({ analyticsOptOut: true }, me, 'PATCH'));
    expect(res.status).toBe(200);
    expect(services.analytics.optedOutOf(me.id)).toBe(true);
    const row = await services.participants.get(me.id);
    expect(row?.analyticsOptOut).toBe(true);

    // The choice survives the next request, which re-reads the row.
    expect((await app.request('/api/me', { headers: me.headers })).status).toBe(200);
    expect(services.analytics.optedOutOf(me.id)).toBe(true);
  });

  it('400s a body that asks for nothing', async () => {
    const me = await participant();
    const res = await app.request('/api/me', json({}, me, 'PATCH'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID');
  });
});
