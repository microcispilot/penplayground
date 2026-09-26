import { execSync } from 'node:child_process';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type HtmlTagDescriptor, loadEnv, type Plugin } from 'vite';
import { defaultPolicy } from './csp.js';

const api = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4000'}`;
const ws = api.replace('http', 'ws');

/**
 * Where the app is served on its origin. `/` is the ordinary deployment and
 * every URL below is byte-for-byte what it was before this existed; set
 * `PEN_BASE_PATH=/testingxyzbdc` (the web image takes it as a build arg) and
 * the whole bundle moves under that prefix.
 *
 * Vite's `base` is what makes that work, and it reaches further than the asset
 * `src`/`href` attributes: it is the prefix of every lazy chunk request, of the
 * `modulepreload` hints rollup emits, and it is published to the app itself as
 * `import.meta.env.BASE_URL` — which is where `apps/web/src/platform.web.ts`
 * reads it for the router's basename and the API origin.
 *
 * Deliberately NOT affected by it, and this is what keeps the microphone
 * working under a prefix: the capture AudioWorklet is imported as source text
 * (`@pen/voice/worklet?raw`) and loaded from a `blob:` URL, and the resampler
 * is `?worker&inline`, a base64 `blob:` too. Neither is ever fetched by URL,
 * so neither can 404 under a prefix. See packages/voice/src/client/microphone.ts.
 *
 * Normalised to Vite's own shape — leading and trailing slash — so
 * `import.meta.env.BASE_URL` is exactly `/` or `/testingxyzbdc/`.
 */
function basePath(): string {
  const raw = process.env.PEN_BASE_PATH?.trim();
  if (!raw || raw === '/') return '/';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
}

/** The base without its trailing slash: `''` at the root, `/testingxyzbdc` under a prefix. */
function basePrefix(): string {
  const base = basePath();
  return base === '/' ? '' : base.slice(0, -1);
}

/**
 * The dev and preview servers serve the app at `base`, so the app asks for
 * `<prefix>/api/...` and `<prefix>/ws/...`. The proxy table is keyed on real
 * request paths, so each entry moves under the prefix and rewrites it away
 * before the request reaches the API — which is exactly what nginx does in
 * front of a prefixed deployment (deploy/nginx/pen-playground-test.conf.example).
 * With no prefix the table is identical to what it always was.
 */
function proxy(paths: Record<string, { target: string; ws?: boolean }>) {
  const prefix = basePrefix();
  const table: Record<string, Record<string, unknown>> = {};
  for (const [path, opts] of Object.entries(paths)) {
    table[`${prefix}${path}`] = {
      target: opts.target,
      changeOrigin: true,
      ...(opts.ws === true ? { ws: true } : {}),
      ...(prefix ? { rewrite: (p: string) => p.slice(prefix.length) } : {}),
    };
  }
  return table;
}

/** The release every Sentry event and every uploaded source map is filed under: the commit being built. */
function releaseName(): string {
  const given = process.env.SENTRY_RELEASE?.trim();
  if (given) return given;
  try {
    // Docker builds have no .git: deploy.sh passes SENTRY_RELEASE instead.
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Faces the first screen paints with, by hashed file name. Empty on purpose:
 * since the type system became one system family (`--font-sans`/`--font-display`
 * resolve to SF Pro / Segoe UI / Roboto), the first paint uses a face that is
 * already on the device. Inter is only the last resort before `ui-sans-serif`,
 * so preloading it would cost every visitor a font download they never render.
 * Add a pattern back here the day a web face is genuinely above the fold.
 */
const ABOVE_THE_FOLD_FONTS: RegExp[] = [];

/**
 * Head hints the browser can only act on if they are in the HTML: preconnect to
 * a cross-origin API (portraits and the session call start there, one RTT
 * earlier) and preload the two variable fonts the first paint needs. Font file
 * names are content-hashed, so they are read off the finished bundle rather
 * than hard-coded.
 */
function headHints(env: Record<string, string>): Plugin {
  const origins = new Set<string>();
  for (const url of [env.VITE_API_URL, env.VITE_POSTHOG_HOST]) {
    if (!url) continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      // A malformed URL is the app's problem at runtime, not the build's.
    }
  }
  return {
    name: 'pen-head-hints',
    apply: 'build',
    transformIndexHtml: {
      // `post` so the finished bundle is on the context and the hashed font names are known.
      order: 'post',
      handler(_html, ctx): HtmlTagDescriptor[] {
        const fonts = Object.keys(ctx.bundle ?? {}).filter(
          (file) => file.endsWith('.woff2') && ABOVE_THE_FOLD_FONTS.some((re) => re.test(file)),
        );
        return [
          ...[...origins].flatMap<HtmlTagDescriptor>((href) => [
            { tag: 'link', attrs: { rel: 'preconnect', href, crossorigin: '' }, injectTo: 'head' },
            { tag: 'link', attrs: { rel: 'dns-prefetch', href }, injectTo: 'head' },
          ]),
          ...fonts.map<HtmlTagDescriptor>((file) => ({
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'font',
              type: 'font/woff2',
              // Hand-built, so unlike every `src`/`href` Vite rewrites it has
              // to carry `base` itself or the preload 404s under a prefix.
              href: `${basePath()}${file}`,
              crossorigin: '',
            },
            injectTo: 'head',
          })),
        ];
      },
    },
  };
}

