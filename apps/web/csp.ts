import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Content-Security-Policy, in one place.
 *
 * It is written here rather than in the nginx config because two copies of a
 * policy drift, and a CSP that drifts either blocks the product or stops
 * protecting it. `deploy/web/nginx.conf` carries the generated string and
 * `test/csp.test.ts` fails the build if the two ever disagree.
 *
 * Every origin below is one the app was observed to use in a real Playwright
 * run: `e2e/csp.spec.ts` walks Home, Experts, a shelf, the legal pages, the
 * account sheet, a live lesson, the saved session page and a replay and writes
 * what it saw to `.pen-data/csp-origins.json`; `e2e/ads.spec.ts` covers the ad
 * path under the same header. Nothing is here "just in case", and the way to
 * add something is to run the suite with `PEN_CSP_REPORT_ONLY=1` and read what
 * the browser reports — an enforced policy hides everything behind the first
 * request it blocks.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Google Ad Manager through the IMA SDK (ADR-0014): the SDK, the tag, the
 * creative. Recorded on one sample-tag run: the loader pulls a second script
 * from `s0.2mdn.net` (`/instream/video/client.js`), `securepubads` and
 * `pubads.g.doubleclick.net` answer the tag, and `pagead2.googlesyndication.com`
 * serves both a script and an image. They are patterns rather than names
 * because each is one shard of a numbered family.
 */
const GOOGLE_ADS = [
  'https://imasdk.googleapis.com',
  'https://*.doubleclick.net',
  'https://*.googlesyndication.com',
  'https://*.2mdn.net',
];
/**
 * Where an ad creative's video actually streams from: Google's own media edges.
 * The recorded run fetched media from `redirector.gvt1.com` and then from the
 * `r<N>---sn-<pop>.gvt1.com` host it handed back, so the family is a pattern —
 * naming one shard would work until the next request picked another.
 */
const GOOGLE_AD_MEDIA = ['https://*.googlevideo.com', 'https://*.gvt1.com', ...GOOGLE_ADS];
/** The IMA SDK's own latency beacon (`csi?v=2&s=ima…`), sent while an ad is rendering. */
const GOOGLE_AD_MEASUREMENT = ['https://csi.gstatic.com'];
/** Google Identity Services: the button, its stylesheet, its iframe. */
const GOOGLE_SIGN_IN = ['https://accounts.google.com'];
/** tldraw fetches its icons, translations and fonts from its own CDN. */
const TLDRAW = ['https://cdn.tldraw.com'];

export interface CspOptions {
  /**
   * PostHog ingest and asset origins (`VITE_POSTHOG_HOST`, whose assets host is
   * the same name with `-assets`). Omit to leave analytics out of the policy.
   */
  posthogHost?: string;
  /** Sentry ingest origin from the DSN; `*.ingest.*.sentry.io` covers the org subdomain. */
  sentry?: boolean;
  /** sha256 hashes of the inline scripts in index.html, so `unsafe-inline` is never needed. */
  inlineScriptHashes: readonly string[];
  /**
   * The API/WebSocket origin when it is not the page's own. In every deployed
   * setup nginx serves the app and proxies `/api` and `/ws`, so this is empty
   * and `'self'` covers both.
   */
  apiOrigin?: string;
  /**
   * Vite's dev server injects inline module scripts (HMR, the React refresh
   * preamble) and evaluates modules with `eval`, neither of which has a stable
   * hash. Dev therefore relaxes `script-src` and nothing else, so an e2e run
   * still proves every *origin* the app needs — the part of the policy that can
   * break the product. The shipped bundle contains no `eval` at all (checked by
   * `test/csp.test.ts` against `dist`), so production keeps the strict form.
   */
  dev?: boolean;
}

/** The sha256-with-base64 source expression for one inline script's exact text. */
export function inlineScriptHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

/** Every inline `<script>` body in an HTML document, in order. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match = re.exec(html);
  while (match !== null) {
    if (match[1] !== undefined) out.push(match[1]);
    match = re.exec(html);
  }
  return out;
}

/** Hashes for `apps/web/index.html` as it stands on disk. */
export function indexInlineScriptHashes(indexHtmlPath = join(here, 'index.html')): string[] {
  return inlineScripts(readFileSync(indexHtmlPath, 'utf8')).map(inlineScriptHash);
}

