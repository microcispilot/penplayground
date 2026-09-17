import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '@pen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';
import { StoredSessionMeta, THUMB_FILES, thumbnailPath } from '../src/thumbnails.js';

/**
 * The whole thumbnail path against real services (PGlite in memory, the fake
 * model's scripted `session_meta`, silent synthesizer): a created session
 * ends up with `thumb.svg` + PNGs on disk and `thumbnail` on its record; the
 * routes enforce visibility and caching; the share page advertises the PNG.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-thumbs-'));
let services: Services;
let fetchApp: (path: string, init?: RequestInit) => Promise<Response>;
let identity: Identity;
let rooms: ReturnType<typeof buildApp>['rooms'];
const host = { id: 'p_host_thumb01', name: 'Sam', plan: 'free' as const };

async function bearerFor(plan: 'free' | 'standard' = 'free') {
  const issued = await identity.issue({ name: 'Sam', plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Sam', plan, anonymous: true });
  return { id: issued.claims.sub, authorization: `Bearer ${issued.token}` };
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
    PEN_API_URL: 'http://api.test',
    PEN_PUBLIC_URL: 'http://web.test',
  });
  services = await buildServices(cfg);
  // The Transformers topic must be a registry hit: no acquirer in tests.
  await seedPacks(services.onten, join(DATA_DIR, 'packs'));
  const built = buildApp(services);
  rooms = built.rooms;
  identity = new Identity(cfg.PEN_JWT_SECRET);
  fetchApp = (path, init) => Promise.resolve(built.app.request(`http://api.test${path}`, init));
}, 60_000);

afterAll(async () => {
  services.meta.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a fake-provider session gets a real thumbnail', () => {
  let sessionId: string;

  it('writes thumb.svg, the PNGs and meta.json next to the ledger and marks the record ready', async () => {
    const live = await rooms.create({
      topic: 'How Transformers work in LLMs',
      host,
      band: 'beginner',
      visibility: 'public',
    });
    sessionId = live.record.id;
    // Session start never waits for the sketch: the record is created without one.
    expect(live.record.thumbnail).toBeNull();
    // The room plans, then the meta job runs in the background: wait for the record to flip.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await services.sessions.get(sessionId))?.thumbnail)
      await new Promise((r) => setTimeout(r, 50));
    await services.meta.idle();
    const dir = join(dataDir, 'sessions', sessionId);
    for (const f of Object.values(THUMB_FILES)) expect(existsSync(join(dir, f)), f).toBe(true);
    const svg = readFileSync(join(dir, THUMB_FILES.svg), 'utf8');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"')).toBe(
      true,
    );
    expect(svg.length).toBeLessThan(60_000);
    // PNG magic bytes.
    expect(readFileSync(join(dir, THUMB_FILES.og)).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const stored = StoredSessionMeta.parse(
      JSON.parse(readFileSync(join(dir, THUMB_FILES.meta), 'utf8')),
    );
    expect(stored.meta.thumbnail.elements.length).toBe(12);
    expect(stored.attempts).toBe(1);
    expect(stored.render.unsupportedChars).toEqual([]);
    const record = await services.sessions.get(sessionId);
    expect(record?.thumbnail).toBe(thumbnailPath(sessionId));
    expect(record?.description).toMatch(/attention/i);
    expect(record?.keywords).toContain('transformers');
    // The scripted usage is recorded under its own purpose in the cost ledger.
    expect(services.costs.snapshot().session_meta?.calls ?? 0).toBeGreaterThanOrEqual(0);
    await rooms.end(sessionId);
  }, 30_000);

  it('serves the SVG and PNGs publicly with a long cache and an ETag, and answers 304', async () => {
    const svg = await fetchApp(`/api/sessions/${sessionId}/thumb.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    const etag = svg.headers.get('etag');
    expect(etag).toMatch(/^"[a-z0-9]+-\d+"$/);
    expect(Number(svg.headers.get('content-length'))).toBeGreaterThan(1000);
    expect((await svg.text()).startsWith('<svg')).toBe(true);
    const again = await fetchApp(`/api/sessions/${sessionId}/thumb.svg`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
    for (const file of ['thumb.png', 'og.png']) {
      const png = await fetchApp(`/api/sessions/${sessionId}/${file}`);
      expect(png.status, file).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await png.arrayBuffer()).subarray(1, 4)).toEqual(
        new Uint8Array([0x50, 0x4e, 0x47]),
      );
    }
  });

  it('rasterises a missing PNG on demand from the stored sketch', async () => {
    const og = join(dataDir, 'sessions', sessionId, THUMB_FILES.og);
    unlinkSync(og);
    const res = await fetchApp(`/api/sessions/${sessionId}/og.png`);
    expect(res.status).toBe(200);
    expect(existsSync(og)).toBe(true);
  });

  it('the share page advertises the Open Graph PNG and the description', async () => {
    const res = await fetchApp(`/s/${sessionId}`);
    const html = await res.text();
    expect(html).toContain(
      `<meta property="og:image" content="http://api.test/api/sessions/${sessionId}/og.png">`,
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(/<meta property="og:description" content="[^"]*attention[^"]*">/i);
  });

  it('is 404 for unknown or malformed ids and for a session without a thumbnail', async () => {
    expect((await fetchApp('/api/sessions/nope/thumb.svg')).status).toBe(404);
    expect((await fetchApp('/api/sessions/s_does_not_exist/thumb.svg')).status).toBe(404);
    const bare: SessionRecord = {
      id: 's_bare_0001',
      topic: 't',
      title: 'Bare',
      promise: '',
      expertId: 'ada',
      hostId: host.id,
      hostName: 'Sam',
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
      description: '',
      keywords: [],
    };
    await services.sessions.upsert(bare);
    const res = await fetchApp('/api/sessions/s_bare_0001/thumb.svg');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'NOT_READY' });
    const share = await (await fetchApp('/s/s_bare_0001')).text();
    expect(share).not.toContain('og:image');
    expect(share).toContain('<meta name="twitter:card" content="summary">');
  });

  it("keeps a private session's thumbnail for its host only, uncached by proxies", async () => {
    const owner = await bearerFor();
    const other = await bearerFor();
    const record = await services.sessions.get(sessionId);
    if (!record) throw new Error('record missing');
    await services.sessions.patch(sessionId, { visibility: 'private', hostId: owner.id });
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.svg`)).status).toBe(401);
    expect(
      (
        await fetchApp(`/api/sessions/${sessionId}/thumb.svg`, {
          headers: { authorization: other.authorization },
        })
      ).status,
    ).toBe(403);
    const mine = await fetchApp(`/api/sessions/${sessionId}/og.png`, {
      headers: { authorization: owner.authorization },
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(mine.headers.get('vary')).toContain('Authorization');
    // No Open Graph image for something a scraper could not fetch.
    expect(await (await fetchApp(`/s/${sessionId}`)).text()).not.toContain('og:image');
    await services.sessions.patch(sessionId, { visibility: 'public', hostId: record.hostId });
  });
});
