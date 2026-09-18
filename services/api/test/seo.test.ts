import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '@pen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  learningResourceJsonLd,
  PRIVATE_PAGES,
  robotsTxt,
  STATIC_PAGES,
  sitemapXml,
} from '../src/seo.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * What crawlers and scrapers get: `robots.txt`, a sitemap of the public
 * catalogue, and `schema.org/LearningResource` on a share page.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-seo-'));
let services: Services;
let fetchApp: (path: string, init?: RequestInit) => Promise<Response>;

const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  promise: 'Read an attention diagram and explain why every piece is there.',
  expertId: 'nova-ai-expert',
  hostId: 'p_host_seo0001',
  hostName: 'Sam',
  band: 'beginner',
  domain: 'computing-data',
  visibility: 'public',
  startedAt: Date.parse('2026-09-10T10:00:00Z'),
  endedAt: Date.parse('2026-09-10T10:14:00Z'),
  durationMs: 840_000,
  segments: 3,
  questions: 1,
  recap: [],
  views: 12,
  thumbnail: `/api/sessions/${id}/thumb.svg`,
  canonicalId: 'en.how-transformers-work-in-llms',
  language: 'en-US',
  description: 'See how attention weighs each earlier token to predict the next one.',
  keywords: ['transformers', 'attention'],
  likes: 0,
  ...extra,
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
    PEN_API_URL: 'http://api.test',
    PEN_PUBLIC_URL: 'https://penplayground.test',
  });
  services = await buildServices(cfg);
  const built = buildApp(services);
  fetchApp = (path, init) => Promise.resolve(built.app.request(`http://api.test${path}`, init));
  await services.sessions.upsert(record('s_seo_public1'));
  await services.sessions.upsert(
    record('s_seo_private', { visibility: 'private', thumbnail: null }),
  );
  await services.sessions.upsert(record('s_seo_live001', { endedAt: null }));
  await services.sessions.upsert(
    record('s_seo_farsi01', {
      language: 'fa-IR',
      title: 'ترنسفورمرها چطور کار می‌کنند',
      description: 'یک جمله را دنبال کنید و ببینید توجه چطور کلمهٔ بعدی را انتخاب می‌کند.',
    }),
  );
}, 120_000);

afterAll(async () => {
  services.meta.close();
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('robots.txt', () => {
  it('welcomes crawlers, keeps them out of live rooms, and points at the sitemap', async () => {
    const res = await fetchApp('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain('Disallow: /room/');
    expect(body).toContain('Disallow: /replay/');
    // The learner's own shelves (ADR-0015). `Disallow: /room/` does not cover
    // `/rooms` — the prefixes only look alike, so each one is listed.
    for (const path of PRIVATE_PAGES) expect(body, path).toContain(`Disallow: ${path}`);
    expect(PRIVATE_PAGES).toContain('/rooms');
    // And nothing private leaked into the sitemap.
    for (const page of STATIC_PAGES) expect(PRIVATE_PAGES).not.toContain(page.path);
    expect(body).toContain('Sitemap: https://penplayground.test/sitemap.xml');
  });

  it('never doubles the slash when the public URL has a trailing one', () => {
    expect(robotsTxt('https://example.test/')).toContain(
      'Sitemap: https://example.test/sitemap.xml',
    );
  });
});

describe('sitemap.xml', () => {
  it('lists the static pages and every ended public session, and is cached for an hour', async () => {
    const res = await fetchApp('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const page of STATIC_PAGES)
      expect(xml, page.path).toContain(`<loc>https://penplayground.test${page.path}</loc>`);
    expect(xml).toContain('<loc>https://penplayground.test/sessions/s_seo_public1</loc>');
    expect(xml).toContain('<lastmod>2026-09-10</lastmod>');
    // A private session is nobody's to crawl, and a session still being taught is not a page yet.
    expect(xml).not.toContain('s_seo_private');
    expect(xml).not.toContain('s_seo_live001');
    // Rooms and replays are disallowed, so they are not advertised either.
    expect(xml).not.toContain('/room/');
    expect(xml).not.toContain('/replay/');
  });

  it('is built once an hour: a session added now does not appear until it expires', async () => {
    await services.sessions.upsert(record('s_seo_fresh01'));
    const xml = await (await fetchApp('/sitemap.xml')).text();
    expect(xml).not.toContain('s_seo_fresh01');
  });

  it('escapes what goes into it and keeps one URL per line', () => {
    const xml = sitemapXml({
      publicUrl: 'https://x.test/',
      sessions: [record('s_seo_amp0001', { title: 'A & B' })],
      now: Date.parse('2026-09-17T00:00:00Z'),
    });
    expect(xml).toContain('<loc>https://x.test/sessions/s_seo_amp0001</loc>');
    expect(xml.split('\n').filter((l) => l.includes('<url>')).length).toBe(STATIC_PAGES.length + 1);
    expect(sitemapXml({ publicUrl: 'https://x.test', sessions: [], now: 0 })).not.toContain(
      '/sessions/',
    );
  });
});

describe('the share page', () => {
  it('carries LearningResource structured data, a canonical URL and the language', async () => {
    const html = await (await fetchApp('/s/s_seo_public1')).text();
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain(
      '<link rel="canonical" href="https://penplayground.test/sessions/s_seo_public1">',
    );
    expect(html).toContain('<meta property="og:site_name" content="Pen Playground">');
    expect(html).toContain('<meta name="twitter:title"');
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1];
    expect(ld, 'JSON-LD block').toBeDefined();
    const data = JSON.parse(ld ?? '{}');
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('LearningResource');
    expect(data.name).toBe('How Transformers work in LLMs');
    expect(data.description).toMatch(/attention/i);
    expect(data.url).toBe('https://penplayground.test/sessions/s_seo_public1');
    expect(data.thumbnailUrl).toBe('http://api.test/api/sessions/s_seo_public1/og.png');
    expect(data.provider).toEqual({
      '@type': 'Organization',
      name: 'Pen Playground',
      url: 'https://penplayground.test',
    });
    expect(data.inLanguage).toBe('en-US');
    expect(data.educationalLevel).toBe('beginner');
    expect(data.timeRequired).toBe('PT14M');
    expect(data.keywords).toBe('transformers, attention');
    expect(data.author).toEqual({ '@type': 'Person', name: 'Nova Ellis' });
  });

  it('follows the session language', async () => {
    const html = await (await fetchApp('/s/s_seo_farsi01')).text();
    expect(html).toContain('<html lang="fa-IR">');
    expect(html).toContain('<meta property="og:locale" content="fa_IR">');
    expect(JSON.parse(/ld\+json">(.*?)<\/script>/s.exec(html)?.[1] ?? '{}').inLanguage).toBe(
      'fa-IR',
    );
  });

  it('advertises nothing structured for a private session', async () => {
    const res = await fetchApp('/s/s_seo_private');
    const html = await res.text();
    expect(html).not.toContain('application/ld+json');
    expect(res.headers.get('cache-control')).toBe('private');
  });

  it('never lets copy break out of the JSON block', () => {
    const ld = learningResourceJsonLd({
      record: record('s_seo_xss0001', { title: '</script><script>alert(1)</script>' }),
      expertName: null,
      url: 'https://x.test/sessions/s_seo_xss0001',
      siteUrl: 'https://x.test',
      imageUrl: null,
      description: 'd',
    });
    expect(ld).not.toContain('</script>');
    expect(JSON.parse(ld).name).toBe('</script><script>alert(1)</script>');
  });
});
