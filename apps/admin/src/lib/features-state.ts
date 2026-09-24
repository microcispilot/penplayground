import type {
  ChoiceRule,
  FeatureFlag,
  FeatureFlagsDocument,
  FeatureFlagsHistory,
  FeatureFlagsHistoryEntry,
  FeatureName,
  FeatureRule,
  PlanCode,
  Platform,
  SettingName,
  SettingRow,
} from '@pen/contracts';
import {
  cellKey,
  choicesEqual,
  FEATURE_GROUP_ORDER,
  normaliseChoice,
  normaliseRule,
  rulesEqual,
} from '@pen/contracts';

/**
 * The Features editor's state machine (ADR-0036), as a pure function — the
 * same shape, and the same invariant, as the settings editor's
 * (`runtime-config-state.ts`): the saved document and the draft are separate,
 * and a write never advances the revision or rebases the draft unless the
 * server said exactly what was expected.
 *
 * A draft here is one whole `FeatureRule` per feature, because that is what
 * the operator edits: a matrix, not a value.
 */

export type FeatureDraft = Readonly<Record<string, FeatureRule>>;
/** The settings' draft (ADR-0048): one whole `ChoiceRule` per setting, edited beside the flags. */
export type SettingDraft = Readonly<Record<string, ChoiceRule>>;

export interface FeaturesEditorState {
  readonly document: FeatureFlagsDocument | null;
  readonly draft: FeatureDraft;
  readonly settingsDraft: SettingDraft;
  readonly phase: 'LOADING' | 'READY' | 'SAVING' | 'RELOAD_REQUIRED' | 'LOAD_FAILED';
  readonly requestId: number;
  readonly dirty: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}

export const initialFeaturesState: FeaturesEditorState = {
  document: null,
  draft: {},
  settingsDraft: {},
  phase: 'LOADING',
  requestId: 0,
  dirty: false,
  error: null,
  notice: null,
};

export type FeaturesEvent =
  | { readonly type: 'LOAD'; readonly requestId: number }
  | { readonly type: 'LOADED'; readonly requestId: number; readonly document: FeatureFlagsDocument }
  | { readonly type: 'LOAD_FAILED'; readonly requestId: number; readonly error: string }
  | {
      readonly type: 'EDIT';
      readonly draft: FeatureDraft;
      /** Left out, the settings' draft stays as it is: a flag edit never touches it. */
      readonly settingsDraft?: SettingDraft;
    }
  | { readonly type: 'SAVE'; readonly requestId: number }
  | {
      readonly type: 'SAVED';
      readonly requestId: number;
      readonly document: FeatureFlagsDocument;
      readonly notice: string;
    }
  | {
      readonly type: 'SAVE_FAILED';
      readonly requestId: number;
      readonly error: string;
      readonly reloadRequired: boolean;
    };

/** The draft a document arrives as: every feature's rule in force, stored or compiled-in. */
export function draftFrom(document: FeatureFlagsDocument): FeatureDraft {
  const draft: Record<string, FeatureRule> = {};
  for (const flag of document.features) draft[flag.name] = flag.effectiveRule;
  return draft;
}

/** The settings' draft a document arrives as: every setting's rule in force. */
export function settingsDraftFrom(document: FeatureFlagsDocument): SettingDraft {
  const draft: Record<string, ChoiceRule> = {};
  for (const row of document.settings) draft[row.name] = row.effectiveRule;
  return draft;
}

