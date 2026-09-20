import { defineConfig, devices } from '@playwright/test';

/**
 * The operations console, end to end (ADR-0026, ADR-0027).
 *
 * The console is a static bundle that talks to one API, so the pair here is
 * small: the real Vite dev server, and the deterministic fixture reporting
 * API in `e2e/fixture-api.ts` that Vite proxies `/api` to. Nothing about the
 * console is stubbed — the same bundle, the same design system, the same
 * parsing — only the rows it is given.
 *
 * Ports are overridable so a second checkout (a worktree) never reuses this
 * one's servers, the same convention `apps/web/playwright.config.ts` uses.
 *
 *   pnpm --filter @pen/admin e2e
 */

const apiPort = process.env.PEN_ADMIN_FIXTURE_PORT ?? '4210';
const webPort = process.env.PEN_ADMIN_E2E_PORT ?? '5274';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  /** One worker: the fixture server carries a mode, and two specs switching it would fight. */
  workers: 1,
  reporter: [['list']],
  use: {
    // `localhost`, not `127.0.0.1`: Vite 8 binds the loopback name and
    // resolves it to ::1 here, so the v4 literal never answers.
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Run directly rather than through `pnpm exec`: a wrapper leaves the
      // real server behind when Playwright kills the shell, and the next run
      // then reuses a process nobody owns.
      command: 'node --import tsx e2e/fixture-api.ts',
      url: `http://127.0.0.1:${apiPort}/__fixture`,
      reuseExistingServer: !process.env.CI,
      env: { PEN_ADMIN_FIXTURE_PORT: apiPort },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `node_modules/.bin/vite --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      env: { PEN_API_PORT: apiPort },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
