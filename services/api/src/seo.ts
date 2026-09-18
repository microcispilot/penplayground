import type { SessionRecord } from '@pen/db';

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
  { path: '/pricing', changefreq: 'monthly', priority: '0.5' },
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
  publicUrl: string;
  sessions: SessionRecord[];
  now?: number;
}): string {
  const base = args.publicUrl.replace(/\/+$/, '');
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
 * Crawlers are welcome everywhere a reader can go. A live room and a replay
 * are a WebSocket and an audio stream, not a page — indexing them wastes a
 * crawl budget on something that is gone by the time anyone clicks.
 */
export function robotsTxt(publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /room/',
    'Disallow: /replay/',
    'Disallow: /api/',
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
      url: args.siteUrl.replace(/\/+$/, ''),
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
