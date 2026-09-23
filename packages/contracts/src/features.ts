import { z } from 'zod';
import { hasEntitlement, PlanCode } from './billing.js';

/**
 * Feature flags: which parts of the product a learner gets, decided by their
 * plan and by the platform they are on (ADR-0036).
 *
 * A flag is not an experiment and not a runtime setting (ADR-0025). A runtime
 * setting is one value for the whole deployment — which model teaches, what a
 * day may cost. A flag is a *matrix*: the same product offers a free learner
 * on the web something different from a Professional host on a Mac, and the
 * owner wants to move any cell of that matrix without a deploy.
 *
 * ── the two axes ─────────────────────────────────────────────────────────
 *
 * The plan axis is `PlanCode`. The platform axis is every host the product
 * ships, or will: the web app today, the desktop app whose packaging is
 * already built, and the phones that do not exist yet. They are listed now so
 * a flag can be set for them before they exist, and so the day iOS ships is
 * not the day somebody discovers the flags never knew about it.
 *
 * ── how a rule resolves ──────────────────────────────────────────────────
 *
 * Each feature has one `FeatureRule`: a default, an optional answer per plan,
 * an optional answer per platform, and an optional answer per exact cell. For
 * a given (plan, platform):
 *
 *  1. a cell override, when there is one, is the answer;
 *  2. otherwise the plan answer and the platform answer that exist are
 *     combined with AND — "off on desktop" means off on desktop for every
 *     plan, and "off for free" means off for free on every platform, which is
 *     what those two sentences mean when an operator says them;
 *  3. otherwise the default.
 *
 * The compiled-in rule for each feature is what the product does with no
 * document at all, and it is derived from `PLAN_ENTITLEMENTS` where the two
 * say the same thing, so a plan's promise and its flag cannot drift apart.
 */

export const Platform = z.enum([
  'web',
  'desktop-mac',
  'desktop-windows',
  'desktop-linux',
  'ios',
  'android',
]);
export type Platform = z.infer<typeof Platform>;
export const PLATFORMS: readonly Platform[] = Platform.options;

export const PLATFORM_LABEL: Record<Platform, string> = {
  web: 'Web',
  'desktop-mac': 'Mac',
  'desktop-windows': 'Windows',
  'desktop-linux': 'Linux',
  ios: 'iOS',
  android: 'Android',
};

/** Platforms a learner can actually be on today; the rest are reserved. */
export const SHIPPED_PLATFORMS: readonly Platform[] = [
  'web',
  'desktop-mac',
  'desktop-windows',
  'desktop-linux',
];

/** The header a client names its platform in. Anything unparseable is `web`. */
export const PLATFORM_HEADER = 'x-pen-platform';

export function platformFromHeader(value: string | null | undefined): Platform {
  const parsed = Platform.safeParse(value?.trim().toLowerCase());
  return parsed.success ? parsed.data : 'web';
}

export const FeatureName = z.enum([
  /** May trigger data gathering and compilation for a topic nobody has prepared yet (a registry miss). */
  'prepare_new_topics',
  /** Start a prepared lesson again from a card, a shelf or a saved page: the "replay" of the product. */
  'quick_start',
  /** Watch the recording of a session you hosted, questions and answers included. */
  'recording_playback',
  /** Download the recording of a session you hosted as an MP4. */
  'session_download',
  /** Host a room with guests. */
  'rooms',
  /** Video ads between segments and while a topic is prepared. */
  'ads',
  /** The chat between the people in a room. */
  'chat',
  /** Emoji reactions in a room. */
  'reactions',
  /** The CC control and subtitles in the room. */
  'captions',
  /** Continue with Google. */
  'google_sign_in',
  /** Email and password sign-in, sign-up and reset. */
  'email_sign_in',
]);
export type FeatureName = z.infer<typeof FeatureName>;
export const FEATURE_NAMES: readonly FeatureName[] = FeatureName.options;

export function isFeatureName(value: string): value is FeatureName {
  return (FEATURE_NAMES as readonly string[]).includes(value);
}

export const CellKey = z.string().regex(/^(free|standard|professional):[a-z-]+$/);
export type CellKey = `${PlanCode}:${Platform}`;

export function cellKey(plan: PlanCode, platform: Platform): CellKey {
  return `${plan}:${platform}`;
}

export const FeatureRule = z.object({
  default: z.boolean(),
  plans: z.partialRecord(PlanCode, z.boolean()),
  platforms: z.partialRecord(Platform, z.boolean()),
  cells: z.partialRecord(CellKey, z.boolean()),
});
export type FeatureRule = z.infer<typeof FeatureRule>;

