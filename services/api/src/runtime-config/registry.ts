import type { RuntimeSettingKind, RuntimeSettingScope, RuntimeSettingValue } from '@pen/contracts';
import type { z } from 'zod';
import { type Config, Env } from '../config.js';

/**
 * The settings a running deployment may change without a deploy (ADR-0025).
 *
 * Three things are deliberately NOT repeated here:
 *
 *  - **The default.** It is the `.default()` already on the environment
 *    schema, so "what the product does with no override" has exactly one
 *    definition and the dashboard shows the same number the code runs on.
 *  - **The validation.** A stored value is parsed by the very schema the
 *    environment variable is parsed by, so the database cannot hold a value
 *    the environment would have refused at boot.
 *  - **The identifier.** A setting is named by its environment variable. One
 *    name in the code, in the document, in the audit trail, in the telemetry
 *    and on the screen — nothing to map, nothing to drift.
 *
 * What is here is the part a schema cannot say: what the setting means, which
 * group it belongs to on the screen, and — the load-bearing one — *when* a
 * change to it reaches the product.
 */
interface SettingDefinition {
  label: string;
  description: string;
  group: string;
  /** When a change lands. `session` values are read once as a room is built. */
  scope: RuntimeSettingScope;
  /** Inclusive bounds for a number, refused before the value is ever stored. */
  min?: number;
  max?: number;
}

/**
 * Every entry's key is a field of `Config`, which is what makes
 * `store.get(name)` return the same type the config field has.
 */
