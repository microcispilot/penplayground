import type { SessionRecord } from '@pen/db';
import { basePathOf, trimTrailingSlash } from './urls.js';

/**
 * What crawlers and social scrapers read (ADR-0013 gave them the picture;
 * this gives them the words): `robots.txt`, a sitemap of everything public,
 * and the structured data on a share page.
 *
 * Nothing here is personalised, so the whole surface is cacheable for an hour
 * at the edge and rebuilt at most once an hour in the process.
 */
export const SITEMAP_TTL_MS = 60 * 60_000;
/** Sitemaps allow 50 000 URLs; we stay far below and keep the response small. */
export const SITEMAP_MAX_SESSIONS = 5_000;

/** Pages that exist for everyone, with how often they are worth re-reading. */
export const STATIC_PAGES: ReadonlyArray<{
  path: string;
  changefreq: 'daily' | 'weekly' | 'monthly';
  priority: string;
}> = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/experts', changefreq: 'weekly', priority: '0.7' },
  { path: '/pricing', changefreq: 'monthly', priority: '0.5' },
  { path: '/terms', changefreq: 'monthly', priority: '0.3' },
  { path: '/privacy', changefreq: 'monthly', priority: '0.3' },
  { path: '/refunds', changefreq: 'monthly', priority: '0.3' },
];

export function xmlEscape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch,
  );
}

/** W3C datetime, date precision — what sitemaps want for `lastmod`. */
function lastmod(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function sitemapXml(args: {
  /** The site's public base — an origin, or an origin plus the path the app is served under. */
  publicUrl: string;
  sessions: SessionRecord[];
  now?: number;
}): string {
  const base = trimTrailingSlash(args.publicUrl);
  const today = lastmod(args.now ?? Date.now());
  const urls = [
    ...STATIC_PAGES.map(
      (p) =>
        `<url><loc>${xmlEscape(base + p.path)}</loc><lastmod>${today}</lastmod>` +
        `<changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`,
    ),
    ...args.sessions.map(
      (s) =>
        `<url><loc>${xmlEscape(`${base}/sessions/${s.id}`)}</loc>` +
        `<lastmod>${lastmod(s.endedAt ?? s.startedAt)}</lastmod>` +
        `<changefreq>monthly</changefreq><priority>0.7</priority></url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * The learner's own shelves (ADR-0015). They are `noindex` in the head too, but
 * that only arrives after the app has booted; this keeps a crawler off them in
 * the first place. `/rooms` is listed on its own — `Disallow: /room/` does not
 * cover it, the prefixes only look alike.
 */
export const PRIVATE_PAGES: readonly string[] = [
  '/history',
  '/saved',
  '/liked',
  '/downloads',
  '/rooms',
];

/**
 * Crawlers are welcome everywhere a reader can go. A live room and a replay
 * are a WebSocket and an audio stream, not a page — indexing them wastes a
 * crawl budget on something that is gone by the time anyone clicks — and one
 * learner's shelves are no one else's reading.
 */
export function robotsTxt(publicUrl: string): string {
  const base = trimTrailingSlash(publicUrl);
  // A `Disallow:` line is a path on the host, not a URL: when the app is served
  // under a prefix, `/room/` is not a path that exists and the rules would
  // guard nothing. `Allow:` becomes the prefix itself for the same reason.
  const prefix = basePathOf(publicUrl);
  return [
    'User-agent: *',
    `Allow: ${prefix}/`,
    `Disallow: ${prefix}/room/`,
    `Disallow: ${prefix}/replay/`,
    `Disallow: ${prefix}/api/`,
    ...PRIVATE_PAGES.map((path) => `Disallow: ${prefix}${path}`),
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * `schema.org/LearningResource` for a saved session: what it teaches, who
 * taught it, and the sketch that stands for it. Google reads it for the
 * learning-resource treatment in search; everything in it is already on the
 * page, which is the rule for structured data.
 */
export function learningResourceJsonLd(args: {
  record: SessionRecord;
  expertName: string | null;
  /** The saved-session page this share link leads to. */
  url: string;
  /** The site itself, for the provider. */
  siteUrl: string;
  imageUrl: string | null;
  description: string;
}): string {
  const { record } = args;
  const json: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LearningResource',
    name: record.title,
    description: args.description,
    url: args.url,
    inLanguage: record.language,
    learningResourceType: 'lesson',
    educationalLevel: record.band,
    isAccessibleForFree: true,
    datePublished: new Date(record.endedAt ?? record.startedAt).toISOString(),
    timeRequired: `PT${Math.max(1, Math.round(record.durationMs / 60_000))}M`,
    provider: {
      '@type': 'Organization',
      name: 'Pen Playground',
      url: trimTrailingSlash(args.siteUrl),
    },
    ...(args.expertName ? { author: { '@type': 'Person', name: args.expertName } } : {}),
    ...(args.imageUrl ? { thumbnailUrl: args.imageUrl, image: args.imageUrl } : {}),
    ...(record.keywords.length > 0 ? { keywords: record.keywords.join(', ') } : {}),
    ...(record.promise ? { teaches: record.promise } : {}),
  };
  // `</script>` inside JSON would close the tag early; `<` never appears in our copy but the
  // guard is what keeps this safe by construction.
  return JSON.stringify(json).replace(/</g, '\\u003c');
}
