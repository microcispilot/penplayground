/**
 * Public URLs the API hands out.
 *
 * `PEN_PUBLIC_URL` and `PEN_API_URL` are origins in the ordinary deployment
 * (`https://penplayground.com`), but a deployment can serve the whole product
 * under a path prefix instead (`https://sdjust.penplayground.com/testingxyzbdc`),
 * and then they carry that prefix. Every URL this service puts in front of a
 * browser, a crawler, a social scraper or Stripe is built here, so the prefix
 * can only be right or wrong in one place.
 *
 * With a bare origin the output is byte-for-byte what plain concatenation
 * produced before this module existed; a trailing slash on the configured
 * value is absorbed rather than doubled.
 */

/** `https://host/testingxyzbdc/` → `https://host/testingxyzbdc` (and `https://host/` → `https://host`). */
export function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * An absolute URL for an app or API path under a configured base.
 * `publicUrl('https://host/testingxyzbdc/', '/sessions/s_1')`
 * → `https://host/testingxyzbdc/sessions/s_1`.
 */
export function publicUrl(base: string, path = '/'): string {
  const root = trimTrailingSlash(base);
  if (path === '' || path === '/') return `${root}/`;
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The path prefix a configured base is mounted at: `''` for a bare origin,
 * `/testingxyzbdc` under a prefix. What `robots.txt` needs, because a
 * `Disallow:` line is a path on the host, not a URL.
 */
export function basePathOf(base: string): string {
  let pathname: string;
  try {
    pathname = new URL(base).pathname;
  } catch {
    // A non-URL never reaches here (config.ts validates both values as URLs),
    // but a caller that hands over a prefix directly still gets the right answer.
    pathname = base;
  }
  const trimmed = trimTrailingSlash(pathname);
  return trimmed === '' || trimmed === '/' ? '' : trimmed;
}
