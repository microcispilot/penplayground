import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against fake providers: the API runs with a scripted model and a
 * silent synthesizer, so the whole loop (home → room → cues → question → end)
 * is exercised deterministically without keys.
 */
/**
 * The suite runs on checkouts with no `.env` (CI, a fresh clone), so every test API is
 * given its own throwaway signing secret rather than inheriting a real one.
 */
const E2E_JWT_SECRET = process.env.PEN_JWT_SECRET ?? 'e2e-only-secret-not-for-production-32+';
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
/**
 * A fourth pair for `timeline.spec.ts`: the owner's in-session flow, which
 * needs ads on *and* a pipeline of its own. The ad it waits for sits after the
 * second segment, and a room that is the third lesson of a shared API can take
 * long enough getting there to make the wait look like a product failure.
 */
const timelineApiPort = process.env.PEN_E2E_TIMELINE_API_PORT ?? '4024';
const timelineWebPort = process.env.PEN_E2E_TIMELINE_WEB_PORT ?? '5185';
/** The production build, served by `vite preview`: where load performance is measured. */
const previewPort = process.env.PEN_E2E_PREVIEW_PORT ?? '5184';

/**
 * Specs that play media after a lesson, and so need real Chrome (see the
 * `projects` note below). Any spec may still be run in either browser
 * explicitly with `--project=chromium` / `--project=chrome`.
 */
const MEDIA_AFTER_LESSON = ['**/ads.spec.ts', '**/ui-replay.spec.ts', '**/timeline.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  /**
   * `base-path.spec.ts` belongs to playwright.basepath.config.ts and only to it: it needs the
   * bundle built with `PEN_BASE_PATH` and served behind nginx with the prefix stripped, which
   * none of the servers below do. Run here it would not merely fail — it would start a lesson on
   * the shared API on its way to failing, and the specs that follow share that one pipeline.
   */
  testIgnore: ['base-path.spec.ts'],
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
  /**
   * Two browsers, each running the specs it can actually serve.
   *
   * Everything runs on the full Chromium build (the headless shell crashes on
   * AudioWorklet + fake audio devices) — except the specs that must *play*
   * media after a lesson has been taught. Once a room has been opened, that
   * Chromium stops rendering media for the rest of the browser: an `<audio>`
   * element sits at `HAVE_METADATA` and `play()` never settles, on that page
   * and on any new one. The same build of real Chrome is unaffected, across
   * repeated runs (bisected and recorded in tasks/todo.md). An ad and a replay
   * both come after a lesson, so those two specs get real Chrome and the
   * product's own media path is exercised rather than a browser bug.
   */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
      testIgnore: MEDIA_AFTER_LESSON,
    },
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
      testMatch: MEDIA_AFTER_LESSON,
    },
  ],
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
        PEN_JWT_SECRET: E2E_JWT_SECRET,
        // Each e2e API gets its own in-memory database: two processes on one PGlite dir abort.
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        /*
         * Free-plan video ads at the first boundary (the fake lesson has three
         * segments). Google's public sample tag is the default and the only
         * mode that works today.
         *
         * `PEN_E2E_AD_FIXTURE=1` points the SDK at the VAST fixture this API
         * serves itself (`/api/dev/ad/vast.xml`), which would make the creative
         * deterministic — but it needs the page on **https** first. Measured:
         * the SDK requests the tag from inside its own frame, that frame
         * mirrors the page's scheme, and Chrome refuses an insecure public
         * origin reaching a loopback address at all ("the request client is not
         * a secure context and the resource is in more-private address space
         * `loopback`", IMA error 1005 FAILED_TO_REQUEST_ADS). See tasks/todo.md.
         */
        ...(process.env.PEN_E2E_AD_FIXTURE === '1'
          ? { PEN_AD_TAG_URL: `https://localhost:${webPort}/api/dev/ad/vast.xml` }
          : { PEN_AD_TEST_TAGS: '1' }),
        PEN_PUBLIC_URL: `http://localhost:${webPort}`,
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
        PEN_JWT_SECRET: E2E_JWT_SECRET,
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
        PEN_JWT_SECRET: E2E_JWT_SECRET,
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        // The UI specs teach a lesson each and several leave the room live on
        // purpose (a dropped connection, a screenshot mid-sentence), so they
        // run past the production cap of 5 live rooms per address and every
        // later spec gets `RATE_LIMITED` instead of a board. The cap itself is
        // covered by services/api/test/limits.test.ts.
        PEN_MAX_SESSIONS_PER_IP: '50',
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
      command: 'pnpm --filter @pen/api start',
      url: `http://127.0.0.1:${timelineApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PEN_PORT: timelineApiPort,
        PEN_PUBLIC_URL: `http://localhost:${timelineWebPort}`,
        PEN_LLM_PROVIDER: 'fake',
        PEN_TTS_PROVIDER: 'silent',
        PEN_DATA_DIR: '.pen-data-e2e-timeline',
        PEN_JWT_SECRET: E2E_JWT_SECRET,
        DATABASE_URL: 'pglite://memory',
        PEN_LOG_LEVEL: 'warn',
        PEN_AD_TEST_TAGS: '1',
        PEN_ADS_EVERY_SEGMENTS: '1',
        PEN_MAX_SESSIONS_PER_IP: '50',
      },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @pen/web exec vite --port ${timelineWebPort} --strictPort`,
      url: `http://localhost:${timelineWebPort}`,
      env: { PEN_API_PORT: timelineApiPort },
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