export interface FeatureDefinition {
  label: string;
  description: string;
  group: string;
  /** What the product does with no stored document at all. */
  rule: FeatureRule;
}

const rule = (
  def: boolean,
  parts: { plans?: FeatureRule['plans']; platforms?: FeatureRule['platforms'] } = {},
): FeatureRule => ({
  default: def,
  plans: parts.plans ?? {},
  platforms: parts.platforms ?? {},
  cells: {},
});

/** A rule that says exactly what the entitlement table says, plan by plan. */
const fromEntitlement = (entitlement: Parameters<typeof hasEntitlement>[1]): FeatureRule =>
  rule(false, {
    plans: Object.fromEntries(
      PlanCode.options.map((plan) => [plan, hasEntitlement(plan, entitlement)]),
    ),
  });

export const FEATURES: Readonly<Record<FeatureName, FeatureDefinition>> = Object.freeze({
  prepare_new_topics: {
    label: 'Prepare new topics',
    description:
      'Whether a learner whose topic nobody has prepared yet can have it prepared — sources gathered, a pack compiled, a lesson written. Off means they are offered the lessons that are ready instead, with the way to upgrade. The expensive path in the product.',
    group: 'Sessions',
    rule: rule(false, { plans: { standard: true, professional: true } }),
  },
  quick_start: {
    label: 'Start a prepared lesson',
    description:
      'Start a lesson again from a card or a shelf. It is a fresh live session with the same expert — the learner can ask anything — and it reuses the taught lesson and its voice, so it costs almost nothing.',
    group: 'Sessions',
    rule: rule(true),
  },
  rooms: {
    label: 'Rooms',
    description: 'Host a session with guests: invitations, guest voice, the roster.',
    group: 'Sessions',
    rule: fromEntitlement('rooms'),
  },
  recording_playback: {
    label: 'Watch your recording',
    description:
      'The host of a session can watch its recording, with their own questions and the answers. Nobody else ever can.',
    group: 'Recordings',
    rule: rule(true),
  },
  session_download: {
    label: 'Download your recording',
    description:
      'The host of a session can download it as an MP4, with or without their own questions.',
    group: 'Recordings',
    rule: fromEntitlement('export'),
  },
  ads: {
    label: 'Video ads',
    description:
      'A skippable video ad between segments, and one while a topic is prepared. Never on a plan that pays.',
    group: 'Ads',
    rule: rule(true, { plans: { standard: false, professional: false } }),
  },
  chat: {
    label: 'Chat',
    description: 'The chat between the people in a room. The expert never sees it.',
    group: 'Room',
    rule: rule(true),
  },
  reactions: {
    label: 'Reactions',
    description: 'Eight emoji a participant can send without taking the floor.',
    group: 'Room',
    rule: rule(true),
  },
  captions: {
    label: 'Captions',
    description: 'The CC control and the subtitles it turns on.',
    group: 'Room',
    rule: rule(true),
  },
  google_sign_in: {
    label: 'Continue with Google',
    description:
      'Google sign-in. Off on desktop and the phones, where Google refuses OAuth in an embedded view and the loopback flow is not built.',
    group: 'Sign-in',
    rule: rule(true, {
      platforms: {
        'desktop-mac': false,
        'desktop-windows': false,
        'desktop-linux': false,
        ios: false,
        android: false,
      },
    }),
  },
  email_sign_in: {
    label: 'Email and password',
    description: 'Sign-up, sign-in and password reset by email.',
    group: 'Sign-in',
    rule: rule(true),
  },
});

/** Group order on the screen. */
export const FEATURE_GROUP_ORDER = ['Sessions', 'Recordings', 'Ads', 'Room', 'Sign-in'] as const;

/** Stored overrides: only the features the document says something about. */
export const FeatureRulesDocument = z.partialRecord(FeatureName, FeatureRule);
export type FeatureRulesDocument = z.infer<typeof FeatureRulesDocument>;

/** The rule in force for one feature: the stored one when there is one, else the compiled-in one. */
export function effectiveRule(document: FeatureRulesDocument, name: FeatureName): FeatureRule {
  return document[name] ?? FEATURES[name].rule;
}

/** One rule, one cell. See the module comment for the order. */
export function resolveRule(r: FeatureRule, plan: PlanCode, platform: Platform): boolean {
  const cell = r.cells[cellKey(plan, platform)];
  if (cell !== undefined) return cell;
  const byPlan = r.plans[plan];
  const byPlatform = r.platforms[platform];
  if (byPlan !== undefined && byPlatform !== undefined) return byPlan && byPlatform;
  if (byPlan !== undefined) return byPlan;
  if (byPlatform !== undefined) return byPlatform;
  return r.default;
}