export const SETTINGS = {
  // ── who does the thinking ────────────────────────────────────────────────
  PEN_INTENT_PROVIDER: {
    label: 'Intent provider',
    description:
      'Who classifies a learner turn the local heuristics cannot place. `jev` puts the hosted decisions model in front and keeps the session model underneath it as the fallback; `model` is the session model alone. Read once when a room is built.',
    group: 'Thinking',
    scope: 'session',
  },
  PEN_INTENT_MODEL: {
    label: 'Intent model',
    description:
      'The hosted decisions model id used when the intent provider is `jev`. OpenRouter ids only.',
    group: 'Thinking',
    scope: 'session',
  },
  PEN_LLM_PROVIDER: {
    label: 'Language-model provider',
    description:
      'Where composing calls go. `fake` serves scripted demo lessons and is refused in production. The adapters are built at boot, so a change here needs a restart.',
    group: 'Thinking',
    scope: 'restart',
  },
  PEN_LLM_MODEL: {
    label: 'Session model',
    description:
      'The model that teaches: plan, segments, answers. Read once when a room is built, so a change never lands mid-lesson.',
    group: 'Thinking',
    scope: 'session',
  },
  PEN_LLM_OUTLINE_MODEL: {
    label: 'Outline model',
    description:
      'The cheaper model behind outlines and session-card copy. Read when the background card job is enqueued.',
    group: 'Thinking',
    scope: 'session',
  },
  PEN_LLM_SERVICE_TIER: {
    label: 'Provider service tier',
    description:
      'OpenAI service tier for composing calls. `unset` sends no tier at all, which is the account default. Baked into the model adapters at boot.',
    group: 'Thinking',
    scope: 'restart',
  },

  // ── how it sounds and listens ────────────────────────────────────────────
  PEN_TTS_PROVIDER: {
    label: 'Voice provider',
    description:
      'Which synthesis engine speaks. `silent` makes the expert inaudible and is refused in production. The engine is built at boot.',
    group: 'Voice',
    scope: 'restart',
  },
  FISH_AUDIO_MODEL: {
    label: 'Fish Audio model',
    description: 'The Fish Audio synthesis model id. Built into the engine at boot.',
    group: 'Voice',
    scope: 'restart',
  },
  PEN_STT_PROVIDER: {
    label: 'Speech recognition',
    description:
      'Who transcribes the learner. `browser` keeps it on the device and costs nothing. The recognizer factory is built at boot.',
    group: 'Voice',
    scope: 'restart',
  },
  PEN_TTS_CACHE_MB: {
    label: 'Lesson voice store (MB)',
    description:
      'Ceiling for the audio of already-taught lessons, so the second learner of a topic pays for neither the words nor the voice. 0 turns it off. The store is opened at boot.',
    group: 'Voice',
    scope: 'restart',
    min: 0,
    max: 1_048_576,
  },

  // ── session cards ────────────────────────────────────────────────────────
  PEN_IMAGE_MODEL: {
    label: 'Picture model',
    description: 'The image model behind session-card photographs.',
    group: 'Session cards',
    scope: 'session',
  },
  PEN_THUMBNAIL_QUALITY: {
    label: 'Picture quality',
    description:
      'Generation quality for a session card. `low` is ~400 image tokens against `medium`’s 1568, and at the width a card is read at the two are not tellable apart.',
    group: 'Session cards',
    scope: 'session',
  },

  // ── what a day may cost ──────────────────────────────────────────────────
  PEN_DAILY_SPEND_CAP_USD: {
    label: 'Daily spend cap (USD)',
    description:
      'The most provider spend one UTC day may cost before new free-plan sessions are held back. 0 disables the breaker. Read on every session-creation check.',
    group: 'Cost',
    scope: 'request',
    min: 0,
    max: 100_000,
  },
  PEN_DAILY_SPEND_PAID_MULTIPLE: {
    label: 'Paid plans keep going to',
    description: 'How many times the cap paying learners reach before anyone is held back.',
    group: 'Cost',
    scope: 'request',
    min: 1,
    max: 100,
  },

  // ── ads ──────────────────────────────────────────────────────────────────
  PEN_ADS_EVERY_SEGMENTS: {
    label: 'Ad every N segments',
    description:
      'How often a free-plan lesson breaks for a video ad. Read once when a room is built, so a lesson keeps the cadence it started with.',
    group: 'Ads',
    scope: 'session',
    min: 1,
    max: 50,
  },
  PEN_AD_ECPM_USD: {
    label: 'Estimated eCPM (USD)',
    description:
      'Net revenue per 1 000 completed ads, used for the per-session revenue estimate. Ad Manager reporting is the source of truth; this only prices the estimate.',
    group: 'Ads',
    scope: 'session',
    min: 0,
    max: 1_000,
  },

  // ── limits ───────────────────────────────────────────────────────────────
  PEN_MAX_SESSIONS_PER_IP: {
    label: 'Live sessions per IP',
    description:
      'How many live sessions one address may host at once. Read on every session-creation request, so it can be tightened during an incident.',
    group: 'Limits',
    scope: 'request',
    min: 1,
    max: 1_000,
  },
  PEN_MAX_BODY_BYTES: {
    label: 'Largest JSON body (bytes)',
    description:
      'The biggest request body any route accepts. Bounded here so a wrong value cannot make every write fail.',
    group: 'Limits',
    scope: 'request',
    min: 4_096,
    max: 1_048_576,
  },
} as const satisfies Record<string, SettingDefinition>;

/**
 * Every other environment variable, and why it is not a setting (ADR-0025).
 *
 * This exists so the decision cannot rot. `runtime-config.test.ts` asserts
 * that `SETTINGS` and this together account for the environment schema
 * exactly — so a new variable added to `config.ts` fails the build until
 * somebody has said, in one word, which side of the line it is on. The
 * alternative is a list in a document that quietly stops being true.
 */
