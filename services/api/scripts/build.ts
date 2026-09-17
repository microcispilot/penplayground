import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 *   sharp                  native (not used today; kept external in case a package pulls it in)
 *   pino / pino-pretty     worker-thread transports resolved from pino's own location
 *   @sentry/node           module require hooks and lazy instrumentation requires
 *   undici                 large CJS with optional `node:sqlite`/dispatcher requires
 *
 * Output: dist/main.js (+ .map, meta.json) and dist/drizzle (migrations copied beside the bundle).
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
  plugins: [externalPackages],
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
