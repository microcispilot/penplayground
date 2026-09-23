import type { FeatureFlag, FeatureFlagsDocument, FeatureRule } from '@pen/contracts';
import { FEATURES, ruleMatrix } from '@pen/contracts';
import { describe, expect, it } from 'vitest';
import {
  changedFeatures,
  draftFrom,
  type FeaturesEditorState,
  featuresHistoryReducer,
  featuresReducer,
  initialFeaturesHistory,
  initialFeaturesState,
  mutationRules,
  nextAnswer,
  setCellAnswer,
  setDefault,
  setPlanAnswer,
  setPlatformAnswer,
} from '../src/lib/features-state.js';

/**
 * The Features editor's rules (ADR-0036), tested as plain functions like the
 * settings editor's: the draft is a whole rule per feature, a save is the
 * whole document with compiled-in rules sent as nothing, and every
 * concurrency rule the settings editor keeps is kept here too.
 */

function flag(name: keyof typeof FEATURES, over: Partial<FeatureFlag> = {}): FeatureFlag {
  const def = FEATURES[name];
  const rule = over.effectiveRule ?? def.rule;
  return {
    name,
    label: def.label,
    description: def.description,
    group: def.group,
    defaultRule: def.rule,
    storedRule: null,
    effectiveRule: rule,
    matrix: ruleMatrix(rule),
    ...over,
  };
}

function document(over: Partial<FeatureFlagsDocument> = {}): FeatureFlagsDocument {
  return {
    revision: 4,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'p_admin',
    updatedByName: 'Sam Owner',
    features: [flag('prepare_new_topics'), flag('ads')],
    stale: false,
    ...over,
  };
}

function ready(doc = document()): FeaturesEditorState {
  const loading = featuresReducer(initialFeaturesState, { type: 'LOAD', requestId: 1 });
  return featuresReducer(loading, { type: 'LOADED', requestId: 1, document: doc });
}

const open: FeatureRule = { default: true, plans: {}, platforms: {}, cells: {} };

describe('the draft', () => {
  it('arrives as every rule in force and is not dirty', () => {
    const state = ready();
    expect(state.phase).toBe('READY');
    expect(state.draft.prepare_new_topics).toEqual(FEATURES.prepare_new_topics.rule);
    expect(state.dirty).toBe(false);
    expect(draftFrom(document()).ads).toEqual(FEATURES.ads.rule);
  });

  it('is dirty only when a rule actually differs from the one in force', () => {
    const state = ready();
    const same = featuresReducer(state, { type: 'EDIT', draft: { ...state.draft } });
    expect(same.dirty).toBe(false);
    const changed = featuresReducer(state, {
      type: 'EDIT',
      draft: { ...state.draft, prepare_new_topics: open },
    });
    expect(changed.dirty).toBe(true);
    expect(changedFeatures(changed)).toEqual(['prepare_new_topics']);
  });

  it('sends the whole document, with a rule back at its compiled-in one sent as null', () => {
    const state = featuresReducer(ready(), {
      type: 'EDIT',
      draft: { prepare_new_topics: open, ads: FEATURES.ads.rule },
    });
    expect(mutationRules(state)).toEqual({ prepare_new_topics: open, ads: null });
  });
});

describe('editing a rule', () => {
  it('cycles an answer nothing → on → off → nothing', () => {
    expect(nextAnswer(undefined)).toBe(true);
    expect(nextAnswer(true)).toBe(false);
    expect(nextAnswer(false)).toBeUndefined();
  });

  it('sets and clears a plan, a platform and a cell without touching the rest', () => {
    let rule = setPlanAnswer(open, 'free', false);
    expect(rule.plans).toEqual({ free: false });
    rule = setPlatformAnswer(rule, 'ios', false);
    expect(rule.platforms).toEqual({ ios: false });
    rule = setCellAnswer(rule, 'free', 'web', true);
    expect(rule.cells).toEqual({ 'free:web': true });
    rule = setPlanAnswer(rule, 'free', undefined);
    expect(rule.plans).toEqual({});
    expect(rule.cells).toEqual({ 'free:web': true });
    expect(setDefault(rule, false).default).toBe(false);
  });
});

describe('saving', () => {
  it('accepts exactly the next revision and rebases the draft on it', () => {
    const state = featuresReducer(ready(), { type: 'SAVE', requestId: 2 });
    const saved = featuresReducer(state, {
      type: 'SAVED',
      requestId: 2,
      document: document({
        revision: 5,
        features: [flag('prepare_new_topics', { effectiveRule: open, storedRule: open })],
      }),
      notice: 'Saved as revision 5.',
    });
    expect(saved.phase).toBe('READY');
    expect(saved.document?.revision).toBe(5);
    expect(saved.draft.prepare_new_topics).toEqual(open);
    expect(saved.dirty).toBe(false);
  });

  it('keeps the draft and demands a reload when the revision skipped', () => {
    const edited = featuresReducer(ready(), {
      type: 'EDIT',
      draft: { prepare_new_topics: open, ads: FEATURES.ads.rule },
    });
    const saving = featuresReducer(edited, { type: 'SAVE', requestId: 2 });
    const odd = featuresReducer(saving, {
      type: 'SAVED',
      requestId: 2,
      document: document({ revision: 9 }),
      notice: 'x',
    });
    expect(odd.phase).toBe('RELOAD_REQUIRED');
    expect(odd.draft.prepare_new_topics).toEqual(open);
  });

  it('a failed save keeps the draft, and says whether a reload is needed', () => {
    const saving = featuresReducer(ready(), { type: 'SAVE', requestId: 2 });
    const conflict = featuresReducer(saving, {
      type: 'SAVE_FAILED',
      requestId: 2,
      error: 'Someone else saved.',
      reloadRequired: true,
    });
    expect(conflict.phase).toBe('RELOAD_REQUIRED');
    const invalid = featuresReducer(saving, {
      type: 'SAVE_FAILED',
      requestId: 2,
      error: 'Not a rule.',
      reloadRequired: false,
    });
    expect(invalid.phase).toBe('READY');
  });
});

describe('history', () => {
  it('refuses a page that does not continue the one before it', () => {
    const first = featuresHistoryReducer(
      featuresHistoryReducer(initialFeaturesHistory, { type: 'LOAD', requestId: 1 }),
      {
        type: 'LOADED',
        requestId: 1,
        history: {
          entries: [
            {
              revision: 4,
              updatedAt: 1,
              updatedBy: 'p',
              updatedByName: 'P',
              reason: 'r',
              restoredFromRevision: null,
              rules: {},
            },
          ],
          nextBeforeRevision: 4,
        },
      },
    );
    expect(first.entries.map((e) => e.revision)).toEqual([4]);
    const wrong = featuresHistoryReducer(
      featuresHistoryReducer(first, { type: 'LOAD', requestId: 2 }),
      {
        type: 'LOADED',
        requestId: 2,
        beforeRevision: 2,
        history: { entries: [], nextBeforeRevision: null },
      },
    );
    expect(wrong.error).toMatch(/inconsistent/);
  });
});