export const NOT_SETTINGS = {
  // Secrets and credentials. A console that can read them is a console that can leak them.
  PEN_JWT_SECRET: 'secret',
  OPENAI_API_KEY_FREE: 'secret',
  OPENAI_API_KEY_STANDARD: 'secret',
  OPENAI_API_KEY_PROFESSIONAL: 'secret',
  OPENAI_API_KEY_PLATFORM: 'secret',
  OPENROUTER_API_KEY: 'secret',
  PEN_TYPESAFE_API_KEY: 'secret',
  PEN_SMTP_PASSWORD: 'secret',
  PEN_AUTH_HMAC_SECRET: 'secret',
  FISH_AUDIO_API_KEY: 'secret',
  DEEPGRAM_API_KEY: 'secret',
  ASSEMBLYAI_API_KEY: 'secret',
  TAVILY_API_KEY: 'secret',
  EXA_API_KEY: 'secret',
  GOOGLE_CLIENT_ID: 'secret',
  STRIPE_SECRET_KEY: 'secret',
  STRIPE_WEBHOOK_SECRET: 'secret',
  STRIPE_PORTAL_CONFIGURATION_ID: 'secret',
  STRIPE_PRICE_STANDARD_MONTH: 'secret',
  STRIPE_PRICE_STANDARD_YEAR: 'secret',
  STRIPE_PRICE_PROFESSIONAL_MONTH: 'secret',
  STRIPE_PRICE_PROFESSIONAL_YEAR: 'secret',
  LIVEKIT_API_KEY: 'secret',
  LIVEKIT_API_SECRET: 'secret',
  POSTHOG_PROJECT_TOKEN: 'secret',
  SENTRY_DSN: 'secret',
  // The machine's way into the reports (ADR-0027). A console that could set
  // it is a console whose reader can mint themselves a permanent key.
  PEN_ADMIN_TOKEN: 'secret',

  // A wrong value here loses data that cannot be got back.
  DATABASE_URL: 'data-loss',
  PEN_DATA_DIR: 'data-loss',

  // Where this box is, not what the product does.
  // Where the mail goes out through, not what the product does. A console that
  // could repoint the relay is a console that could redirect every
  // verification code to a mailbox of its own choosing.
  PEN_SMTP_HOST: 'address',
  PEN_SMTP_PORT: 'address',
  PEN_SMTP_USERNAME: 'address',
  PEN_SMTP_FROM: 'address',
  PEN_PORT: 'address',
  PEN_PUBLIC_URL: 'address',
  PEN_API_URL: 'address',
  PEN_LLM_BASE_URL: 'address',
  PEN_TTS_BRIDGE_URL: 'address',
  PEN_STT_RELAY_URL: 'address',
  SEARXNG_URL: 'address',
  LIVEKIT_URL: 'address',
  LIVEKIT_API_URL: 'address',
  PEN_AD_TAG_URL: 'address',
  PEN_FFMPEG_PATH: 'address',
  PEN_CHROMIUM_PATH: 'address',
  PEN_CHROMIUM_ARGS: 'address',
  PEN_RENDER_BASE_URL: 'address',
  POSTHOG_HOST: 'address',
  // Whether the proxy in front of this box sets geo headers and strips what a
  // client sent (ADR-0027). A fact about the network, and one that decides
  // whether a visitor can choose their own country — not a preference.
  PEN_TRUST_GEO_HEADERS: 'address',

  // Self-referential: a setting that governs where settings come from, how
  // often they are read, or who may change them cannot be changed from there.
  PEN_ADMIN_EMAILS: 'self-referential',
  PEN_RUNTIME_CONFIG_POLL_MS: 'self-referential',

  // Alerting must not depend on the store it would be alerting about.
  SENTRY_CRON_MONITOR_SLUG: 'alerting',
  SENTRY_CRON_INTERVAL_MINUTES: 'alerting',
  SENTRY_ENVIRONMENT: 'alerting',

  // Development affordances `loadConfig` already refuses in production. A
  // stored value arrives after that check runs, so this would be a way round it.
  NODE_ENV: 'environment',
  PEN_DEV_PLAN: 'development-only',
  PEN_AD_TEST_TAGS: 'development-only',

  // What the product collects about people (ADR-0027). Turning visit
  // statistics back on is a decision about the privacy policy, taken
  // deliberately and deployed — not a switch somebody flips while reading a
  // dashboard. Off is always one deploy away; on should be too.
  PEN_VISIT_STATS: 'privacy',
  // How long a visit keeps an address and a raw User-Agent (ADR-0028). The
  // same argument: a retention period is a promise about people's data, and
  // a promise that can be lengthened from a dashboard is not one. Shortening
  // it is a deploy, and the sweep applies the new period within the hour.
  PEN_VISIT_IDENTIFIER_DAYS: 'privacy',
} as const satisfies Partial<Record<keyof Config, string>>;

