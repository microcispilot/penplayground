/**
 * Where the app is mounted on its origin.
 *
 * The product is normally served at the root (`https://penplayground.com/`),
 * but a deployment can put it under a path prefix instead
 * (`https://sdjust.penplayground.com/testingxyzbdc/`). One value decides that
 * for the whole app — `Platform.basePath` — and everything that builds a URL
 * the browser will actually request goes through the helpers here.
 *
 * Three shapes are in play and it matters which is which:
 *
 *   - the **configured** value, as a host hands it over: Vite's
 *     `import.meta.env.BASE_URL` (`/` or `/testingxyzbdc/`), an env var, or
 *     the path of a public URL. Leading/trailing slashes are not guaranteed.
 *   - the **prefix**, what `normalizeBasePath` returns: `''` at the root, and
 *     `/testingxyzbdc` otherwise — a string you can concatenate an absolute
 *     path onto and get a valid one.
 *   - the **router basename**, which react-router wants as `/` at the root.
 *
 * Route-relative paths (`/room/:id`, `/sessions`) stay route-relative
 * everywhere in the product: react-router's `basename` adds the prefix to
 * every `<Link>`, `navigate()` and `useLocation()`. These helpers are for the
 * places the router does not reach — a full page load, the API origin, a
 * canonical URL, a link in a raw `<a href>`.
 */

/**
 * The configured value as a prefix: `''` at the root, `/testingxyzbdc` under a
 * prefix. Accepts anything a host might pass (`undefined`, `/`, `foo`,
 * `/foo/`, `//foo//`) and never returns a trailing slash.
 */
export function normalizeBasePath(configured: string | null | undefined): string {
  const trimmed = (configured ?? '').trim();
  if (!trimmed) return '';
  const collapsed = `/${trimmed}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '/' ? '' : collapsed;
}

/** What react-router's `basename` wants: `/` at the root, `/testingxyzbdc` under a prefix. */
export function routerBasename(configured: string | null | undefined): string {
  return normalizeBasePath(configured) || '/';
}

/**
 * An absolute in-app path with the prefix on it — for a full page load, an
 * `<a href>` outside the router, or anything concatenated onto an origin.
 * `withBasePath('/testingxyzbdc', '/pricing')` → `/testingxyzbdc/pricing`,
 * and the root stays `/testingxyzbdc/` rather than the bare prefix, so a hard
 * reload lands on the same URL nginx serves the app at.
 */
export function withBasePath(configured: string | null | undefined, path: string): string {
  const base = normalizeBasePath(configured);
  const rest = path.startsWith('/') ? path : `/${path}`;
  return `${base}${rest}`;
}

/**
 * Drop the prefix from a real `location.pathname`, giving the route the app
 * reasons about. A pathname outside the prefix is returned unchanged: the only
 * caller (boot mode) treats "not one of ours" as the ordinary app anyway.
 */
export function stripBasePath(configured: string | null | undefined, pathname: string): string {
  const base = normalizeBasePath(configured);
  if (!base) return pathname;
  if (pathname === base) return '/';
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}
