import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THUMBNAIL_SIZE } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import { solidPng } from '@pen/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';
import { StoredSessionMeta, THUMB_FILES, thumbnailPath } from '../src/thumbnails.js';

/**
 * The whole thumbnail path against real services (PGlite in memory, the fake
 * model's scripted `session_meta`, the fake image generator, silent
 * synthesizer): a created session ends up with one generated source PNG and
 * both sizes derived from it, and `thumbnail` on its record; the routes
 * enforce visibility and caching; the share page advertises the Open Graph
 * PNG; a repeat of the same lesson pays for neither the copy nor the picture.
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

  it('generates once, derives every size from it, and marks the record ready', async () => {
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
    // The source and both derived sizes, plus meta.json. No sketch: nothing draws one now.
    for (const f of [THUMB_FILES.source, THUMB_FILES.card, THUMB_FILES.og, THUMB_FILES.meta])
      expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, THUMB_FILES.svg))).toBe(false);
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const f of [THUMB_FILES.source, THUMB_FILES.card, THUMB_FILES.og])
      expect(readFileSync(join(dir, f)).subarray(0, 4), f).toEqual(PNG);
    const stored = StoredSessionMeta.parse(
      JSON.parse(readFileSync(join(dir, THUMB_FILES.meta), 'utf8')),
    );
    expect(stored.attempts).toBe(1);
    // One generation; the card and the og image are downscales of its bytes.
    expect(stored.image).toMatchObject({ quality: 'low', reused: false, attempts: 1 });
    expect(stored.render.sourcePngBytes).toBeGreaterThan(0);
    expect(stored.render.cardPngBytes).toBeGreaterThan(0);
    expect(stored.render.ogPngBytes).toBeGreaterThan(0);
    expect(stored.render.sourcePngBytes).toBe(statSync(join(dir, THUMB_FILES.source)).size);
    expect(stored.render.cardPngBytes).toBe(statSync(join(dir, THUMB_FILES.card)).size);
    const record = await services.sessions.get(sessionId);
    expect(record?.thumbnail).toBe(thumbnailPath(sessionId));
    expect(record?.thumbnail?.endsWith('/thumb.png')).toBe(true);
    expect(record?.description).toMatch(/attention/i);
    expect(record?.keywords).toContain('transformers');
    // The call is the session's own spend (ADR-0011): an `llm` sample and cost lines under its purpose.
    const entries = services.ledger.read(sessionId);
    const metaSamples = entries.filter(
      (e) =>
        e.kind === 'metric' && e.sample.stage === 'llm' && e.sample.meta.purpose === 'session_meta',
    );
    expect(metaSamples).toHaveLength(1);
    // And it never competes with the first sentence for the provider (ADR-0013):
    // the card is queued only once the learner can hear the expert, so its call
    // starts no earlier than the session's first synthesis.
    const firstAudio = entries.find((e) => e.kind === 'audio');
    const metaSample = metaSamples[0];
    expect(firstAudio?.kind).toBe('audio');
    if (firstAudio && metaSample) expect(metaSample.t).toBeGreaterThanOrEqual(firstAudio.t);
    const metaCosts = entries.filter(
      (e) =>
        e.kind === 'cost' && e.line.component === 'llm' && e.line.meta.purpose === 'session_meta',
    );
    expect(metaCosts.map((e) => (e.kind === 'cost' ? e.line.unit : ''))).toEqual([
      'tokens_in',
      'tokens_cached',
      'tokens_out',
    ]);
    // The picture is a provider call like any other: one `image` stage sample
    // and its own cost lines in the session's ledger, so Insights and PostHog
    // both see it (ADR-0021).
    const imageSamples = entries.filter((e) => e.kind === 'metric' && e.sample.stage === 'image');
    expect(imageSamples).toHaveLength(1);
    expect(imageSamples[0]?.kind === 'metric' && imageSamples[0].sample.meta).toMatchObject({
      purpose: 'session_thumbnail',
      quality: 'low',
      size: '1536x1024',
      reused: false,
    });
    const imageCosts = entries.filter((e) => e.kind === 'cost' && e.line.component === 'image');
    expect(imageCosts.map((e) => (e.kind === 'cost' ? e.line.unit : ''))).toEqual([
      'tokens_in',
      'tokens_out',
    ]);
    for (const e of imageCosts)
      if (e.kind === 'cost') expect(e.line.meta.purpose).toBe('session_thumbnail');
    await rooms.end(sessionId);
  }, 30_000);

  it('serves the PNGs publicly with a long cache and an ETag, and answers 304', async () => {
    const card = await fetchApp(`/api/sessions/${sessionId}/thumb.png`);
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toBe('image/png');
    expect(card.headers.get('cache-control')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    const etag = card.headers.get('etag');
    expect(etag).toMatch(/^"[a-z0-9]+-\d+"$/);
    expect(Number(card.headers.get('content-length'))).toBeGreaterThan(1000);
    const again = await fetchApp(`/api/sessions/${sessionId}/thumb.png`, {
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
    // Nothing writes a sketch any more; an old session's file would still be served.
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.svg`)).status).toBe(404);
  });

  it('derives a missing size from the stored source again, never from a second generation', async () => {
    const og = join(dataDir, 'sessions', sessionId, THUMB_FILES.og);
    unlinkSync(og);
    const before = services.costs.snapshot().session_thumbnail?.calls ?? 0;
    const res = await fetchApp(`/api/sessions/${sessionId}/og.png`);
    expect(res.status).toBe(200);
    expect(existsSync(og)).toBe(true);
    expect(services.costs.snapshot().session_thumbnail?.calls ?? 0).toBe(before);
  });

  it('gives the next session on the same lesson the same card and the same picture for nothing', async () => {
    const before = services.costs.snapshot().session_meta?.calls ?? 0;
    const beforePictures = services.costs.snapshot().session_thumbnail?.calls ?? 0;
    const second = await rooms.create({
      topic: 'How Transformers work in LLMs',
      host,
      band: 'beginner',
      visibility: 'public',
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await services.sessions.get(second.record.id))?.thumbnail)
      await new Promise((r) => setTimeout(r, 50));
    await services.meta.idle();
    // Zero calls of either kind: the copy and the picture both came off the
    // caches next to the lesson memo. This is the "never pay twice" assertion.
    expect(services.costs.snapshot().session_meta?.calls ?? 0).toBe(before);
    expect(services.costs.snapshot().session_thumbnail?.calls ?? 0).toBe(beforePictures);
    const stored = services.thumbnails.meta(second.record.id);
    expect(stored?.reused).toBe(true);
    expect(stored?.image?.reused).toBe(true);
    expect(stored?.savedUsd).toBeGreaterThanOrEqual(0);
    expect(stored?.meta.description).toBe(services.thumbnails.meta(sessionId)?.meta.description);
    const record = await services.sessions.get(second.record.id);
    expect(record?.thumbnail).toBe(thumbnailPath(second.record.id));
    expect(record?.description).toMatch(/attention/i);
    // Its own files on disk, from the first session's bytes — and its ledger says it was reused.
    expect(existsSync(join(dataDir, 'sessions', second.record.id, THUMB_FILES.source))).toBe(true);
    expect(readFileSync(join(dataDir, 'sessions', second.record.id, THUMB_FILES.source))).toEqual(
      readFileSync(join(dataDir, 'sessions', sessionId, THUMB_FILES.source)),
    );
    const imageSample = services.ledger
      .read(second.record.id)
      .find((e) => e.kind === 'metric' && e.sample.stage === 'image');
    expect(imageSample?.kind === 'metric' && imageSample.sample.meta.reused).toBe(true);
    expect(
      imageSample?.kind === 'metric' && (imageSample.sample.meta.savedUsd as number) >= 0,
    ).toBe(true);
    const sample = services.ledger
      .read(second.record.id)
      .find(
        (e) =>
          e.kind === 'metric' &&
          e.sample.stage === 'llm' &&
          e.sample.meta.purpose === 'session_meta',
      );
    expect(sample?.kind === 'metric' && sample.sample.meta.reused).toBe(true);
    expect(sample?.kind === 'metric' && (sample.sample.meta.savedUsd as number) >= 0).toBe(true);
    await rooms.end(second.record.id);
  }, 30_000);

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
    expect((await fetchApp('/api/sessions/nope/thumb.png')).status).toBe(404);
    expect((await fetchApp('/api/sessions/s_does_not_exist/thumb.png')).status).toBe(404);
    const bare: SessionRecord = {
      id: 's_bare_0001',
      topic: 't',
      language: 'en-US',
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
      likes: 0,
    };
    await services.sessions.upsert(bare);
    const res = await fetchApp('/api/sessions/s_bare_0001/thumb.png');
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
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.png`)).status).toBe(401);
    expect(
      (
        await fetchApp(`/api/sessions/${sessionId}/thumb.png`, {
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
 * Downscaling is native, and the synchronous resvg call blocked the event loop
 * for ~120 ms per session — long enough to stall the PCM fan-out of every room
 * still speaking. A 50-session load run showed it as ~160 ms stalls on a
 * trivial request; moving to `renderAsync` took that to single digits. A real
 * 1536 × 1024 photograph is a heavier source than the old sketch, so the guard
 * matters more now, not less.
 *
 * This is the regression guard: while a thumbnail is being written, a 5 ms
 * interval must keep firing. Going back to the synchronous API makes it fail.
 */
describe('writing a thumbnail keeps the event loop turning', () => {
  it('lets timers run while the two sizes are downscaled', async () => {
    const meta = {
      description: 'Loop-liveness probe',
      keywords: ['attention'],
      category: 'computing-data' as const,
    };
    // A full-size generation's worth of pixels, so the work is the real work.
    const png = solidPng(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, [90, 140, 200]);

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 5);
    const startedAt = Date.now();
    try {
      await services.thumbnails.write('s_loop_probe01', meta, png, {
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