/**
 * Chunking (ADR-0001 keeps apps thin, so this is where the weight is decided).
 * What keeps weight out of the entry is where the `import()` is, not this
 * function: tldraw comes in through a lazy `<Board>`, livekit-client through a
 * dynamic import in the audio room, the IMA SDK through its script loader and
 * posthog-js through `initAnalytics`.
 *
 * Deliberately NOT grouped: tldraw. Naming a lazily reached package here makes
 * the bundler treat its chunk as shared, which puts a `modulepreload` and a
 * blocking `<link rel=stylesheet>` for all of tldraw back into index.html —
 * measured, and it undoes the split. Only genuinely shared, long-lived vendor
 * code is named, so its hash survives releases that only touch app code.
 */
function chunkOf(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
  if (/node_modules\/posthog-js\//.test(id)) return 'posthog';
  if (/node_modules\/@sentry\//.test(id)) return 'sentry';
  return undefined;
}

export default defineConfig(({ mode }) => {
  const authToken = process.env.SENTRY_AUTH_TOKEN?.trim();
  // The same one root .env `envDir` points at, read here so the head hints know the real origins.
  const env = loadEnv(mode, '../..', 'VITE_');
  // Source maps go to Sentry only for a production build with a token; every other build is
  // unchanged, and the maps are deleted from dist after the upload so they are never served.
  const sentry =
    mode === 'production' && authToken
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG?.trim() || 'pen-playground',
            project: 'pen-academy-web',
            authToken,
            release: { name: releaseName() },
            sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
            telemetry: false,
          }),
        ]
      : [];
  return {
    plugins: [react(), tailwindcss(), headHints(env), ...sentry],
    // The commit the bundle is from, so Sentry's `release` in the browser matches the uploaded maps.
    define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(releaseName()) },
    base: basePath(),
    // One .env at the repo root for every app and service.
    envDir: '../..',
    server: {
      port: 5173,
      // The same policy the web container serves in production, minus the
      // inline-script hashes Vite's own dev injections cannot satisfy. Serving
      // it here is what lets the Playwright suite prove that nothing the app
      // needs is blocked (apps/web/e2e/csp.spec.ts).
      // `PEN_CSP_REPORT_ONLY=1` reports violations instead of blocking, which is
      // how the policy is widened safely: run the suite, read what it reports.
      headers: {
        [process.env.PEN_CSP_REPORT_ONLY === '1'
          ? 'Content-Security-Policy-Report-Only'
          : 'Content-Security-Policy']: defaultPolicy({ dev: true }),
      },
      proxy: proxy({
        '/api': { target: api },
        // Only the portraits are the API's; `/experts` itself is a screen in the app.
        '/experts/portraits': { target: api },
        // Share pages and the sitemap are rendered by the API; nginx does the same in production.
        '/s/': { target: api },
        '/sitemap.xml': { target: api },
        '/ws': { target: ws, ws: true },
      }),
    },
    // `vite preview` serves the real build. It needs the same proxy, both to try
    // a production bundle locally and because the load-performance e2e measures
    // here — dev serves a few hundred unbundled modules, which would make any
    // measurement of what we actually ship meaningless.
    preview: {
      port: 5184,
      proxy: proxy({
        '/api': { target: api },
        // Only the portraits are the API's; `/experts` itself is a screen in the app.
        '/experts/portraits': { target: api },
        '/ws': { target: ws, ws: true },
      }),
    },
    build: {
      target: 'es2023',
      sourcemap: true,
      rollupOptions: { output: { manualChunks: chunkOf } },
      // Raised only after the real splitting above. One chunk is over it — the
      // board (tldraw + the ink engine), ~2.0 MB raw / ~594 kB gzip — and it is
      // fetched by two screens out of seven, after they have already painted.
      // Anything else crossing this line is a regression worth a warning.
      chunkSizeWarningLimit: 2100,
    },
    worker: { format: 'es' },
  };
});