export function contentSecurityPolicy(options: CspOptions): string {
  const posthog = options.posthogHost ? originsOf(options.posthogHost) : [];
  const sentry = options.sentry
    ? ['https://*.ingest.sentry.io', 'https://*.ingest.us.sentry.io']
    : [];
  const api = options.apiOrigin
    ? [options.apiOrigin, options.apiOrigin.replace(/^http/, 'ws')]
    : [];

  const directives: Array<[string, string[]]> = [
    // Nothing is allowed by default; every capability below is granted on purpose.
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    // The app is never framed: there is no embed story, and this is the cheapest clickjacking answer.
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        ...(options.dev ? ["'unsafe-inline'", "'unsafe-eval'"] : options.inlineScriptHashes),
        ...GOOGLE_ADS,
        ...GOOGLE_SIGN_IN,
        ...posthog,
      ],
    ],
    // Tailwind and the board write styles at runtime; a style hash would have to
    // change on every build, and inline styles are not an XSS vector on their own.
    ['style-src', ["'self'", "'unsafe-inline'", ...GOOGLE_SIGN_IN]],
    [
      'img-src',
      [
        "'self'",
        // Board sketches and expert portraits arrive as blobs and data URIs.
        'data:',
        'blob:',
        ...TLDRAW,
        // Google account avatars, and the ad stack's own pixels.
        'https://lh3.googleusercontent.com',
        ...GOOGLE_ADS,
        'https://*.google.com',
      ],
    ],
    ['font-src', ["'self'", 'data:', ...TLDRAW, 'https://fonts.gstatic.com']],
    // Lesson audio is PCM over the WebSocket and replay audio is a blob URL; ad
    // creatives stream from Google's own media hosts.
    ['media-src', ["'self'", 'blob:', 'data:', ...GOOGLE_AD_MEDIA]],
    [
      'connect-src',
      [
        // 'self' covers the API and the room WebSocket: nginx serves both from this origin.
        "'self'",
        ...api,
        ...TLDRAW,
        ...posthog,
        ...sentry,
        ...GOOGLE_SIGN_IN,
        ...GOOGLE_ADS,
        ...GOOGLE_AD_MEASUREMENT,
        'https://*.google.com',
      ],
    ],
    [
      'frame-src',
      [
        ...GOOGLE_ADS,
        ...GOOGLE_SIGN_IN,
        // Measured, not guessed: on the plain-http dev server the IMA SDK
        // frames `http://imasdk.googleapis.com/`, which this policy's https
        // entry does not match, and the ad slot stays empty. Production serves
        // the page over https and carries `upgrade-insecure-requests` below, so
        // the shipped policy is left strict rather than given an http entry it
        // would only need on a scheme it never runs on. That half is reasoned,
        // not measured here: check it on the first real https deploy with the
        // console open on an ad (docs/DEPLOY.md says the same).
        ...(options.dev ? ['http://imasdk.googleapis.com'] : []),
      ],
    ],
    // The microphone capture AudioWorklet is loaded from a blob: URL.
    ['worker-src', ["'self'", 'blob:']],
    ['child-src', ['blob:', ...GOOGLE_ADS]],
    ['manifest-src', ["'self'"]],
    // Dev serves over plain http on localhost; upgrading there breaks it.
    ...(options.dev ? [] : [['upgrade-insecure-requests', []] as [string, string[]]]),
  ];

  return directives
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** PostHog serves its ingest from `us.i.posthog.com` and its bundles from `us-assets.i.posthog.com`. */
function originsOf(posthogHost: string): string[] {
  try {
    const url = new URL(posthogHost);
    const assets = url.origin.replace(/^(https?:\/\/)([^.]+)\./, '$1$2-assets.');
    return assets === url.origin ? [url.origin] : [url.origin, assets];
  } catch {
    return [];
  }
}

/** The policy this repository ships: PostHog US, Sentry, the app's own inline theme script. */
export function defaultPolicy(options: { dev?: boolean } = {}): string {
  return contentSecurityPolicy({
    posthogHost: 'https://us.i.posthog.com',
    sentry: true,
    inlineScriptHashes: indexInlineScriptHashes(),
    ...(options.dev ? { dev: true } : {}),
  });
}
