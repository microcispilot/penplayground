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
    // The call is the session's own spend (ADR-0011): an `llm` sample and cost lines under its purpose.
    const entries = services.ledger.read(sessionId);
    const metaSamples = entries.filter(
      (e) =>
        e.kind === 'metric' && e.sample.stage === 'llm' && e.sample.meta.purpose === 'session_meta',
    );
    expect(metaSamples).toHaveLength(1);
    const metaCosts = entries.filter(
      (e) =>
        e.kind === 'cost' && e.line.component === 'llm' && e.line.meta.purpose === 'session_meta',
    );
    expect(metaCosts.map((e) => (e.kind === 'cost' ? e.line.unit : ''))).toEqual([
      'tokens_in',
      'tokens_cached',
      'tokens_out',
    ]);
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
      canonicalId: null,
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

/**
 * Rasterising is native, and the synchronous resvg call blocked the event loop
 * for ~120 ms per session — long enough to stall the PCM fan-out of every room
 * still speaking. A 50-session load run showed it as ~160 ms stalls on a
 * trivial request; moving to `renderAsync` took that to single digits.
 *
 * This is the regression guard: while a thumbnail is being written, a 5 ms
 * interval must keep firing. Going back to the synchronous API makes it fail.
 */
describe('writing a thumbnail keeps the event loop turning', () => {
  it('lets timers run while the PNGs are rasterised', async () => {
    const meta = {
      description: 'Loop-liveness probe',
      keywords: ['attention'],
      category: 'computing-data' as const,
      thumbnail: {
        elements: [
          {
            kind: 'label' as const,
            text: 'Attention',
            x: 0,
            y: 0,
            w: 6,
            size: 'lg' as const,
            ink: 'accent' as const,
          },
          { kind: 'box' as const, x: 0, y: 2, w: 2, h: 1.25, text: 'the', ink: 'ink' as const },
          { kind: 'box' as const, x: 2.5, y: 2, w: 2, h: 1.25, text: 'cat', ink: 'ink' as const },
          {
            kind: 'arrow' as const,
            x1: 6,
            y1: 3.5,
            x2: 1,
            y2: 5.25,
            text: 'query',
            ink: 'ink' as const,
          },
          {
            kind: 'circle' as const,
            x: 0,
            y: 5.25,
            w: 2,
            h: 1.5,
            text: 'q·k / √d',
            ink: 'ink' as const,
          },
          {
            kind: 'bars' as const,
            x: 8,
            y: 1.5,
            w: 4,
            h: 4,
            values: [0.15, 0.9, 0.35, 0.2],
            ink: 'accent' as const,
          },
        ],
      },
    };

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 5);
    const startedAt = Date.now();
    try {
      await services.thumbnails.write('s_loop_probe01', meta, {
        usage: {
          model: 'fake',
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          usd: 0,
          totalMs: 0,
        },
        attempts: 1,
      });
    } finally {
      clearInterval(ticker);
    }
    const elapsed = Date.now() - startedAt;

    // However fast the machine, the loop must not have been held shut: with the
    // synchronous rasteriser the whole write is one uninterruptible block and
    // `ticks` comes back as 0–1.
    expect(elapsed).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThanOrEqual(Math.min(3, Math.floor(elapsed / 5)));
  }, 30_000);
});
