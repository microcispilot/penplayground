import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot. A missing
 * required value fails fast with a readable message instead of a runtime
 * surprise three requests later.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PEN_PORT: z.coerce.number().int().positive().default(4000),
  PEN_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  PEN_API_URL: z.string().url().default('http://localhost:4000'),
  PEN_JWT_SECRET: z.string().min(32, 'PEN_JWT_SECRET must be at least 32 characters'),
  PEN_DATA_DIR: z.string().default('.pen-data'),
  /** pglite://<dir> | pglite://memory | postgres://… */
  DATABASE_URL: z.string().default('pglite://.pen-data/db'),

  PEN_LLM_PROVIDER: z.enum(['openai', 'openai-compatible', 'fake']).default('openai'),
  PEN_LLM_MODEL: z.string().default('gpt-5.6-luna'),
  PEN_LLM_OUTLINE_MODEL: z.string().default('gpt-5.6-luna'),
  PEN_LLM_BASE_URL: z.string().url().optional(),
  PEN_LLM_SERVICE_TIER: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  OPENAI_API_KEY_FREE: z.string().optional(),
  OPENAI_API_KEY_STANDARD: z.string().optional(),
  OPENAI_API_KEY_PROFESSIONAL: z.string().optional(),

  PEN_TTS_PROVIDER: z.enum(['fish-cloud', 'fish-bridge', 'silent']).default('fish-cloud'),
  FISH_AUDIO_API_KEY: z.string().optional(),
  FISH_AUDIO_MODEL: z.string().default('s2.1-pro'),
  PEN_TTS_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8310'),

  PEN_STT_PROVIDER: z.enum(['browser', 'ws-relay', 'deepgram', 'assemblyai']).default('browser'),
  PEN_STT_RELAY_URL: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),

  /** Self-hosted SearXNG origin (e.g. http://127.0.0.1:8080). Free; takes precedence over Tavily/Exa. */
  SEARXNG_URL: z.string().url().optional(),
  TAVILY_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),

  /** Google Identity Services web client id; sign-in is off (and `/api/health` says `google:false`) until set. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().optional(),
  /** Stripe price ids per plan/interval; billing is disabled until all four exist. */
  STRIPE_PRICE_STANDARD_MONTH: z.string().optional(),
  STRIPE_PRICE_STANDARD_YEAR: z.string().optional(),
  STRIPE_PRICE_PROFESSIONAL_MONTH: z.string().optional(),
  STRIPE_PRICE_PROFESSIONAL_YEAR: z.string().optional(),

  /**
   * Human-to-human audio in rooms (self-hosted LiveKit). Off unless all three are set.
   * LIVEKIT_URL is what browsers connect to (wss://DOMAIN/livekit); LIVEKIT_API_URL is how the
   * API reaches the server's HTTP API (http://livekit:7880 inside the stack), derived from
   * LIVEKIT_URL when absent.
   */
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),

  POSTHOG_PROJECT_TOKEN: z.string().optional(),
  POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),

  /** MP4 export: ffmpeg binary (PATH lookup by default) and an optional system Chromium for Playwright. */
  PEN_FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  PEN_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Extra Chromium flags for the renderer, space separated (Docker: `--disable-dev-shm-usage`). */
  PEN_CHROMIUM_ARGS: z.string().optional(),
  /** Where the renderer opens the replay page; defaults to PEN_PUBLIC_URL (set to the internal web origin in Docker). */
  PEN_RENDER_BASE_URL: z.string().url().optional(),

  /** Dev only: force a plan for anonymous participants (e.g. classroom) to exercise gated features. */
  PEN_DEV_PLAN: z.enum(['free', 'standard', 'professional']).optional(),
  PEN_ADS_EVERY_SEGMENTS: z.coerce.number().int().positive().default(3),
  /**
   * Video ad demand (ADR-0014): the Google Ad Manager VAST/VMAP tag for the free plan's in-stream
   * ads (any VAST seller's tag works). Unset → no ads, unless PEN_AD_TEST_TAGS=1 substitutes
   * Google's public IMA sample tag (dev/e2e only; refused in production).
   */
  PEN_AD_TAG_URL: z.string().url().optional(),
  PEN_AD_TEST_TAGS: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /** Estimated net eCPM (USD per 1 000 completed ads) used for the per-session revenue line. */
  PEN_AD_ECPM_USD: z.coerce.number().nonnegative().default(8),

  /**
   * Spend circuit breaker (ADR-0016): the most provider spend one UTC day may
   * cost, summed from the day's telemetry cost lines. Past it, new free-plan
   * sessions are held back (503 CAPACITY) while paid plans continue to
   * `PEN_DAILY_SPEND_PAID_MULTIPLE ×` the cap. 0 disables the breaker.
   */
  PEN_DAILY_SPEND_CAP_USD: z.coerce.number().nonnegative().default(25),
  /** How far past the cap paying learners keep going before anyone is held back. */
  PEN_DAILY_SPEND_PAID_MULTIPLE: z.coerce.number().min(1).default(3),

  /**
   * Synthesis cache (ADR-0017): identical sentences are synthesised once and
   * replayed from `PEN_DATA_DIR/tts-cache` at the same streaming cadence.
   *
   * Opt-in (0 = off) until the interaction recorded in tasks/todo.md is
   * resolved: with the cache on, a *second* session on the same topic — where
   * the lesson also comes from the memo, so nothing waits for the model —
   * delivers audio far enough ahead of playback that the room and the client
   * lose step (stale chunks, and a between-segment ad that never opens).
   * Set `PEN_TTS_CACHE_MB=2048` to enable it; everything it does is tested,
   * and the money it saves is real, but the voice is the product and it does
   * not ship on by default with a known way to disturb it.
   */
  PEN_TTS_CACHE_MB: z.coerce.number().int().nonnegative().default(0),

  /** Live sessions one IP may host at once; a script cannot open rooms without bound. */
  PEN_MAX_SESSIONS_PER_IP: z.coerce.number().int().positive().default(5),
  /** Largest JSON body any route accepts. Every route here is small; 64 KB is generous. */
  PEN_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in a .env means "unset", not "empty string".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.PEN_TTS_PROVIDER === 'silent')
      throw new Error('PEN_TTS_PROVIDER=silent is not allowed in production');
    if (cfg.PEN_LLM_PROVIDER === 'fake')
      throw new Error('PEN_LLM_PROVIDER=fake is not allowed in production');
    if (cfg.PEN_DEV_PLAN) throw new Error('PEN_DEV_PLAN is not allowed in production');
    if (cfg.PEN_AD_TEST_TAGS) throw new Error('PEN_AD_TEST_TAGS is not allowed in production');
  }
  return cfg;
}
