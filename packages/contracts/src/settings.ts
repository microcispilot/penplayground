import { z } from 'zod';
import { PlanCode } from './billing.js';
import { CellKey, cellKey, PLATFORMS, Platform } from './features.js';

/**
 * Settings: a feature flag that carries a *value* instead of a bit
 * (ADR-0048).
 *
 * A feature flag answers "does this learner get X?" with yes or no. A setting
 * answers "which X does this learner get?" with one of a named list — which
 * voice engine speaks, today; which model teaches, one day. It is decided on
 * the same axes as a flag, plus one: the person. An operator can say "Fish
 * for Professional on the Mac" and also "Fish for this one account", to
 * hear a change before anyone else does, or to keep a customer where they
 * are while everyone else moves.
 *
 * ── how a choice resolves ────────────────────────────────────────────────
 *
 *  1. an answer for the *participant*, when there is one, is the answer;
 *  2. otherwise a visitor without an account gets the `anonymous` answer,
 *     when there is one (ADR-0040: a question about the account, decided
 *     first and alone);
 *  3. otherwise a cell override for the exact (plan, platform);
 *  4. otherwise the plan's answer, then the platform's — the plan wins when
 *     both speak, because "a subscription's engine" is the more deliberate
 *     of the two statements and there is no AND for a value;
 *  5. otherwise the default.
 *
 * A setting is read **once**, when a session is created, and the answer is
 * bound into the room. Nothing downstream looks at the document again, so a
 * change reaches the next session and never a lesson in progress, and two
 * engines can never be mixed inside one session.
 */

// ── the values ───────────────────────────────────────────────────────────

/**
 * The engines that can speak for an expert. `cartesia` is the built-in
 * default; `fish` is the previous one. A deployment offers the engines it
 * holds keys for, and a choice it cannot honour falls to one it can, said
 * out loud (`VoiceService`).
 */
export const VoiceEngine = z.enum(['cartesia', 'fish']);
export type VoiceEngine = z.infer<typeof VoiceEngine>;
export const VOICE_ENGINES: readonly VoiceEngine[] = VoiceEngine.options;
export const VOICE_ENGINE_LABEL: Record<VoiceEngine, string> = {
  cartesia: 'Cartesia',
  fish: 'Fish Audio',
};

// ── the rule ─────────────────────────────────────────────────────────────

/** A participant id, as issued: `p_` and the id. Kept loose here; the service checks the account exists. */
export const ParticipantKey = z.string().regex(/^p_[A-Za-z0-9_-]{4,64}$/);

export const ChoiceRule = z.object({
  default: z.string().min(1),
  plans: z.partialRecord(PlanCode, z.string().min(1)),
  platforms: z.partialRecord(Platform, z.string().min(1)),
  cells: z.partialRecord(CellKey, z.string().min(1)),
  anonymous: z.string().min(1).optional(),
  /** Answers for named accounts: the most specific statement there is. */
  participants: z.record(ParticipantKey, z.string().min(1)).default({}),
});
export type ChoiceRule = z.infer<typeof ChoiceRule>;

export interface ChoiceWho {
  anonymous?: boolean;
  participantId?: string;
}

export function resolveChoice(
  r: ChoiceRule,
  plan: PlanCode,
  platform: Platform,
  who: ChoiceWho = {},
): string {
  if (who.participantId !== undefined) {
    const mine = r.participants[who.participantId];
    if (mine !== undefined) return mine;
  }
  if (who.anonymous && r.anonymous !== undefined) return r.anonymous;
  const cell = r.cells[cellKey(plan, platform)];
  if (cell !== undefined) return cell;
  const byPlan = r.plans[plan];
  if (byPlan !== undefined) return byPlan;
  const byPlatform = r.platforms[platform];
  if (byPlatform !== undefined) return byPlatform;
  return r.default;
}

export function choiceMatrix(r: ChoiceRule): Record<PlanCode, Record<Platform, string>> {
  return Object.fromEntries(
    PlanCode.options.map((plan) => [
      plan,
      Object.fromEntries(PLATFORMS.map((platform) => [platform, resolveChoice(r, plan, platform)])),
    ]),
  ) as Record<PlanCode, Record<Platform, string>>;
}

export function normaliseChoice(r: ChoiceRule): ChoiceRule {
  const prune = <K extends string>(m: Partial<Record<K, string>>): Partial<Record<K, string>> =>
    Object.fromEntries(
      Object.entries(m).filter(([, v]) => typeof v === 'string' && v.length > 0),
    ) as Partial<Record<K, string>>;
  return {
    default: r.default,
    plans: prune(r.plans),
    platforms: prune(r.platforms),
    cells: prune(r.cells),
    ...(typeof r.anonymous === 'string' && r.anonymous ? { anonymous: r.anonymous } : {}),
    participants: prune(r.participants) as Record<string, string>,
  };
}

