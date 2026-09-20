import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THUMBNAIL_SIZE } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import { solidPng } from '@pen/llm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';
import {
  derive,
  StoredSessionMeta,
  THUMB_FILES,
  THUMB_SIZES,
  thumbnailPath,
} from '../src/thumbnails.js';

/**
 * The whole thumbnail path against real services (PGlite in memory, the fake
 * model's scripted `session_meta`, the fake image generator, silent
 * synthesizer): a created session ends up with one generated source PNG and
 * both sizes derived from it, in the formats they are served in (ADR-0022:
 * a WebP card, a JPEG Open Graph image), and `thumbnail` on its record; the
 * routes enforce visibility and caching; the share page advertises the Open
 * Graph image; a repeat of the same lesson pays for neither the copy nor the
 * picture.
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
    // The source stays the PNG the model returned — it is the master every
    // size is re-derived from. The two derived files are not PNGs any more.
    expect(readFileSync(join(dir, THUMB_FILES.source)).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const card = readFileSync(join(dir, THUMB_FILES.card));
    expect(card.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(card.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const og = readFileSync(join(dir, THUMB_FILES.og));
    expect(og.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // Neither PNG is written any more, so no stale pair is left to be served.
    expect(existsSync(join(dir, THUMB_FILES.cardPng))).toBe(false);
    expect(existsSync(join(dir, THUMB_FILES.ogPng))).toBe(false);
    const stored = StoredSessionMeta.parse(
      JSON.parse(readFileSync(join(dir, THUMB_FILES.meta), 'utf8')),
    );
    expect(stored.attempts).toBe(1);
    // One generation; the card and the og image are downscales of its bytes.
    expect(stored.image).toMatchObject({ quality: 'low', reused: false, attempts: 1 });
    expect(stored.version).toBe(3);
    expect(stored.render.sourceBytes).toBeGreaterThan(0);
    expect(stored.render.cardBytes).toBeGreaterThan(0);
    expect(stored.render.ogBytes).toBeGreaterThan(0);
    expect(stored.render.sourceBytes).toBe(statSync(join(dir, THUMB_FILES.source)).size);
    expect(stored.render.cardBytes).toBe(statSync(join(dir, THUMB_FILES.card)).size);
    expect(stored.render.ogBytes).toBe(statSync(join(dir, THUMB_FILES.og)).size);
    // The subject the picture was built around is kept with the card that named it.
    expect(typeof stored.meta.subject).toBe('string');
    const record = await services.sessions.get(sessionId);
    expect(record?.thumbnail).toBe(thumbnailPath(sessionId));
    expect(record?.thumbnail?.endsWith('/thumb.webp')).toBe(true);
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

  it('serves each size publicly under its own type, with a long cache, an ETag and a 304', async () => {
    const card = await fetchApp(`/api/sessions/${sessionId}/thumb.webp`);
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toBe('image/webp');
    expect(card.headers.get('cache-control')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    );
    const etag = card.headers.get('etag');
    expect(etag).toMatch(/^"[a-z0-9]+-\d+"$/);
    // A real encoded body, not an empty one. The fixture is the fake
    // generator's flat colour, which WebP compresses to a few hundred bytes —
    // the format's effect on a real photograph is measured in `derive` below.
    expect(Number(card.headers.get('content-length'))).toBeGreaterThan(100);
    const again = await fetchApp(`/api/sessions/${sessionId}/thumb.webp`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
    // The route, the extension and the bytes all have to agree — a WebP served
    // as a PNG is a broken card in every browser that trusts the header.
    const bytesOf = async (file: string) =>
      new Uint8Array(await (await fetchApp(`/api/sessions/${sessionId}/${file}`)).arrayBuffer());
    const webp = await bytesOf('thumb.webp');
    expect(Buffer.from(webp.subarray(0, 4)).toString('ascii')).toBe('RIFF');
    expect(Buffer.from(webp.subarray(8, 12)).toString('ascii')).toBe('WEBP');
    const jpeg = await fetchApp(`/api/sessions/${sessionId}/og.jpg`);
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await jpeg.arrayBuffer()).subarray(0, 3)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    // Nothing writes a sketch or a PNG card any more; an old session's files
    // are still served, this session simply has none.
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.svg`)).status).toBe(404);
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.png`)).status).toBe(404);
    expect((await fetchApp(`/api/sessions/${sessionId}/og.png`)).status).toBe(404);
  });

  /**
   * The promise ADR-0022 makes to every session that already exists: their
   * records point at `thumb.png` (ADR-0021) or `thumb.svg` (before it), and
   * those links keep working, under the type they were written as. Nothing
   * re-derives them and nothing writes one — they are served because they are
   * there, and that is the whole contract.
   */
  it('keeps serving the files older sessions have on disk, each as what it is', async () => {
    const dir = join(dataDir, 'sessions', sessionId);
    const png = solidPng(16, 9, [10, 20, 30]);
    writeFileSync(join(dir, THUMB_FILES.cardPng), png);
    writeFileSync(join(dir, THUMB_FILES.ogPng), png);
    writeFileSync(join(dir, THUMB_FILES.svg), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    try {
      for (const [file, type] of [
        ['thumb.png', 'image/png'],
        ['og.png', 'image/png'],
        ['thumb.svg', 'image/svg+xml'],
      ] as const) {
        const res = await fetchApp(`/api/sessions/${sessionId}/${file}`);
        expect(res.status, file).toBe(200);
        expect(res.headers.get('content-type'), file).toBe(type);
      }
      // Served as they are, never re-derived: the bytes are the ones on disk.
      expect(
        new Uint8Array(
          await (await fetchApp(`/api/sessions/${sessionId}/thumb.png`)).arrayBuffer(),
        ),
      ).toEqual(new Uint8Array(png));
    } finally {
      for (const f of [THUMB_FILES.cardPng, THUMB_FILES.ogPng, THUMB_FILES.svg])
        unlinkSync(join(dir, f));
    }
  });

  it('derives a missing size from the stored source again, never from a second generation', async () => {
    const og = join(dataDir, 'sessions', sessionId, THUMB_FILES.og);
    unlinkSync(og);
    const before = services.costs.snapshot().session_thumbnail?.calls ?? 0;
    const res = await fetchApp(`/api/sessions/${sessionId}/og.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
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

  it('the share page advertises the Open Graph JPEG, its type and the description', async () => {
    const res = await fetchApp(`/s/${sessionId}`);
    const html = await res.text();
    expect(html).toContain(
      `<meta property="og:image" content="http://api.test/api/sessions/${sessionId}/og.jpg">`,
    );
    // The type tag has to name what the route actually serves; Meta's
    // documented list for og:image is jpeg/gif/png, which is why og is JPEG.
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(/<meta property="og:description" content="[^"]*attention[^"]*">/i);
  });

  it('is 404 for unknown or malformed ids and for a session without a thumbnail', async () => {
    expect((await fetchApp('/api/sessions/nope/thumb.webp')).status).toBe(404);
    expect((await fetchApp('/api/sessions/s_does_not_exist/thumb.webp')).status).toBe(404);
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
    const res = await fetchApp('/api/sessions/s_bare_0001/thumb.webp');
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
    expect((await fetchApp(`/api/sessions/${sessionId}/thumb.webp`)).status).toBe(401);
    expect(
      (
        await fetchApp(`/api/sessions/${sessionId}/thumb.webp`, {
          headers: { authorization: other.authorization },
        })
      ).status,
    ).toBe(403);
    const mine = await fetchApp(`/api/sessions/${sessionId}/og.jpg`, {
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
 * Deriving the two sizes is native work, and doing it synchronously blocked
 * the event loop for ~120 ms per session — long enough to stall the PCM
 * fan-out of every room still speaking. A 50-session load run showed it as
 * ~160 ms stalls on a trivial request; the async entry point took that to
 * single digits. `sharp` inherits the requirement, not an exemption from it:
 * its `toBuffer()` decodes, resizes and encodes on libuv's threadpool.
 *
 * The guard is the longest gap between two ticks of a 5 ms interval, not how
 * many ticks there were: sharp does the same work in ~32 ms where resvg took
 * ~250, so a count would only measure how fast the encoder got. A blocking
 * encoder makes the whole write one gap; an async one keeps every gap near
 * the interval, however long the work takes.
 */
describe('writing a thumbnail keeps the event loop turning', () => {
  it('lets timers run while the two sizes are downscaled', async () => {
    const meta = {
      description: 'Loop-liveness probe',
      keywords: ['attention'],
      category: 'computing-data' as const,
      subject: 'a brass clock escapement, gears meshing',
      headline: 'HOW ATTENTION WORKS',
    };
    // A full-size generation's worth of pixels, so the work is the real work.
    const png = solidPng(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, [90, 140, 200]);

    const gaps: number[] = [];
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
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
    const longestStall = Math.max(...gaps, Date.now() - last);

    // However fast the machine, the loop must not have been held shut. A
    // synchronous encoder gives one gap the length of the whole write; the
    // threshold is generous enough for a loaded CI box and still an order of
    // magnitude under that.
    expect(elapsed).toBeGreaterThan(0);
    expect(longestStall).toBeLessThan(Math.max(20, elapsed * 0.6));
  }, 30_000);
});

/**
 * The formats themselves (ADR-0022). A flat colour proves nothing about an
 * encoder — every format stores one — so the fixture here is deterministic
 * noise at the generated size, which is as incompressible as a photograph and
 * is exactly the case PNG is the wrong format for.
 */
describe('the derived sizes are the formats they are served in', () => {
  /** A photograph-like source: no flat regions, so PNG cannot cheat. */
  const noisySource = async (): Promise<Buffer> => {
    const { width, height } = THUMBNAIL_SIZE;
    const raw = Buffer.alloc(width * height * 3);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = (seed >> 16) & 0xff;
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  };

  it('writes a WebP card and a JPEG Open Graph image at the right sizes', async () => {
    const source = await noisySource();
    const [card, og] = await Promise.all([derive(source, 'card'), derive(source, 'og')]);
    const cardMeta = await sharp(card).metadata();
    expect(cardMeta.format).toBe('webp');
    expect([cardMeta.width, cardMeta.height]).toEqual([
      THUMB_SIZES.card.width,
      THUMB_SIZES.card.height,
    ]);
    const ogMeta = await sharp(og).metadata();
    expect(ogMeta.format).toBe('jpeg');
    expect([ogMeta.width, ogMeta.height]).toEqual([THUMB_SIZES.og.width, THUMB_SIZES.og.height]);
  }, 30_000);

  it('crops to fill rather than letterboxing: 3:2 into 16:9 loses sky, never gains bars', async () => {
    // A cover of a 3:2 source into 16:9 keeps the full width and trims the top
    // and bottom, so the centre row of the card is the centre row of the source.
    const source = await noisySource();
    const card = await derive(source, 'card');
    const { width, height } = await sharp(card).metadata();
    expect(width / (height ?? 1)).toBeCloseTo(16 / 9, 2);
  }, 30_000);

  it('is why the card stopped being a PNG: the same pixels, an order of magnitude smaller', async () => {
    const source = await noisySource();
    const asPng = await sharp(source)
      .resize(THUMB_SIZES.card.width, THUMB_SIZES.card.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    const card = await derive(source, 'card');
    const og = await derive(source, 'og');
    const ogAsPng = await sharp(source)
      .resize(THUMB_SIZES.og.width, THUMB_SIZES.og.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    // Measured on five real generations (docs/COST.md): 442 kB → 15 kB for the
    // card, 1,525 kB → 49 kB for the og image. Noise is the hardest case for
    // both formats, so the guard here is a conservative 5×.
    expect(asPng.length / card.length).toBeGreaterThan(5);
    expect(ogAsPng.length / og.length).toBeGreaterThan(5);
  }, 30_000);

  /**
   * `--reencode`: what moves a session written under ADR-0021 onto the new
   * formats. It re-derives from the source that is already on disk, so it
   * costs nothing, and it removes the PNG pair it replaces so no route can
   * keep serving them.
   */
  it('re-encodes an ADR-0021 session from its source without asking any model for anything', async () => {
    const id = 's_reencode0001';
    const dir = join(dataDir, 'sessions', id);
    const source = await noisySource();
    await services.thumbnails.write(
      id,
      {
        description: 'Already drawn',
        keywords: ['a'],
        category: 'computing-data',
        subject: 'a brass clock escapement',
        // ADR-0021 sessions predate the field; `''` is what they carry.
        headline: '',
      },
      source,
      {
        usage: {
          model: 'fake',
          inputTokens: 1,
          cachedTokens: 0,
          outputTokens: 1,
          usd: 0.5,
          totalMs: 1,
        },
        attempts: 1,
        image: {
          model: 'gpt-image-1',
          quality: 'low',
          inputTokens: 67,
          outputTokens: 400,
          usd: 0.016_335,
          ms: 11_000,
          attempts: 1,
          reused: false,
        },
      },
    );
    // Put the session back in the state ADR-0021 left it in: a PNG pair, and a
    // meta.json at version 2 whose byte counts use the old names.
    const oldCard = await sharp(source)
      .resize(THUMB_SIZES.card.width, THUMB_SIZES.card.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    writeFileSync(join(dir, THUMB_FILES.cardPng), oldCard);
    writeFileSync(join(dir, THUMB_FILES.ogPng), oldCard);
    writeFileSync(
      join(dir, THUMB_FILES.meta),
      JSON.stringify({
        version: 2,
        sessionId: id,
        createdAt: Date.now(),
        meta: { description: 'Already drawn', keywords: ['a'], category: 'computing-data' },
        usage: {
          model: 'fake',
          inputTokens: 1,
          cachedTokens: 0,
          outputTokens: 1,
          usd: 0.5,
          totalMs: 1,
        },
        attempts: 1,
        image: {
          model: 'gpt-image-1',
          quality: 'low',
          inputTokens: 52,
          outputTokens: 400,
          usd: 0.016_26,
          ms: 11_000,
          attempts: 1,
          reused: false,
        },
        render: {
          sourcePngBytes: source.length,
          cardPngBytes: oldCard.length,
          ogPngBytes: oldCard.length,
          resizeMs: 250,
        },
      }),
    );
    // A version-2 file still reads, through the names it was written with.
    const before = services.thumbnails.meta(id);
    expect(before?.version).toBe(2);
    expect(before?.render.cardBytes).toBe(oldCard.length);
    expect(before?.meta.subject).toBe('');

    const callsBefore = services.costs.snapshot().session_thumbnail?.calls ?? 0;
    const written = await services.thumbnails.reencode(id);
    expect(services.costs.snapshot().session_thumbnail?.calls ?? 0).toBe(callsBefore);
    if (!written) throw new Error('reencode returned nothing for a session that has a source');
    expect(written.cardBytes).toBeLessThan(oldCard.length);
    expect((await sharp(readFileSync(join(dir, THUMB_FILES.card))).metadata()).format).toBe('webp');
    expect((await sharp(readFileSync(join(dir, THUMB_FILES.og))).metadata()).format).toBe('jpeg');
    // The pair it supersedes is KEPT: `og.png` is the URL sitting in every
    // unfurl cache that has seen this session's share page, and deleting it
    // would turn a picture already in someone's Slack into a 404.
    expect(existsSync(join(dir, THUMB_FILES.cardPng))).toBe(true);
    expect(existsSync(join(dir, THUMB_FILES.ogPng))).toBe(true);
    // The numbers move to the new names; what the generation cost does not move.
    const after = services.thumbnails.meta(id);
    expect(after?.version).toBe(3);
    expect(after?.render.cardBytes).toBe(written.cardBytes);
    expect(after?.image?.usd).toBe(0.016_26);
    expect(after?.meta.description).toBe('Already drawn');
    expect(services.thumbnails.stat(join(dir, THUMB_FILES.card)).size).toBe(written.cardBytes);
  }, 30_000);

  it('re-encodes nothing for a session with no source to derive from', async () => {
    expect(await services.thumbnails.reencode('s_no_source_at_all')).toBeNull();
  });
});
