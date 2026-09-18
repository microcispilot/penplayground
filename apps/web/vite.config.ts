import { execSync } from 'node:child_process';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.PEN_API_PORT ?? '4000'}`;
const ws = api.replace('http', 'ws');

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

export default defineConfig(({ mode }) => {
  const authToken = process.env.SENTRY_AUTH_TOKEN?.trim();
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
    plugins: [react(), tailwindcss(), ...sentry],
    // One .env at the repo root for every app and service.
    envDir: '../..',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: api, changeOrigin: true },
        '/experts': { target: api, changeOrigin: true },
        '/ws': { target: ws, ws: true },
      },
    },
    build: { target: 'es2023', sourcemap: true },
    worker: { format: 'es' },
  };
});