export function featuresReducer(
  state: FeaturesEditorState,
  event: FeaturesEvent,
): FeaturesEditorState {
  switch (event.type) {
    case 'LOAD':
      if (state.phase === 'SAVING' || event.requestId <= state.requestId) return state;
      return { ...state, phase: 'LOADING', requestId: event.requestId, error: null, notice: null };
    case 'LOADED':
      if (event.requestId !== state.requestId || state.phase !== 'LOADING') return state;
      return accepted(state, event.document, null);
    case 'LOAD_FAILED':
      if (event.requestId !== state.requestId || state.phase !== 'LOADING') return state;
      return { ...state, phase: 'LOAD_FAILED', error: event.error };
    case 'EDIT': {
      if (state.phase !== 'READY') return state;
      const settingsDraft = event.settingsDraft ?? state.settingsDraft;
      const dirty =
        (state.document?.features.some(
          (flag) => !rulesEqual(event.draft[flag.name] ?? flag.effectiveRule, flag.effectiveRule),
        ) ??
          false) ||
        (state.document?.settings.some(
          (row) => !choicesEqual(settingsDraft[row.name] ?? row.effectiveRule, row.effectiveRule),
        ) ??
          false);
      return {
        ...state,
        draft: { ...event.draft },
        settingsDraft: { ...settingsDraft },
        dirty,
        error: null,
        notice: null,
      };
    }
    case 'SAVE':
      if (state.phase !== 'READY' || state.document === null || event.requestId <= state.requestId)
        return state;
      return { ...state, phase: 'SAVING', requestId: event.requestId, error: null, notice: null };
    case 'SAVED': {
      if (event.requestId !== state.requestId || state.phase !== 'SAVING') return state;
      const expected = (state.document?.revision ?? 0) + 1;
      if (event.document.revision !== expected)
        return {
          ...state,
          phase: 'RELOAD_REQUIRED',
          error:
            'The server came back with a revision nobody asked for. Reload the saved features before changing anything else.',
        };
      return accepted(state, event.document, event.notice);
    }
    case 'SAVE_FAILED':
      if (event.requestId !== state.requestId || state.phase !== 'SAVING') return state;
      return {
        ...state,
        phase: event.reloadRequired ? 'RELOAD_REQUIRED' : 'READY',
        error: event.error,
      };
  }
}

function accepted(
  state: FeaturesEditorState,
  document: FeatureFlagsDocument,
  notice: string | null,
): FeaturesEditorState {
  return {
    ...state,
    document,
    draft: draftFrom(document),
    settingsDraft: settingsDraftFrom(document),
    phase: 'READY',
    dirty: false,
    error: null,
    notice,
  };
}

// ── history ──────────────────────────────────────────────────────────────────

export interface FeaturesHistoryState {
  readonly entries: readonly FeatureFlagsHistoryEntry[];
  readonly nextBeforeRevision: number | null;
  readonly requestId: number;
  readonly loading: boolean;
  readonly error: string | null;
}

export const initialFeaturesHistory: FeaturesHistoryState = {
  entries: [],
  nextBeforeRevision: null,
  requestId: 0,
  loading: false,
  error: null,
};

export type FeaturesHistoryEvent =
  | { readonly type: 'LOAD'; readonly requestId: number }
  | {
      readonly type: 'LOADED';
      readonly requestId: number;
      readonly beforeRevision?: number;
      readonly history: FeatureFlagsHistory;
    }
  | { readonly type: 'FAILED'; readonly requestId: number };

export function featuresHistoryReducer(
  state: FeaturesHistoryState,
  event: FeaturesHistoryEvent,
): FeaturesHistoryState {
  if (event.type === 'LOAD')
    return event.requestId > state.requestId
      ? { ...state, requestId: event.requestId, loading: true, error: null }
      : state;
  if (event.requestId !== state.requestId || !state.loading) return state;
  if (event.type === 'FAILED')
    return {
      ...state,
      loading: false,
      error: 'The history could not be read. Try again before restoring anything from it.',
    };
  const entries =
    event.beforeRevision === undefined
      ? [...event.history.entries]
      : [...state.entries, ...event.history.entries];
  const ordered = entries.every(
    (entry, index) => index === 0 || entry.revision < (entries[index - 1]?.revision ?? 0),
  );
  const cursor = event.history.nextBeforeRevision;
  const cursorValid =
    cursor === null || (entries.length > 0 && cursor === entries[entries.length - 1]?.revision);
  const continues =
    event.beforeRevision === undefined || event.beforeRevision === state.nextBeforeRevision;
  if (!ordered || !cursorValid || !continues)
    return {
      ...state,
      loading: false,
      error: 'The history came back inconsistent. Refresh it before restoring a revision.',
    };
  return { ...state, entries, nextBeforeRevision: cursor, loading: false, error: null };
}

