import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot. A missing
 * required value fails fast with a readable message instead of a runtime
 * surprise three requests later.
 */
export const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PEN_PORT: z.coerce.number().int().positive().default(4000),
  PEN_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  PEN_API_URL: z.string().url().default('http://localhost:4000'),
  PEN_JWT_SECRET: z.string().min(32, 'PEN_JWT_SECRET must be at least 32 characters'),
  PEN_DATA_DIR: z.string().default('.pen-data'),
  /** pglite://<dir> | pglite://memory | postgres://… */
  DATABASE_URL: z.string().default('pglite://.pen-data/db'),

  PEN_LLM_PROVIDER: z.enum(['openai', 'openai-compatible', 'fake']).default('openai'),
  PEN_LLM_MODEL: z.string().trim().min(1).max(120).default('gpt-5.6-luna'),
  PEN_LLM_OUTLINE_MODEL: z.string().trim().min(1).max(120).default('gpt-5.6-luna'),
  PEN_LLM_BASE_URL: z.string().url().optional(),
  /**
   * Session thumbnails (ADR-0021). One `gpt-image-1` generation per session,
   * always at 1536 × 1024 — the largest landscape the model offers, and the
   * single source every rendered size is downscaled from.
   *
   * Quality is the only knob, and `low` is the default on purpose: measured
   * against the real endpoint it is 400 image tokens (≈ $0.0163, ~11 s)
   * against `medium`'s 1568 (≈ $0.063, ~18 s), and at the width a card is
   * actually read at the two are not tellable apart. Raise it here if that
   * ever stops being true.
   */
  PEN_IMAGE_MODEL: z.string().trim().min(1).max(120).default('gpt-image-1'),
  PEN_THUMBNAIL_QUALITY: z.enum(['low', 'medium', 'high']).default('low'),
  PEN_LLM_SERVICE_TIER: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  /**
   * One key per plan, chosen by the HOST'S plan when the room builds its model,
   * and never falling back to one another: that is how spend is attributed and
   * how one tier's rate limit is kept from eating another's. `checkProviders`
   * refuses to start without all three.
   */
  OPENAI_API_KEY_FREE: z.string().optional(),
  OPENAI_API_KEY_STANDARD: z.string().optional(),
  OPENAI_API_KEY_PROFESSIONAL: z.string().optional(),
  /**
   * The platform's own work, which belongs to no learner: thumbnails,
   * backfills, probes. Charging a plan key for these would put one learner's
   * budget behind another's session card. Optional — absent, that work has no
   * key and the caller must say so.
   */
  OPENAI_API_KEY_PLATFORM: z.string().optional(),

  /**
   * Who classifies a learner utterance the local heuristics cannot place
   * (`packages/session-engine/src/intent.ts`). `model` is the composing model
   * doing it as a structured-output call, which is what it has always been;
   * `jev` puts a hosted decisions model in front, and falls back to `model`
   * on any error, timeout or answer it is not sure enough about.
   *
   * `jev` is the default (ADR-0025): the hosted classifier is what decides an
   * ambiguous turn, and the session model stays underneath it as the floor.
   * Without `OPENROUTER_API_KEY` the room quietly uses the model path, so a
   * deployment that has no key still behaves exactly as it did.
   */
  PEN_INTENT_PROVIDER: z.enum(['model', 'jev']).default('jev'),
  /**
   * Pinned: TypeSafe's own console also lists `typesafe/jev-latest`, but
   * OpenRouter rejects that id.
   */
  PEN_INTENT_MODEL: z.string().trim().min(1).max(120).default('typesafe/jev-1.13'),
  /**
   * OpenRouter, not OpenAI: the decisions endpoint is a different gateway and
   * a different account, and the per-plan OpenAI keys are never reused for it
   * (spend attribution and rate limits both depend on that separation).
   */
  OPENROUTER_API_KEY: z.string().optional(),
  /**
   * TypeSafe's own key, for TypeSafe's own endpoint.
   *
   * When it is set the room talks to `api.typesafe.ai` directly and
   * `OPENROUTER_API_KEY` is not used for intent at all — one hop fewer, one
   * account fewer, and the gateway's markup gone. It wins over the gateway
   * when both are present, because the gateway only ever existed to reach this
   * model.
   *
   * The model id changes with the route (`TYPESAFE_DIRECT_MODEL`, and the
   * comment there says why), which is why `PEN_INTENT_MODEL` is not consulted
   * on the direct path: pointing a pinned OpenRouter id at TypeSafe is a 400,
   * and the one place that pairing can be got right is where the route is
   * chosen.
   */
  PEN_TYPESAFE_API_KEY: z.string().optional(),

  PEN_TTS_PROVIDER: z.enum(['fish-cloud', 'fish-bridge', 'silent']).default('fish-cloud'),
  FISH_AUDIO_API_KEY: z.string().optional(),
  FISH_AUDIO_MODEL: z.string().trim().min(1).max(120).default('s2.1-pro'),
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

  /**
   * Who may read and change the runtime configuration (ADR-0025): a
   * comma-separated list of the Google addresses that are allowed into
   * `/api/admin/runtime-config` and the Settings screen behind it. Unset
   * means nobody — the routes answer 403 and the screen is not offered, so a
   * deployment that never configures this cannot have its providers switched
   * by whoever happens to hold a bearer token.
   */
  PEN_ADMIN_EMAILS: z.string().optional(),
  /**
   * How often the API re-reads the stored runtime configuration. One small
   * indexed read per interval per process; every flag read in between is an
   * in-memory lookup. 0 reads once at boot and never again.
   */
  PEN_RUNTIME_CONFIG_POLL_MS: z.coerce.number().int().nonnegative().default(15_000),

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
  /**
   * Sentry Cron Monitor slug the API checks in to every `SENTRY_CRON_INTERVAL_MINUTES`
   * (`pen-api-heartbeat` in production). Unset = no heartbeat. A process that dies,
   * hangs, or loses its database stops checking in, and Sentry opens an issue one
   * interval + margin later — see docs/RUNBOOK.md → "Alerting".
   */
  SENTRY_CRON_MONITOR_SLUG: z.string().min(1).max(50).optional(),
  SENTRY_CRON_INTERVAL_MINUTES: z.coerce.number().int().positive().max(60).default(5),

  /** MP4 export: ffmpeg binary (PATH lookup by default) and an optional system Chromium for Playwright. */
  PEN_FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  PEN_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Extra Chromium flags for the renderer, space separated (Docker: `--disable-dev-shm-usage`). */
  PEN_CHROMIUM_ARGS: z.string().optional(),
  /** Where the renderer opens the replay page; defaults to PEN_PUBLIC_URL (set to the internal web origin in Docker). */
  PEN_RENDER_BASE_URL: z.string().url().optional(),

  /** Dev only: force a plan for anonymous participants (e.g. classroom) to exercise gated features. */
  PEN_DEV_PLAN: z.enum(['free', 'standard', 'professional']).optional(),
  PEN_ADS_EVERY_SEGMENTS: z.coerce.number().int().positive().max(50).default(3),
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
  PEN_AD_ECPM_USD: z.coerce.number().nonnegative().max(1_000).default(8),

  /**
   * Spend circuit breaker (ADR-0016): the most provider spend one UTC day may
   * cost, summed from the day's telemetry cost lines. Past it, new free-plan
   * sessions are held back (503 CAPACITY) while paid plans continue to
   * `PEN_DAILY_SPEND_PAID_MULTIPLE ×` the cap. 0 disables the breaker.
   */
  PEN_DAILY_SPEND_CAP_USD: z.coerce.number().nonnegative().max(100_000).default(25),
  /** How far past the cap paying learners keep going before anyone is held back. */
  PEN_DAILY_SPEND_PAID_MULTIPLE: z.coerce.number().min(1).max(100).default(3),

  /**
   * Lesson voice store (ADR-0017): the audio of a lesson's sentences, kept
   * beside the lesson under `PEN_DATA_DIR/lesson-voice`, so the second learner
   * of a topic pays for neither the words (the memo) nor the voice. Only the
   * taught lesson is stored; questions, answers and check-in verdicts are
   * spoken fresh for every learner and never written down.
   *
   * On by default. Measured with real Fish (`s2.1-pro-free`) teaching the same
   * topic twice: the second telling took its voice from here, and the audio is
   * the same audio — the stored sentence came back byte for byte identical
   * (610,294 bytes, 6.919 s), on a contiguous clock with no discontinuities.
   * Time to first audio went from 107.6 s (the free tier queueing) to 106 ms.
   * 0 turns it off.
   */
  PEN_TTS_CACHE_MB: z.coerce.number().int().nonnegative().max(1_048_576).default(2048),

  /** Live sessions one IP may host at once; a script cannot open rooms without bound. */
  PEN_MAX_SESSIONS_PER_IP: z.coerce.number().int().positive().max(1_000).default(5),
  /**
   * Statistics and reports (ADR-0027). `PEN_ADMIN_EMAILS` above is the same
   * list the operations console uses (ADR-0026) — one set of people who may
   * see `/api/admin/*`, not two. `PEN_ADMIN_TOKEN` is the machine equivalent,
   * for a scheduled export or a probe, and is ignored below 32 characters.
   */
  PEN_ADMIN_TOKEN: z.string().optional(),
  /**
   * Count visits — including visitors who never sign in — and the engaged
   * time they spend. 0 turns the ingest off entirely: `POST /api/visits`
   * still answers, and writes nothing.
   */
  PEN_VISIT_STATS: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * Read `CF-IPCountry` / `X-Geo-Country` / `X-Geo-Region` / `X-Geo-City`
   * from the proxy in front of us. Off by default, and it must stay off
   * unless the edge really does set them and strips what a client sent:
   * otherwise a visitor can choose their own country. Today nothing in
   * `deploy/` sets them, so the country comes from the browser's own
   * timezone and every row says so (`site_visits.geo_source`).
   */
  PEN_TRUST_GEO_HEADERS: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * How many days a visit keeps the two identifiers on it — the client
   * address and the raw `User-Agent` (ADR-0028). An hourly sweep clears both
   * from older rows and leaves every derived column and every count
   * standing, so the statistics are permanent and the identifiers are not.
   *
   * The default is 30 because that is the dashboard's own default window
   * (`DEFAULT_WINDOW_MS` in `stats/routes.ts`): the identifiers outlive the
   * period anybody actually looks at, and nothing more.
   *
   * **0 means neither is ever written**, and the sweep then erases every one
   * already stored — the honest way to turn this back off.
   */
  PEN_VISIT_IDENTIFIER_DAYS: z.coerce.number().int().nonnegative().max(400).default(30),

  /** Largest JSON body any route accepts. Every route here is small; 64 KB is generous. */
  PEN_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(4096)
    .max(1_048_576)
    .default(64 * 1024),
});

