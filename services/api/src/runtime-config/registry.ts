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

export function isSettingName(value: string): value is RuntimeSettingName {
  return Object.hasOwn(SETTINGS, value);
}
