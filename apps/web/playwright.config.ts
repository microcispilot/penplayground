import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against fake providers: the API runs with a scripted model and a
 * silent synthesizer, so the whole loop (home → room → cues → question → end)
 * is exercised deterministically without keys.
 */
const apiPort = process.env.PEN_API_PORT ?? '4010';
/** Both ports are overridable so parallel checkouts (worktrees) never reuse each other's servers. */
const webPort = process.env.PEN_WEB_PORT ?? '5173';
/**
 * A second API/web pair for `rooms.spec.ts`: plan forced to professional (rooms are a
 * Professional feature) and LiveKit pointed at a local `livekit-server --dev` (:7880,
 * key `devkey` / secret `secret`). The spec skips itself when that server is not running;
 * the pair still boots so every run exercises the same config.
 */
const roomsApiPort = process.env.PEN_E2E_ROOMS_API_PORT ?? '4014';
const roomsWebPort = process.env.PEN_E2E_ROOMS_WEB_PORT ?? '5174';
/**
 * A third pair for the UI specs (`ui-*.spec.ts`): screenshots, the replay
 * scrubber and the accessibility sweep. Ads are deliberately off here — the ad
 * pair above exists to exercise them, and an ad overlay in the middle of a
 * screenshot or an axe run is noise, not coverage.
 */
const uiApiPort = process.env.PEN_E2E_UI_API_PORT ?? '4023';
const uiWebPort = process.env.PEN_E2E_UI_WEB_PORT ?? '5183';
/** The production build, served by `vite preview`: where load performance is measured. */
const previewPort = process.env.PEN_E2E_PREVIEW_PORT ?? '5184';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  /**
   * One worker: every spec drives the same API process, the same in-memory
   * database and the same room registry, so two specs teaching at once fight
   * over the one model/voice pipeline and blow each other's latency budgets.
   */
  workers: 1,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // A local TURN server is on 127.0.0.1, and Chrome silently drops ICE servers on a
        // loopback address without this (rooms-turn.spec.ts). Local testing only.
        '--allow-loopback-in-peer-connection',
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
        // Each e2e API gets its own in-memory database: two processes on one PGlite dir abort.
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        // Free-plan video ads against Google's public IMA sample tag, at the first boundary
        // (the fake lesson has three segments) — see e2e/ads.spec.ts.
        PEN_AD_TEST_TAGS: '1',
        PEN_ADS_EVERY_SEGMENTS: '1',
        // Every spec starts its sessions from 127.0.0.1, and some leave the
        // room live on purpose; the production per-IP cap (5) would refuse the
        // later ones. The cap itself is covered by services/api/test/limits.test.ts.
        PEN_MAX_SESSIONS_PER_IP: '50',
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
    {
      command: 'pnpm --filter @pen/api start',
      url: `http://127.0.0.1:${roomsApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PEN_PORT: roomsApiPort,
        PEN_PUBLIC_URL: `http://localhost:${roomsWebPort}`,
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_DATA_DIR: '.pen-data-e2e-rooms',
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        PEN_DEV_PLAN: 'professional',
        PEN_MAX_SESSIONS_PER_IP: '50',
        LIVEKIT_URL: process.env.PEN_E2E_LIVEKIT_URL ?? 'ws://127.0.0.1:7880',
        LIVEKIT_API_KEY: process.env.PEN_E2E_LIVEKIT_API_KEY ?? 'devkey',
        // `livekit-server --dev` uses "secret"; deploy/livekit/livekit.dev.yaml (the TURN
        // configuration rooms-turn.spec.ts needs) uses a 32-character one, which LiveKit requires.
        LIVEKIT_API_SECRET: process.env.PEN_E2E_LIVEKIT_API_SECRET ?? 'secret',
      },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @pen/web exec vite --port ${roomsWebPort} --strictPort`,
      url: `http://localhost:${roomsWebPort}`,
      env: { PEN_API_PORT: roomsApiPort },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @pen/api start',
      url: `http://127.0.0.1:${uiApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PEN_PORT: uiApiPort,
        PEN_PUBLIC_URL: `http://localhost:${uiWebPort}`,
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_DATA_DIR: '.pen-data-e2e-ui',
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
      },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @pen/web exec vite --port ${uiWebPort} --strictPort`,
      url: `http://localhost:${uiWebPort}`,
      env: { PEN_API_PORT: uiApiPort },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @pen/web build && pnpm --filter @pen/web exec vite preview --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      env: { PEN_API_PORT: uiApiPort },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