// ── what the screen shows and edits about one feature ───────────────────────

/** The rule the editor is offering for a feature: the draft's, else the one in force. */
export function draftRule(draft: FeatureDraft, flag: FeatureFlag): FeatureRule {
  return draft[flag.name] ?? flag.effectiveRule;
}

/** The three answers a plan, a platform or a cell can give: nothing, on, off. */
export type Answer = boolean | undefined;

/** Nothing → on → off → nothing: what one click on a cell or a header does. */
export function nextAnswer(current: Answer): Answer {
  if (current === undefined) return true;
  if (current === true) return false;
  return undefined;
}

function withAnswer<K extends string>(
  map: Partial<Record<K, boolean>>,
  key: K,
  answer: Answer,
): Partial<Record<K, boolean>> {
  const next = { ...map };
  if (answer === undefined) delete next[key];
  else next[key] = answer;
  return next;
}

export function setPlanAnswer(rule: FeatureRule, plan: PlanCode, answer: Answer): FeatureRule {
  return normaliseRule({ ...rule, plans: withAnswer(rule.plans, plan, answer) });
}

export function setPlatformAnswer(
  rule: FeatureRule,
  platform: Platform,
  answer: Answer,
): FeatureRule {
  return normaliseRule({ ...rule, platforms: withAnswer(rule.platforms, platform, answer) });
}

export function setCellAnswer(
  rule: FeatureRule,
  plan: PlanCode,
  platform: Platform,
  answer: Answer,
): FeatureRule {
  return normaliseRule({
    ...rule,
    cells: withAnswer(rule.cells, cellKey(plan, platform), answer),
  });
}

export function setDefault(rule: FeatureRule, value: boolean): FeatureRule {
  return normaliseRule({ ...rule, default: value });
}

// ── what the screen shows and edits about one setting (ADR-0048) ────────────

/** The rule the editor is offering for a setting: the draft's, else the one in force. */
export function draftSetting(draft: SettingDraft, row: SettingRow): ChoiceRule {
  return draft[row.name] ?? row.effectiveRule;
}

/** A plan, a platform, a cell or the visitor either names a value or says nothing. */
export type Choice = string | undefined;

function withChoice<K extends string>(
  map: Partial<Record<K, string>>,
  key: K,
  choice: Choice,
): Partial<Record<K, string>> {
  const next = { ...map };
  if (choice === undefined || choice === '') delete next[key];
  else next[key] = choice;
  return next;
}

export function setChoiceDefault(rule: ChoiceRule, value: string): ChoiceRule {
  return normaliseChoice({ ...rule, default: value });
}

export function setChoiceAnonymous(rule: ChoiceRule, choice: Choice): ChoiceRule {
  const { anonymous: _dropped, ...rest } = rule;
  return normaliseChoice(choice ? { ...rest, anonymous: choice } : rest);
}

export function setChoicePlanAnswer(rule: ChoiceRule, plan: PlanCode, choice: Choice): ChoiceRule {
  return normaliseChoice({ ...rule, plans: withChoice(rule.plans, plan, choice) });
}

export function setChoicePlatformAnswer(
  rule: ChoiceRule,
  platform: Platform,
  choice: Choice,
): ChoiceRule {
  return normaliseChoice({ ...rule, platforms: withChoice(rule.platforms, platform, choice) });
}

export function setChoiceCellAnswer(
  rule: ChoiceRule,
  plan: PlanCode,
  platform: Platform,
  choice: Choice,
): ChoiceRule {
  return normaliseChoice({
    ...rule,
    cells: withChoice(rule.cells, cellKey(plan, platform), choice),
  });
}

