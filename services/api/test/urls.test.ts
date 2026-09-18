import type { SessionRecord } from '@pen/db';
import { describe, expect, it } from 'vitest';
import { learningResourceJsonLd, robotsTxt, STATIC_PAGES, sitemapXml } from '../src/seo.js';
import { basePathOf, publicUrl, trimTrailingSlash } from '../src/urls.js';

/**
 * Every public URL this service hands out, under both deployments: the
 * ordinary origin (`https://penplayground.com`) and one where the whole
 * product is served under a path prefix
 * (`https://sdjust.penplayground.com/testingxyzbdc`).
 *
 * The root cases are the point of half of these assertions: the output has to
 * be byte-for-byte what plain string concatenation produced before `urls.ts`
 * existed, or a working production deployment has been changed by accident.
 */

const ORIGIN = 'https://penplayground.test';
const PREFIXED = 'https://sdjust.penplayground.test/testingxyzbdc';

describe('trimTrailingSlash', () => {
  it('leaves a bare origin and a prefixed base alone, and absorbs trailing slashes', () => {
    expect(trimTrailingSlash(ORIGIN)).toBe(ORIGIN);
    expect(trimTrailingSlash(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(trimTrailingSlash(`${PREFIXED}/`)).toBe(PREFIXED);
    expect(trimTrailingSlash(`${PREFIXED}//`)).toBe(PREFIXED);
  });
});

describe('publicUrl', () => {
  it('is plain concatenation for a bare origin', () => {
    expect(publicUrl(ORIGIN, '/sessions/s_1')).toBe(`${ORIGIN}/sessions/s_1`);
    expect(publicUrl(ORIGIN, '/pricing?checkout=success')).toBe(
      `${ORIGIN}/pricing?checkout=success`,
    );
    expect(publicUrl(ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it('keeps the path prefix when the base carries one', () => {
    expect(publicUrl(PREFIXED, '/sessions/s_1')).toBe(`${PREFIXED}/sessions/s_1`);
    expect(publicUrl(`${PREFIXED}/`, '/sessions/s_1')).toBe(`${PREFIXED}/sessions/s_1`);
    expect(publicUrl(PREFIXED, '/api/sessions/s_1/og.png')).toBe(
      `${PREFIXED}/api/sessions/s_1/og.png`,
    );
    expect(publicUrl(PREFIXED)).toBe(`${PREFIXED}/`);
  });

  it('never doubles a slash, whichever side carries it', () => {
    expect(publicUrl(`${ORIGIN}/`, '/pricing')).toBe(`${ORIGIN}/pricing`);
    expect(publicUrl(ORIGIN, 'pricing')).toBe(`${ORIGIN}/pricing`);
  });
});

describe('basePathOf', () => {
  it('is empty for a bare origin — the root deployment has no prefix', () => {
    expect(basePathOf(ORIGIN)).toBe('');
    expect(basePathOf(`${ORIGIN}/`)).toBe('');
    expect(basePathOf('http://localhost:5173')).toBe('');
  });

  it('is the path the app is mounted at otherwise', () => {
    expect(basePathOf(PREFIXED)).toBe('/testingxyzbdc');
    expect(basePathOf(`${PREFIXED}/`)).toBe('/testingxyzbdc');
    expect(basePathOf('https://host.test/a/b/')).toBe('/a/b');
  });
});

describe('robots.txt under a base path', () => {
  it('is unchanged at the root', () => {
    // The exact bytes the production host serves today.
    expect(robotsTxt(ORIGIN)).toBe(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /room/',
        'Disallow: /replay/',
        'Disallow: /api/',
        'Disallow: /history',
        'Disallow: /saved',
        'Disallow: /liked',
        'Disallow: /downloads',
        'Disallow: /rooms',
        '',
        `Sitemap: ${ORIGIN}/sitemap.xml`,
        '',
      ].join('\n'),
    );
  });

  it('guards the paths that actually exist when the app is under a prefix', () => {
    const body = robotsTxt(PREFIXED);
    expect(body).toContain('Allow: /testingxyzbdc/');
    expect(body).toContain('Disallow: /testingxyzbdc/room/');
    expect(body).toContain('Disallow: /testingxyzbdc/replay/');
    expect(body).toContain('Disallow: /testingxyzbdc/api/');
    expect(body).toContain('Disallow: /testingxyzbdc/downloads');
    expect(body).toContain(`Sitemap: ${PREFIXED}/sitemap.xml`);
    // A bare `/room/` rule would guard a path that does not exist on this host.
    expect(body).not.toMatch(/^Disallow: \/room\/$/m);
  });
});

const record = (id: string): SessionRecord => ({
  id,
  topic: 'How Transformers work in LLMs',
  title: 'How Transformers work in LLMs',
  promise: 'Read an attention diagram.',
  expertId: 'nova-ai-expert',
  hostId: 'p_host_url00001',
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
  views: 1,
  thumbnail: `/api/sessions/${id}/thumb.svg`,
  canonicalId: 'en.how-transformers-work-in-llms',
  language: 'en-US',
  description: 'd',
  keywords: [],
  likes: 0,
});

describe('sitemap.xml under a base path', () => {
  it('lists prefixed URLs, and is unchanged at the root', () => {
    const now = Date.parse('2026-09-17T00:00:00Z');
    const root = sitemapXml({ publicUrl: ORIGIN, sessions: [record('s_url_root0001')], now });
    for (const page of STATIC_PAGES) expect(root).toContain(`<loc>${ORIGIN}${page.path}</loc>`);
    expect(root).toContain(`<loc>${ORIGIN}/sessions/s_url_root0001</loc>`);

    const prefixed = sitemapXml({
      publicUrl: `${PREFIXED}/`,
      sessions: [record('s_url_base0001')],
      now,
    });
    expect(prefixed).toContain(`<loc>${PREFIXED}/</loc>`);
    expect(prefixed).toContain(`<loc>${PREFIXED}/pricing</loc>`);
    expect(prefixed).toContain(`<loc>${PREFIXED}/sessions/s_url_base0001</loc>`);
    expect(prefixed).not.toContain('<loc>https://sdjust.penplayground.test/pricing</loc>');
  });
});

describe('structured data under a base path', () => {
  it('names the prefixed site as the provider', () => {
    const data = JSON.parse(
      learningResourceJsonLd({
        record: record('s_url_ld000001'),
        expertName: null,
        url: publicUrl(PREFIXED, '/sessions/s_url_ld000001'),
        siteUrl: `${PREFIXED}/`,
        imageUrl: publicUrl(PREFIXED, '/api/sessions/s_url_ld000001/og.png'),
        description: 'd',
      }),
    );
    expect(data.url).toBe(`${PREFIXED}/sessions/s_url_ld000001`);
    expect(data.provider.url).toBe(PREFIXED);
    expect(data.image).toBe(`${PREFIXED}/api/sessions/s_url_ld000001/og.png`);
  });
});
