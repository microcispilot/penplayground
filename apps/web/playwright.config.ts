import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against fake providers: the API runs with a scripted model and a
 * silent synthesizer, so the whole loop (home → room → cues → question → end)
 * is exercised deterministically without keys.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @pen/api start',
      url: 'http://127.0.0.1:4000/api/health',
      reuseExistingServer: !process.env.CI,
      env: {
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_DATA_DIR: '.pen-data-e2e',
        PEN_LOG_LEVEL: 'warn',
      },
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @pen/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
