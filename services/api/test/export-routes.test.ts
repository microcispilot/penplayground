import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '@pen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ExportJobs, type Renderer } from '../src/export/index.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The export routes against a real `Services` (PGlite in memory, fake model,
 * silent synthesizer) with the Playwright renderer swapped for a fake that
 * writes a small file. Covers every status the client must handle plus the
 * one-time download token the status endpoint hands out.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-export-routes-'));
let services: Services;
let fetchApp: (path: string, init?: RequestInit) => Promise<Response>;
let identity: Identity;
const MP4 = Buffer.from('not really an mp4 but 32 bytes long!!');

async function participant(plan: 'free' | 'standard' | 'professional') {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous: true });
  return { id: issued.claims.sub, auth: { authorization: `Bearer ${issued.token}` } };
}

async function session(
  hostId: string,
  ended: boolean,
  id = `s_${Math.random().toString(36).slice(2, 10)}`,
) {
  const record: SessionRecord = {
    id,
    topic: 'How Transformers work in LLMs',
    title: 'How Transformers Work in LLMs',
    promise: '',
    expertId: 'ada',
    hostId,
    hostName: 'Ada',
    band: 'beginner',
    domain: 'ml',
    visibility: 'public',
    startedAt: Date.now() - 60_000,
    endedAt: ended ? Date.now() : null,
    durationMs: 60_000,
    segments: 1,
    questions: 0,
    recap: [],
    views: 0,
    thumbnail: null,
    canonicalId: null,
    description: '',
    keywords: [],
    likes: 0,
  };
  await services.sessions.upsert(record);
  services.ledger.append(id, {
    kind: 'join',
    t: record.startedAt,
    participantId: hostId,
    name: 'Ada',
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
    PEN_API_URL: 'http://api.test',
  });
  services = await buildServices(cfg);
  const renderer: Renderer = {
    async render({ outputPath, onProgress }) {
      onProgress(0.4);
      await new Promise((r) => setTimeout(r, 30));
      writeFileSync(outputPath, MP4);
      return {
        durationMs: 9_000,
        syncDriftMs: 12,
        sayStartsMs: [0, 4_000],
        tapeStartsMs: [0, 4_005],
      };
    },
  };
  services.exports = new ExportJobs({ sessionsDir: join(dataDir, 'sessions'), renderer });
  services.renderUnavailable = null;
  identity = new Identity(cfg.PEN_JWT_SECRET);
  const { app } = buildApp(services);
  fetchApp = (path, init) => Promise.resolve(app.request(path, init));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/sessions/:id/export', () => {
  it('401 without a bearer', async () => {
    const res = await fetchApp('/api/sessions/nope/export', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('404 for an unknown session', async () => {
    const host = await participant('standard');
    const res = await fetchApp('/api/sessions/nope/export', { method: 'POST', headers: host.auth });
    expect(res.status).toBe(404);
  });

  it('402 for a free host, naming the Standard plan', async () => {
    const host = await participant('free');
    const s = await session(host.id, true);
    const res = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('ENTITLEMENT_REQUIRED');
    expect(body.message).toMatch(/Standard/);
  });

  it('403 for a paid user who is not the host', async () => {
    const host = await participant('standard');
    const other = await participant('professional');
    const s = await session(host.id, true);
    const res = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: other.auth,
    });
    expect(res.status).toBe(403);
  });

  it('409 while the session is live', async () => {
    const host = await participant('standard');
    const s = await session(host.id, false);
    const res = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('SESSION_LIVE');
  });

  it('503 when the server has no renderer', async () => {
    const host = await participant('standard');
    const s = await session(host.id, true);
    services.renderUnavailable = 'ffmpeg: missing';
    try {
      const res = await fetchApp(`/api/sessions/${s.id}/export`, {
        method: 'POST',
        headers: host.auth,
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('RENDER_UNAVAILABLE');
    } finally {
      services.renderUnavailable = null;
    }
  });

  it('202 queues the render, status reports progress then ready with a download token, and the file streams', async () => {
    const host = await participant('standard');
    const s = await session(host.id, true);
    const post = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(post.status).toBe(202);
    const queued = await post.json();
    expect(queued.status).toBe('queued');
    expect(queued.progress).toBe(0);
    expect(queued.downloadUrl).toBeNull();

    // A second POST while queued/rendering is a no-op returning the same job.
    const again = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(again.status).toBe(202);

    await services.exports.idle();
    const status = await fetchApp(`/api/sessions/${s.id}/export`, { headers: host.auth });
    expect(status.status).toBe(200);
    const ready = await status.json();
    expect(ready.status).toBe('ready');
    expect(ready.progress).toBe(1);
    expect(ready.bytes).toBe(MP4.length);
    expect(ready.durationMs).toBe(9_000);
    expect(ready.error).toBeNull();
    expect(ready.downloadUrl).toMatch(
      new RegExp(`^http://api\\.test/api/sessions/${s.id}/export\\.mp4\\?token=`),
    );
    // Never the server's file system path.
    expect(JSON.stringify(ready)).not.toContain(dataDir);

    // The POST after ready is a 200 with the same view.
    const post2 = await fetchApp(`/api/sessions/${s.id}/export`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(post2.status).toBe(200);

    // <a download> follows the tokenised URL with no header.
    const url = new URL(ready.downloadUrl);
    const file = await fetchApp(`${url.pathname}${url.search}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="pen-how-transformers-work-in-llms.mp4"',
    );
    expect(file.headers.get('content-length')).toBe(String(MP4.length));
    expect(Buffer.from(await file.arrayBuffer()).equals(MP4)).toBe(true);

    // Range requests resume a download.
    const part = await fetchApp(`${url.pathname}${url.search}`, {
      headers: { range: 'bytes=4-7' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-7/${MP4.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe(MP4.subarray(4, 8).toString());

    // The bearer works too; a free bearer, a bad token, or a token for another session do not.
    expect((await fetchApp(url.pathname, { headers: host.auth })).status).toBe(200);
    const free = await participant('free');
    expect((await fetchApp(url.pathname, { headers: free.auth })).status).toBe(401);
    expect((await fetchApp(`${url.pathname}?token=garbage`)).status).toBe(401);
    const otherSession = await session(host.id, true);
    const otherToken = await services.downloadTokens.issue(host.id, otherSession.id);
    expect((await fetchApp(`${url.pathname}?token=${otherToken}`)).status).toBe(401);
    // A token minted for a participant who is not the host of that session is refused.
    const stranger = await participant('standard');
    const strangerToken = await services.downloadTokens.issue(stranger.id, s.id);
    expect((await fetchApp(`${url.pathname}?token=${strangerToken}`)).status).toBe(403);
  });

  it('GET status for a session that was never exported is "none"', async () => {
    const host = await participant('professional');
    const s = await session(host.id, true);
    const res = await fetchApp(`/api/sessions/${s.id}/export`, { headers: host.auth });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('none');
    expect(
      (await fetchApp(`/api/sessions/${s.id}/export.mp4`, { headers: host.auth })).status,
    ).toBe(404);
  });
});
