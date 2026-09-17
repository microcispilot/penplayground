import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against fake providers: the API runs with a scripted model and a
 * silent synthesizer, so the whole loop (home → room → cues → question → end)
 * is exercised deterministically without keys.
 */
const apiPort = process.env.PEN_API_PORT ?? '4010';
// Both ports are overridable so the suite can run next to a dev server (or another checkout's)
// without reusing it: PEN_API_PORT=4410 PEN_WEB_PORT=5183 pnpm --filter @pen/web e2e
const webPort = process.env.PEN_WEB_PORT ?? '5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${webPort}`,
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
        PEN_DATA_DIR: '.pen-data-e2e',
        PEN_LOG_LEVEL: 'warn',
      },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @pen/web exec vite --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      env: { PEN_API_PORT: apiPort },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
