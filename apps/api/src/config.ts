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

  PEN_LLM_PROVIDER: z.enum(['openai', 'openai-compatible', 'fake']).default('openai'),
  PEN_LLM_MODEL: z.string().default('gpt-5.6-luna'),
  PEN_LLM_OUTLINE_MODEL: z.string().default('gpt-5.6-luna'),
  PEN_LLM_BASE_URL: z.string().url().optional(),
  PEN_LLM_SERVICE_TIER: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  OPENAI_API_KEY_FREE: z.string().optional(),
  OPENAI_API_KEY_PLUS: z.string().optional(),
  OPENAI_API_KEY_CLASSROOM: z.string().optional(),

  PEN_TTS_PROVIDER: z.enum(['fish-cloud', 'fish-bridge', 'silent']).default('fish-cloud'),
  FISH_AUDIO_API_KEY: z.string().optional(),
  FISH_AUDIO_MODEL: z.string().default('s2.1-pro'),
  PEN_TTS_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8310'),
  /** JSON: catalog voice id → engine voice (Fish reference id or bridge profile). */
  PEN_VOICE_MAP: z.string().default('{}'),
  PEN_VOICE_DEFAULT: z.string().default(''),

  PEN_STT_PROVIDER: z.enum(['browser', 'ws-relay', 'deepgram', 'assemblyai']).default('browser'),
  PEN_STT_RELAY_URL: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),

  TAVILY_API_KEY: z.string().optional(),
  EXA_API_KEY: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),

  /** Dev only: force a plan for anonymous participants (e.g. classroom) to exercise gated features. */
  PEN_DEV_PLAN: z.enum(['free', 'plus', 'classroom']).optional(),
  PEN_ADS_EVERY_SEGMENTS: z.coerce.number().int().positive().default(3),
});

export type Config = z.infer<typeof Env> & { voiceMap: Record<string, string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const cfg = parsed.data;
  let voiceMap: Record<string, string> = {};
  try {
    voiceMap = z.record(z.string(), z.string()).parse(JSON.parse(cfg.PEN_VOICE_MAP));
  } catch {
    throw new Error('PEN_VOICE_MAP must be a JSON object of voiceId to engine voice');
  }
  if (cfg.NODE_ENV === 'production') {
    if (cfg.PEN_TTS_PROVIDER === 'silent')
      throw new Error('PEN_TTS_PROVIDER=silent is not allowed in production');
    if (cfg.PEN_LLM_PROVIDER === 'fake')
      throw new Error('PEN_LLM_PROVIDER=fake is not allowed in production');
    if (cfg.PEN_DEV_PLAN) throw new Error('PEN_DEV_PLAN is not allowed in production');
  }
  return { ...cfg, voiceMap };
}