export type FeatureSet = Readonly<Record<FeatureName, boolean>>;

/** Every feature resolved for one learner: their plan, on their platform. */
export function featuresFor(
  document: FeatureRulesDocument,
  plan: PlanCode,
  platform: Platform,
): FeatureSet {
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, resolveRule(effectiveRule(document, name), plan, platform)]),
  ) as Record<FeatureName, boolean>;
}

/** The product with no document: what every test and every fresh deployment runs on. */
export function defaultFeaturesFor(plan: PlanCode, platform: Platform = 'web'): FeatureSet {
  return featuresFor({}, plan, platform);
}

/** The whole matrix of one rule, for the screen. */
export function ruleMatrix(r: FeatureRule): Record<PlanCode, Record<Platform, boolean>> {
  return Object.fromEntries(
    PlanCode.options.map((plan) => [
      plan,
      Object.fromEntries(PLATFORMS.map((platform) => [platform, resolveRule(r, plan, platform)])),
    ]),
  ) as Record<PlanCode, Record<Platform, boolean>>;
}

/**
 * Drop everything in a rule that says nothing: an empty override map is the
 * same rule as an absent one, and a stored document should not grow with
 * noise every time the screen is saved.
 */
export function normaliseRule(r: FeatureRule): FeatureRule {
  const prune = <K extends string>(m: Partial<Record<K, boolean>>): Partial<Record<K, boolean>> =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'boolean')) as Partial<
      Record<K, boolean>
    >;
  return {
    default: r.default,
    plans: prune(r.plans),
    platforms: prune(r.platforms),
    cells: prune(r.cells),
  };
}

export function rulesEqual(a: FeatureRule, b: FeatureRule): boolean {
  const na = normaliseRule(a);
  const nb = normaliseRule(b);
  const same = <K extends string>(x: Partial<Record<K, boolean>>, y: Partial<Record<K, boolean>>) =>
    Object.keys(x).length === Object.keys(y).length &&
    Object.entries(x).every(([k, v]) => y[k as K] === v);
  return (
    na.default === nb.default &&
    same(na.plans, nb.plans) &&
    same(na.platforms, nb.platforms) &&
    same(na.cells, nb.cells)
  );
}

// ── wire shapes: the console, and the learner's own answer ───────────────

/** One row of the Features screen. */
export const FeatureFlag = z.object({
  name: FeatureName,
  label: z.string().min(1),
  description: z.string().min(1),
  group: z.string().min(1),
  /** What the code does with no override at all. */
  defaultRule: FeatureRule,
  /** What the stored document says, or null when it says nothing. */
  storedRule: FeatureRule.nullable(),
  /** The rule in force. */
  effectiveRule: FeatureRule,
  /** `effectiveRule` resolved for every plan on every platform. */
  matrix: z.record(PlanCode, z.record(Platform, z.boolean())),
});
export type FeatureFlag = z.infer<typeof FeatureFlag>;

export const FeatureFlagsDocument = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().nullable(),
  updatedByName: z.string().nullable(),
  features: z.array(FeatureFlag),
  /** Served from the last known good copy because the store could not be read; saving is refused. */
  stale: z.boolean(),
});
export type FeatureFlagsDocument = z.infer<typeof FeatureFlagsDocument>;

export const FeatureFlagsMutation = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  /** The whole document. A feature mapped to null goes back to its compiled-in rule. */
  rules: z.partialRecord(FeatureName, FeatureRule.nullable()),
});
export type FeatureFlagsMutation = z.infer<typeof FeatureFlagsMutation>;

export const FeatureFlagsRollback = z.object({
  expectedRevision: z.number().int().nonnegative(),
  /** 0 restores the empty document every deployment starts on. */
  targetRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export type FeatureFlagsRollback = z.infer<typeof FeatureFlagsRollback>;

export const FeatureFlagsHistoryEntry = z.object({
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedByName: z.string(),
  reason: z.string(),
  restoredFromRevision: z.number().int().nonnegative().nullable(),
  rules: FeatureRulesDocument,
});
export type FeatureFlagsHistoryEntry = z.infer<typeof FeatureFlagsHistoryEntry>;

export const FeatureFlagsHistory = z.object({
  entries: z.array(FeatureFlagsHistoryEntry),
  nextBeforeRevision: z.number().int().positive().nullable(),
});
export type FeatureFlagsHistory = z.infer<typeof FeatureFlagsHistory>;

/** What `GET /api/me/features` tells a client: its own cell of the matrix, nothing else. */
export const MyFeatures = z.object({
  plan: PlanCode,
  platform: Platform,
  features: z.record(FeatureName, z.boolean()),
});
export type MyFeatures = z.infer<typeof MyFeatures>;