export function choicesEqual(a: ChoiceRule, b: ChoiceRule): boolean {
  const na = normaliseChoice(a);
  const nb = normaliseChoice(b);
  const same = <K extends string>(x: Partial<Record<K, string>>, y: Partial<Record<K, string>>) =>
    Object.keys(x).length === Object.keys(y).length &&
    Object.entries(x).every(([k, v]) => y[k as K] === v);
  return (
    na.default === nb.default &&
    na.anonymous === nb.anonymous &&
    same(na.plans, nb.plans) &&
    same(na.platforms, nb.platforms) &&
    same(na.cells, nb.cells) &&
    same(na.participants, nb.participants)
  );
}

/** Every value the rule names is one of the setting's values. */
export function choiceValuesValid(r: ChoiceRule, values: readonly string[]): string | null {
  const ok = new Set<string>(values);
  const check = (where: string, v: string | undefined) =>
    v !== undefined && !ok.has(v) ? `${where}: "${v}" is not one of ${values.join(', ')}.` : null;
  const problems = [
    check('default', r.default),
    check('anonymous', r.anonymous),
    ...Object.entries(r.plans).map(([k, v]) => check(`plan ${k}`, v)),
    ...Object.entries(r.platforms).map(([k, v]) => check(`platform ${k}`, v)),
    ...Object.entries(r.cells).map(([k, v]) => check(`cell ${k}`, v)),
    ...Object.entries(r.participants).map(([k, v]) => check(`participant ${k}`, v)),
  ].filter((p): p is string => p !== null);
  return problems[0] ?? null;
}

// ── the catalogue ────────────────────────────────────────────────────────

export const SettingName = z.enum([
  /** Which synthesis engine speaks for the expert in a session (ADR-0048). */
  'voice_engine',
]);
export type SettingName = z.infer<typeof SettingName>;
export const SETTING_NAMES: readonly SettingName[] = SettingName.options;

export function isSettingName(value: string): value is SettingName {
  return (SETTING_NAMES as readonly string[]).includes(value);
}

export interface SettingDefinition {
  label: string;
  description: string;
  group: string;
  values: readonly string[];
  valueLabels: Readonly<Record<string, string>>;
  /** What the product does with no stored document at all. */
  rule: ChoiceRule;
}

const choice = (def: string): ChoiceRule => ({
  default: def,
  plans: {},
  platforms: {},
  cells: {},
  participants: {},
});

export const SETTINGS: Readonly<Record<SettingName, SettingDefinition>> = Object.freeze({
  voice_engine: {
    label: 'Voice engine',
    description:
      'Which synthesis engine speaks for the expert. Decided once when a session starts and bound into it: a change reaches the next session, never a lesson in progress, and one session never mixes engines. Each engine has its own voice for every expert and its own store of taught lessons. An engine this server holds no key for falls to one it does, and says so (ADR-0048).',
    group: 'Voice',
    values: VOICE_ENGINES,
    valueLabels: VOICE_ENGINE_LABEL,
    rule: choice('cartesia'),
  },
});

export const SettingRulesDocument = z.partialRecord(SettingName, ChoiceRule);
export type SettingRulesDocument = z.infer<typeof SettingRulesDocument>;

export function effectiveChoice(document: SettingRulesDocument, name: SettingName): ChoiceRule {
  return document[name] ?? SETTINGS[name].rule;
}

/** One setting resolved for one learner, typed by the caller (`as VoiceEngine` where the values are engines). */
export function settingFor(
  document: SettingRulesDocument,
  name: SettingName,
  plan: PlanCode,
  platform: Platform,
  who: ChoiceWho = {},
): string {
  return resolveChoice(effectiveChoice(document, name), plan, platform, who);
}

// ── wire shapes: the console ─────────────────────────────────────────────

export const SettingRow = z.object({
  name: SettingName,
  label: z.string().min(1),
  description: z.string().min(1),
  group: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
  valueLabels: z.record(z.string(), z.string()),
  defaultRule: ChoiceRule,
  storedRule: ChoiceRule.nullable(),
  effectiveRule: ChoiceRule,
  matrix: z.record(PlanCode, z.record(Platform, z.string())),
});
export type SettingRow = z.infer<typeof SettingRow>;