export type RuntimeSettingName = keyof typeof SETTINGS & keyof Config;

export const SETTING_NAMES = Object.keys(SETTINGS) as RuntimeSettingName[];

/** Group order on the screen: what the product does, then what it costs, then what it refuses. */
export const GROUP_ORDER = ['Thinking', 'Voice', 'Session cards', 'Cost', 'Ads', 'Limits'] as const;

/**
 * The value an optional choice takes when nothing is chosen. A `<select>`
 * cannot offer "no value", and `PEN_LLM_SERVICE_TIER` genuinely has one, so
 * the screen offers this and the store turns it back into `undefined`.
 */
export const UNSET = 'unset';

/** Peel `.default()` / `.optional()` off a field to get at the schema underneath. */
function inner(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = current.def as { type?: string; innerType?: z.ZodType };
    if (
      (def.type === 'default' || def.type === 'optional' || def.type === 'prefault') &&
      def.innerType
    ) {
      current = def.innerType;
      continue;
    }
    return current;
  }
  return current;
}

export interface SettingShape {
  name: RuntimeSettingName;
  def: SettingDefinition;
  kind: RuntimeSettingKind;
  /** Allowed values for a `choice`, with `unset` first when the field is optional. */
  options?: string[];
  /** Whether the field may legitimately have no value at all. */
  nullable: boolean;
  /** Parse a candidate with the same schema the environment variable uses. */
  parse(value: unknown): { ok: true; value: RuntimeSettingValue | undefined } | { ok: false };
}

/**
 * A candidate for a number field: an actual number, or a string that is one.
 * Everything else — blank, whitespace, a boolean, an array — is a field with
 * nothing in it, whatever `Number()` would make of it.
 */
function looksNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return value.trim() !== '' && Number.isFinite(Number(value));
}

function shapeOf(name: RuntimeSettingName): SettingShape {
  const field = Env.shape[name] as z.ZodType;
  const base = inner(field);
  const type = (base.def as { type?: string }).type;
  const nullable = (field.def as { type?: string }).type === 'optional';
  const enumOptions = (base as unknown as { options?: string[] }).options;
  const kind: RuntimeSettingKind =
    enumOptions !== undefined
      ? 'choice'
      : type === 'number'
        ? 'number'
        : type === 'boolean'
          ? 'boolean'
          : 'text';
  const def = SETTINGS[name] as SettingDefinition;
  return {
    name,
    def,
    kind,
    ...(enumOptions === undefined
      ? {}
      : { options: nullable ? [UNSET, ...enumOptions] : [...enumOptions] }),
    nullable,
    parse(value) {
      // `unset` and an explicit null both mean "no value", which only a field
      // that is genuinely optional may take.
      if (value === null || value === undefined || (nullable && value === UNSET)) {
        return nullable ? { ok: true, value: undefined } : { ok: false };
      }
      // A blank number field is not a zero.
      //
      // Every numeric setting is `z.coerce.number()`, and JavaScript's
      // coercion turns `''`, `'  '`, `false` and `[]` into 0 — so a field
      // cleared in the console used to save cleanly as "0". For
      // `PEN_DAILY_SPEND_CAP_USD` that is not a small number, it is *off*:
      // `SpendBreaker.enabled` is `capUsd() > 0`, so an empty box silently
      // removed the ceiling on real provider spend, and the row afterwards
      // read like somebody had chosen it. `PEN_TTS_CACHE_MB: ''` turns off
      // the lesson voice store the same way. Only `min: 1` was stopping the
      // others, which is luck rather than validation.
      if (kind === 'number' && !looksNumeric(value)) return { ok: false };
      const parsed = base.safeParse(value);
      if (!parsed.success) return { ok: false };
      const out = parsed.data;
      if (typeof out !== 'string' && typeof out !== 'number' && typeof out !== 'boolean')
        return { ok: false };
      if (typeof out === 'number') {
        if (def.min !== undefined && out < def.min) return { ok: false };
        if (def.max !== undefined && out > def.max) return { ok: false };
      }
      return { ok: true, value: out };
    },
  };
}