/** Set (or, with no value, remove) the answer for one named account. */
export function setChoiceParticipant(
  rule: ChoiceRule,
  participantId: string,
  choice: Choice,
): ChoiceRule {
  return normaliseChoice({
    ...rule,
    participants: withChoice(rule.participants, participantId, choice) as Record<string, string>,
  });
}

/** Which settings the draft changes, by name. */
export function changedSettings(state: FeaturesEditorState): SettingName[] {
  if (!state.document) return [];
  return state.document.settings
    .filter((row) => !choicesEqual(draftSetting(state.settingsDraft, row), row.effectiveRule))
    .map((row) => row.name);
}

/**
 * The settings a save sends, the same way as the features: every setting's
 * draft rule, with the ones back at their compiled-in rule sent as null.
 */
export function mutationSettings(
  state: FeaturesEditorState,
): Partial<Record<SettingName, ChoiceRule | null>> {
  const out: Partial<Record<SettingName, ChoiceRule | null>> = {};
  if (!state.document) return out;
  for (const row of state.document.settings) {
    const rule = draftSetting(state.settingsDraft, row);
    out[row.name] = choicesEqual(rule, row.defaultRule) ? null : rule;
  }
  return out;
}

/** Which features the draft changes, by name — what a save is actually about. */
export function changedFeatures(state: FeaturesEditorState): FeatureName[] {
  if (!state.document) return [];
  return state.document.features
    .filter((flag) => !rulesEqual(draftRule(state.draft, flag), flag.effectiveRule))
    .map((flag) => flag.name);
}

/**
 * The whole document a save sends: every feature's draft rule, with the ones
 * that are back at their compiled-in rule sent as null so the server stores
 * nothing for them.
 */
export function mutationRules(
  state: FeaturesEditorState,
): Partial<Record<FeatureName, FeatureRule | null>> {
  const out: Partial<Record<FeatureName, FeatureRule | null>> = {};
  if (!state.document) return out;
  for (const flag of state.document.features) {
    const rule = draftRule(state.draft, flag);
    out[flag.name] = rulesEqual(rule, flag.defaultRule) ? null : rule;
  }
  return out;
}

/** Features in the order the API sent them, bucketed by group, groups in that same order. */
export function byGroup(features: readonly FeatureFlag[]): [string, FeatureFlag[]][] {
  const groups = new Map<string, FeatureFlag[]>();
  for (const flag of features) {
    const bucket = groups.get(flag.group);
    if (bucket) bucket.push(flag);
    else groups.set(flag.group, [flag]);
  }
  return [...groups.entries()];
}

export interface GroupRows {
  features: FeatureFlag[];
  settings: SettingRow[];
}

/**
 * Features and settings together, bucketed by group: the known groups in
 * their fixed order, then any group the catalogue names that this list does
 * not know (Voice was the first), in the order they were met.
 */
export function bySection(
  features: readonly FeatureFlag[],
  settings: readonly SettingRow[],
): [string, GroupRows][] {
  const groups = new Map<string, GroupRows>();
  const bucket = (group: string): GroupRows => {
    const found = groups.get(group);
    if (found) return found;
    const made: GroupRows = { features: [], settings: [] };
    groups.set(group, made);
    return made;
  };
  for (const flag of features) bucket(flag.group).features.push(flag);
  for (const row of settings) bucket(row.group).settings.push(row);
  const rank = new Map<string, number>(FEATURE_GROUP_ORDER.map((g, i) => [g, i]));
  const met = [...groups.keys()];
  return met
    .map((group, index) => ({ group, index }))
    .sort(
      (a, b) =>
        (rank.get(a.group) ?? 99 + a.index) - (rank.get(b.group) ?? 99 + b.index) ||
        a.index - b.index,
    )
    .map(({ group }) => [group, groups.get(group) as GroupRows]);
}
