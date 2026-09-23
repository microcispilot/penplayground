import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sentryEsbuildPlugin } from '@sentry/esbuild-plugin';
import { build, type Plugin } from 'esbuild';

/**
 * Production bundle: `src/main.ts` and everything it imports — the `@pen/*` workspace packages
 * and their pure-JS dependencies — become one ESM file so the server runs on plain `node`
 * (no tsx, no TypeScript at runtime). Only packages that are not bundle-safe stay external and
 * resolve from `node_modules` at runtime; each of them is therefore a direct dependency of
 * `@pen/api` (same exact versions as the workspace packages that use them):
 *
 *   @electric-sql/pglite   wasm + data assets located via import.meta.url
 *   postgres               native-ish socket/TLS handling, dynamic requires
 *   ws (+ bufferutil, utf-8-validate)   optional native add-ons
 *   sharp                  native (napi) image codec; derives the WebP card and JPEG og image
 *   pino / pino-pretty     worker-thread transports resolved from pino's own location
 *   @sentry/node           module require hooks and lazy instrumentation requires
 *   undici                 large CJS with optional `node:sqlite`/dispatcher requires
 *   playwright(-core)      locates browsers and its driver relative to its own package
 *   fasttext.wasm.js       loads its .wasm and the lid.176 model relative to its own package
 *   google-auth-library    gaxios/gcp-metadata reach for optional peers at runtime
 *   @node-rs/argon2        native (napi) password hashing; the platform binding is a
 *                          `.node` file esbuild has no loader for, and the right binding is
 *                          chosen by a `require` esbuild would have to resolve at build time
 *                          — which would bake this machine's darwin-arm64 into a linux image
 *   nodemailer             dynamic requires for its transports
 *
 * Output: dist/main.js (+ .map, meta.json) and dist/drizzle (migrations copied beside the bundle).
 *
 * Source maps: with `SENTRY_AUTH_TOKEN` set the map is uploaded to Sentry (project
 * pen-academy-api) under the release = git sha, and the bundle carries the matching debug id
 * and release, so production stack traces resolve to TypeScript. The `.map` stays on disk for
 * `NODE_OPTIONS=--enable-source-maps`. Without the token the build is exactly the same minus
 * the upload.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');

const EXTERNAL = [
  '@electric-sql/pglite',
  'postgres',
  'ws',
  'bufferutil',
  'utf-8-validate',
  'sharp',
  'pino',
  'pino-pretty',
  '@sentry/node',
  'undici',
  'playwright',
  'playwright-core',
  'fasttext.wasm.js',
  'google-auth-library',
  '@node-rs/argon2',
  'nodemailer',
];

const externalPackages: Plugin = {
  name: 'external-packages',
  setup(api) {
    // Match the package name and any deep import of it (`@electric-sql/pglite/vector`).
    const matcher = new RegExp(
      `^(?:${EXTERNAL.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/|$)`,
    );
    api.onResolve({ filter: /^[^./]/ }, (args) =>
      matcher.test(args.path) ? { path: args.path, external: true } : null,
    );
  },
};

/** The release every Sentry event and uploaded map is filed under: the commit being built. */
function releaseName(): string {
  const given = process.env.SENTRY_RELEASE?.trim();
  if (given) return given;
  try {
    // Docker builds have no .git: the Dockerfile passes SENTRY_RELEASE (= GIT_SHA) instead.
    return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryRelease = sentryAuthToken ? releaseName() : null;
const sentry: Plugin[] =
  sentryAuthToken && sentryRelease
    ? [
        sentryEsbuildPlugin({
          org: process.env.SENTRY_ORG?.trim() || 'pen-playground',
          project: 'pen-academy-api',
          authToken: sentryAuthToken,
          release: { name: sentryRelease },
          telemetry: false,
        }),
      ]
    : [];
if (sentryRelease) console.log(`sentry: uploading source maps as release ${sentryRelease}`);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(outdir, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  // The Sentry plugin must come last so it sees the final output.
  plugins: [externalPackages, ...sentry],
  banner: {
    // Some CommonJS-authored dependencies reach for `require` even when imported from ESM.
    js: "import { createRequire as __penCreateRequire } from 'node:module';\nconst require = __penCreateRequire(import.meta.url);",
  },
});
writeFileSync(join(outdir, 'meta.json'), JSON.stringify(result.metafile));

// Bundled @pen/db looks for migrations beside the bundle (dist/drizzle) unless PEN_MIGRATIONS_DIR
// is set, so `node dist/main.js` works from a checkout and from the image alike.
cpSync(join(root, '..', '..', 'packages', 'db', 'drizzle'), join(outdir, 'drizzle'), {
  recursive: true,
});