/** One shape per setting, built once: the schema never changes after boot. */
export const SHAPES: Readonly<Record<RuntimeSettingName, SettingShape>> = Object.freeze(
  Object.fromEntries(SETTING_NAMES.map((name) => [name, shapeOf(name)])),
) as Record<RuntimeSettingName, SettingShape>;

/**
 * Values this deployment must never run on, whatever the document says.
 *
 * Two classes, and both have to be checked in two places — when a save is
 * made, so the operator is told; and when a document is read, so a value that
 * was already stored (or arrived from another process, or was written before
 * a key was removed) cannot be acted on. A check only at the write is a check
 * a restart walks straight past.
 *
 *  - **What `loadConfig` refuses in production.** `fake` lessons and a silent
 *    expert kill the boot for a reason; a stored value arrives after that
 *    check has run, so without this the console is a way around it.
 *  - **A provider with no credential.** `buildServices` and `createRecognizer`
 *    throw when the chosen provider has no key, and they run at boot — so a
 *    save like this is a bomb with a timer set to the next deploy. Refused at
 *    the save, and ignored if one is somehow already in the document.
 *
 * Returns the sentence the operator should read, or null when the value is
 * fine.
 */
export function refuseValue(
  name: RuntimeSettingName,
  value: RuntimeSettingValue | undefined,
  cfg: Config,
): string | null {
  if (value === undefined) return null;
  if (cfg.NODE_ENV === 'production') {
    if (name === 'PEN_LLM_PROVIDER' && value === 'fake')
      return 'a scripted demo model cannot teach a paying learner; `fake` is refused in production.';
    if (name === 'PEN_TTS_PROVIDER' && value === 'silent')
      return 'a silent expert is refused in production.';
  }
  if (name === 'PEN_TTS_PROVIDER' && value === 'fish-cloud' && !cfg.FISH_AUDIO_API_KEY)
    return 'this server has no FISH_AUDIO_API_KEY, and would refuse to start.';
  if (name === 'PEN_TTS_PROVIDER' && value === 'fish-bridge' && !cfg.PEN_TTS_BRIDGE_URL)
    return 'this server has no PEN_TTS_BRIDGE_URL.';
  if (name === 'PEN_STT_PROVIDER') {
    if (value === 'deepgram' && !cfg.DEEPGRAM_API_KEY)
      return 'this server has no DEEPGRAM_API_KEY, and would refuse to start.';
    if (value === 'assemblyai' && !cfg.ASSEMBLYAI_API_KEY)
      return 'this server has no ASSEMBLYAI_API_KEY, and would refuse to start.';
    if (value === 'ws-relay' && !cfg.PEN_STT_RELAY_URL)
      return 'this server has no PEN_STT_RELAY_URL, and would refuse to start.';
  }
  if (name === 'PEN_LLM_PROVIDER' && value !== 'fake') {
    const missing = (['FREE', 'STANDARD', 'PROFESSIONAL'] as const).filter(
      (plan) => !cfg[`OPENAI_API_KEY_${plan}`],
    );
    if (missing.length > 0)
      return `this server has no ${missing.map((p) => `OPENAI_API_KEY_${p}`).join(', ')}.`;
  }
  return null;
}

export function isSettingName(value: string): value is RuntimeSettingName {
  return Object.hasOwn(SETTINGS, value);
}
