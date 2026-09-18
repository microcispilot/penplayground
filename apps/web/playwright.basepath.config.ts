import { defineConfig, devices } from '@playwright/test';

/**
 * The same product, served under a URL path prefix instead of the root of its origin — the
 * shape the test host uses (`https://sdjust.penplayground.com/testingxyzbdc/`).
 *
 * This is a real deployment rehearsal, not a dev server with a flag: the bundle is built with
 * `PEN_BASE_PATH` (so Vite's `base`, the lazy chunks and the preload hints are all prefixed) and
 * served by the actual `nginx:1.30-alpine` image running both tiers of the production stack —
 * the edge that strips the prefix, and `deploy/web/nginx.conf` behind it. If the prefix is wrong
 * anywhere, something 404s and `base-path.spec.ts` says which.
 *
 *   CI=true pnpm --filter @pen/web exec playwright test --config=playwright.basepath.config.ts
 *
 * Needs a Docker daemon. Ports are overridable so it never collides with the default suite.
 */
const apiPort = process.env.PEN_API_PORT ?? '4041';
const webPort = process.env.PEN_E2E_BASE_PORT ?? '5201';
const basePath = (process.env.PEN_BASE_PATH ?? '/testingxyzbdc').replace(/\/+$/, '');
const origin = `http://127.0.0.1:${webPort}`;
/** What the browser is pointed at, and what the API is told it is publicly reachable as. */
const publicUrl = `${origin}${basePath}`;

export default defineConfig({
  testDir: './e2e',
  // The journey specs. The rest of the suite asserts against the root deployment's own servers.
  testMatch: ['base-path.spec.ts', 'session.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  use: {
    // The trailing slash matters: `page.goto('/')` resolves against the ORIGIN, so it lands on
    // `/` and follows the edge's 308 into the app — which is how session.spec.ts, written for
    // the root deployment, runs here unchanged and proves the redirect at the same time.
    baseURL: `${publicUrl}/`,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  // The full Chromium build: the headless shell crashes on AudioWorklet + fake audio devices.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  webServer: [
    {
      command: 'pnpm --filter @pen/api start',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PEN_PORT: apiPort,
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_DATA_DIR: '.pen-data-e2e-basepath',
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        PEN_MAX_SESSIONS_PER_IP: '50',
        // Both carry the prefix here, exactly as they must on the test host: every share URL,
        // og:image, sitemap entry and download link the API builds is derived from them.
        PEN_PUBLIC_URL: publicUrl,
        PEN_API_URL: publicUrl,
      },
      timeout: 120_000,
    },
    {
      command: 'bash scripts/base-path-rig.sh',
      url: `${publicUrl}/`,
      reuseExistingServer: !process.env.CI,
      env: { PEN_BASE_PATH: basePath, PEN_E2E_BASE_PORT: webPort, PEN_API_PORT: apiPort },
      timeout: 300_000,
    },
  ],
});