export type Config = z.infer<typeof Env>;

/**
 * Which variables the environment actually set, per config object.
 *
 * A runtime setting has three tiers — environment variable, stored document,
 * compiled-in default (ADR-0025) — and the first of them only exists if we can
 * tell "the operator pinned this on this box" apart from "zod filled in the
 * default". `Config` cannot: by the time it is parsed both look identical. So
 * `loadConfig` remembers the raw, explicitly-present values beside the config
 * it returns, keyed weakly so a discarded config takes its pins with it.
 *
 * Deliberately a side table rather than a field on `Config`: the config object
 * is spread, logged and handed to every service, and a pin map riding along
 * inside it would be copied into places that must not act on it.
 */
const PINS = new WeakMap<Config, Readonly<Record<string, string>>>();

/**
 * The environment variables that were explicitly set for this config — never
 * the ones zod defaulted. Empty for a config that was built by spreading
 * another one, which is exactly right: a spread value is not an operator pin.
 */
export function pinnedEnv(cfg: Config): Readonly<Record<string, string>> {
  return PINS.get(cfg) ?? {};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in a .env means "unset", not "empty string".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string>;
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const cfg = parsed.data;
  // Only variables this schema knows about. `cleaned` is the whole process
  // environment — every provider key, the Stripe secret, the JWT secret — and
  // a pin table that holds those is one careless log line away from printing
  // them. Nothing needs them here: a pin is only ever looked up by setting name.
  PINS.set(
    cfg,
    Object.freeze(Object.fromEntries(Object.entries(cleaned).filter(([key]) => key in Env.shape))),
  );
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
