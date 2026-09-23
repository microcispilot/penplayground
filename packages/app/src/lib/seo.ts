import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { normalizeBasePath, withBasePath } from './base-path.js';

/**
 * What a crawler, a shared link and a browser tab see for the screen that is
 * on. The app is one HTML document, so the head is state like anything else:
 * every screen declares its title and description, and the shell declares a
 * default for the routes that have nothing of their own.
 *
 * The share page (`/s/:id`, rendered by the API) is what social scrapers
 * read; this is for crawlers that execute JavaScript, and for the tab.
 */
export interface Seo {
  /** Without the suffix: "How Transformers work" becomes "How Transformers work · Pen Playground". */
  title: string;
  description?: string;
  /** Defaults to the current path, without query or hash. */
  canonicalPath?: string;
  /** A screen that is not a page anyone should land on from search. */
  noindex?: boolean;
  /** BCP-47; drives `<html lang>` (and `dir` through `applyDocumentLanguage`). */
  language?: string;
}

/**
 * Where the app is mounted on its origin (`Platform.basePath`), for the one
 * thing here that is a real URL rather than a route: the canonical/`og:url`
 * pair. `PenApp` sets it before the first render; at the root it is `''` and
 * every URL below is byte-for-byte what it was before this existed.
 *
 * A module-level value rather than a prop because `applySeo` is called from a
 * class error boundary and from screens that have no reason to know about
 * deployment shape — the same shape `setAnalyticsContext` already uses.
 */
let seoBasePath = '';

/** Called once by `PenApp`. Idempotent. */
export function setSeoBasePath(configured: string | null | undefined): void {
  seoBasePath = normalizeBasePath(configured);
}

export const SITE_NAME = 'Pen Playground';
export const DEFAULT_DESCRIPTION =
  'Ask for anything. An expert starts talking within seconds, writes it out on a board at a human pace, and stops the moment you speak.';

/** Titles read as the thing first, the site second — and never twice. */
export function pageTitle(title: string): string {
  const t = title.trim();
  if (!t || t === SITE_NAME) return SITE_NAME;
  return t.endsWith(SITE_NAME) ? t : `${t} · ${SITE_NAME}`;
}

function head(): HTMLHeadElement | null {
  return typeof document === 'undefined' ? null : document.head;
}

/** One `<meta name|property=…>`, created on first use and updated after that. */
function setMeta(kind: 'name' | 'property', key: string, content: string | null): void {
  const h = head();
  if (!h) return;
  const existing = h.querySelector<HTMLMetaElement>(`meta[${kind}="${key}"]`);
  if (content === null) {
    existing?.remove();
    return;
  }
  const el =
    existing ?? h.appendChild(Object.assign(document.createElement('meta'), { [kind]: key }));
  el.setAttribute(kind, key);
  el.content = content;
}

function setCanonical(href: string | null): void {
  const h = head();
  if (!h) return;
  const existing = h.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    existing?.remove();
    return;
  }
  const el =
    existing ?? h.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }));
  el.href = href;
}

/**
 * Apply a screen's head. Everything is written every time, so a screen never
 * inherits half of the previous one's description or a stale canonical.
 */
export function applySeo(seo: Seo): void {
  if (typeof document === 'undefined') return;
  const description = seo.description?.trim() || DEFAULT_DESCRIPTION;
  document.title = pageTitle(seo.title);
  setMeta('name', 'description', description);
  setMeta('property', 'og:title', pageTitle(seo.title));
  setMeta('property', 'og:description', description);
  setMeta('property', 'og:site_name', SITE_NAME);
  setMeta('property', 'og:type', 'website');
  setMeta('name', 'twitter:card', 'summary');
  setMeta('name', 'twitter:title', pageTitle(seo.title));
  setMeta('name', 'twitter:description', description);
  setMeta('name', 'robots', seo.noindex === true ? 'noindex, follow' : null);
  // A canonical URL is only meaningful where the app is served over the web:
  // the desktop host has no public address for the page it is showing.
  const loc = typeof window === 'undefined' ? null : window.location;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
    // `canonicalPath` is a route (`/sessions/:id`), so it needs the prefix;
    // `loc.pathname` is a real URL path and already carries it.
    const path =
      seo.canonicalPath !== undefined ? withBasePath(seoBasePath, seo.canonicalPath) : loc.pathname;
    setMeta('property', 'og:url', `${loc.origin}${path}`);
    setCanonical(`${loc.origin}${path}`);
  } else setCanonical(null);
}

/** Declare this screen's head. Later renders (a record that loaded) update it in place. */
export function useSeo(seo: Seo): void {
  const { title, description, canonicalPath, noindex, language } = seo;
  useEffect(() => {
    applySeo({
      title,
      ...(description !== undefined ? { description } : {}),
      ...(canonicalPath !== undefined ? { canonicalPath } : {}),
      ...(noindex !== undefined ? { noindex } : {}),
      ...(language !== undefined ? { language } : {}),
    });
  }, [title, description, canonicalPath, noindex, language]);
}

/** The default head per route; a screen with something better overrides it. */
export function seoForPath(pathname: string): Seo {
  if (pathname === '/') return { title: SITE_NAME, description: DEFAULT_DESCRIPTION };
  if (pathname === '/pricing')
    return {
      title: 'Pricing',
      description:
        'Three sessions a day are free. Standard adds unlimited sessions and video downloads; Professional adds rooms for up to 12 people.',
    };
  if (pathname === '/sessions')
    return {
      title: 'My sessions',
      description: 'Every session you started, saved to replay.',
      noindex: true,
    };
  if (pathname === '/experts')
    return {
      title: 'Experts',
      description: 'Every expert who can teach you — pick one and start a session.',
    };
  if (pathname === '/terms')
    return {
      title: 'Terms of Use',
      description: 'The terms you agree to when you use Pen Playground.',
    };
  if (pathname === '/privacy')
    return {
      title: 'Privacy Policy',
      description: 'What Pen Playground collects, why, and what you can ask us to delete.',
    };
  // The shelves are one learner's own: a real title in the tab, never in an index.
  const SHELVES: Record<string, string> = {
    '/history': 'History',
    '/saved': 'Learn later',
    '/liked': 'Liked',
    '/downloads': 'Downloads',
    '/rooms': 'Rooms',
  };
  const shelf = SHELVES[pathname];
  if (shelf) return { title: shelf, description: DEFAULT_DESCRIPTION, noindex: true };
  if (pathname.startsWith('/room/'))
    return { title: 'Live session', description: DEFAULT_DESCRIPTION, noindex: true };
  if (pathname.startsWith('/replay/'))
    return { title: 'Replay', description: DEFAULT_DESCRIPTION, noindex: true };
  if (pathname.startsWith('/sessions/'))
    return { title: 'Session', description: DEFAULT_DESCRIPTION };
  return { title: 'Page not found', description: DEFAULT_DESCRIPTION, noindex: true };
}

/** Mounted once by the shell: keeps the head in step with the route. */
export function RouteHead(): null {
  const { pathname } = useLocation();
  useEffect(() => {
    applySeo(seoForPath(pathname));
  }, [pathname]);
  return null;
}
