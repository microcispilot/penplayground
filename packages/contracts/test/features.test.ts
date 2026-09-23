import { describe, expect, it } from 'vitest';
import {
  cellKey,
  defaultFeaturesFor,
  FEATURE_NAMES,
  FEATURES,
  FeatureFlagsMutation,
  FeatureRule,
  featuresFor,
  hasEntitlement,
  normaliseRule,
  PLATFORMS,
  PlanCode,
  platformFromHeader,
  resolveRule,
  ruleMatrix,
  rulesEqual,
} from '../src/index.js';

/**
 * The resolution order is the whole contract (ADR-0036): a cell beats the
 * axes, the axes AND together, and the default is the floor. Every server
 * check and every screen reads through these functions, so the order is
 * pinned here rather than remembered.
 */
describe('resolveRule', () => {
  const base: FeatureRule = { default: true, plans: {}, platforms: {}, cells: {} };

  it('falls to the default when nothing else speaks', () => {
    expect(resolveRule(base, 'free', 'web')).toBe(true);
    expect(resolveRule({ ...base, default: false }, 'professional', 'ios')).toBe(false);
  });

  it('a plan answer covers every platform, and a platform answer every plan', () => {
    const noFree = { ...base, plans: { free: false } };
    for (const platform of PLATFORMS) expect(resolveRule(noFree, 'free', platform)).toBe(false);
    expect(resolveRule(noFree, 'standard', 'web')).toBe(true);

    const noDesktop = { ...base, platforms: { 'desktop-mac': false } };
    for (const plan of PlanCode.options)
      expect(resolveRule(noDesktop, plan, 'desktop-mac')).toBe(false);
    expect(resolveRule(noDesktop, 'free', 'web')).toBe(true);
  });

  it('when both axes speak they AND: "off on desktop" is off there whatever the plan says', () => {
    const r: FeatureRule = {
      default: false,
      plans: { professional: true },
      platforms: { 'desktop-mac': false, web: true },
      cells: {},
    };
    expect(resolveRule(r, 'professional', 'web')).toBe(true);
    expect(resolveRule(r, 'professional', 'desktop-mac')).toBe(false);
    // Plan says nothing, platform says yes: the platform's word stands over the default.
    expect(resolveRule(r, 'free', 'web')).toBe(true);
    // Neither speaks: the default.
    expect(resolveRule(r, 'free', 'android')).toBe(false);
  });

  it('a cell is the last word, in either direction', () => {
    const r: FeatureRule = {
      default: false,
      plans: { free: false },
      platforms: { web: false },
      cells: { [cellKey('free', 'web')]: true, [cellKey('professional', 'ios')]: false },
    };
    expect(resolveRule(r, 'free', 'web')).toBe(true);
    expect(resolveRule(r, 'professional', 'ios')).toBe(false);
  });
});

describe('the compiled-in rules', () => {
  it('say what the entitlement table says, plan by plan, where they overlap', () => {
    for (const plan of PlanCode.options) {
      const f = defaultFeaturesFor(plan);
      expect(f.rooms).toBe(hasEntitlement(plan, 'rooms'));
      expect(f.session_download).toBe(hasEntitlement(plan, 'export'));
      expect(f.ads).toBe(!hasEntitlement(plan, 'no_ads'));
    }
  });

  it('keep the expensive path off the free plan and on for everyone who pays', () => {
    expect(defaultFeaturesFor('free').prepare_new_topics).toBe(false);
    expect(defaultFeaturesFor('standard').prepare_new_topics).toBe(true);
    expect(defaultFeaturesFor('professional').prepare_new_topics).toBe(true);
  });

  it("leave a prepared lesson startable, watchable by its host, and the room's furniture on", () => {
    for (const plan of PlanCode.options) {
      const f = defaultFeaturesFor(plan);
      expect(f.quick_start).toBe(true);
      expect(f.recording_playback).toBe(true);
      expect(f.chat).toBe(true);
      expect(f.reactions).toBe(true);
      expect(f.captions).toBe(true);
      expect(f.email_sign_in).toBe(true);
    }
  });

  it('hide Google sign-in where Google refuses to run', () => {
    expect(defaultFeaturesFor('free', 'web').google_sign_in).toBe(true);
    expect(defaultFeaturesFor('free', 'desktop-mac').google_sign_in).toBe(false);
    expect(defaultFeaturesFor('professional', 'ios').google_sign_in).toBe(false);
  });

  it('every feature has a label, a description and a group', () => {
    for (const name of FEATURE_NAMES) {
      expect(FEATURES[name].label.length).toBeGreaterThan(0);
      expect(FEATURES[name].description.length).toBeGreaterThan(0);
      expect(FEATURES[name].group.length).toBeGreaterThan(0);
    }
  });
});

describe('featuresFor', () => {
  it('a stored rule replaces the compiled-in one for that feature and nothing else', () => {
    const doc = { prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} } };
    const free = featuresFor(doc, 'free', 'web');
    expect(free.prepare_new_topics).toBe(true);
    expect(free.session_download).toBe(false);
  });

  it('answers every feature, so a screen never has to know what exists', () => {
    expect(Object.keys(featuresFor({}, 'free', 'web')).sort()).toEqual([...FEATURE_NAMES].sort());
  });
});

describe('ruleMatrix', () => {
  it('is the rule resolved for every plan on every platform', () => {
    const m = ruleMatrix(FEATURES.google_sign_in.rule);
    expect(m.free.web).toBe(true);
    expect(m.free['desktop-windows']).toBe(false);
    expect(Object.keys(m)).toEqual(PlanCode.options);
    expect(Object.keys(m.free)).toEqual(PLATFORMS);
  });
});

describe('normaliseRule and rulesEqual', () => {
  it('treat an empty override map and an absent one as the same rule', () => {
    const a: FeatureRule = { default: true, plans: {}, platforms: {}, cells: {} };
    const b = {
      default: true,
      plans: { free: undefined },
      platforms: {},
      cells: {},
    } as FeatureRule;
    expect(normaliseRule(b)).toEqual(a);
    expect(rulesEqual(a, b)).toBe(true);
    expect(rulesEqual(a, { ...a, plans: { free: false } })).toBe(false);
  });
});

describe('the wire', () => {
  it('refuses a cell key that is not plan:platform', () => {
    const bad = FeatureRule.safeParse({
      default: true,
      plans: {},
      platforms: {},
      cells: { 'gold:web': true },
    });
    expect(bad.success).toBe(false);
  });

  it('a mutation is the whole document with null meaning "back to the compiled-in rule"', () => {
    const m = FeatureFlagsMutation.safeParse({
      expectedRevision: 3,
      reason: 'open preparation to free for the launch week',
      rules: {
        prepare_new_topics: { default: true, plans: {}, platforms: {}, cells: {} },
        ads: null,
      },
    });
    expect(m.success).toBe(true);
  });

  it('reads the platform header leniently and never invents a platform', () => {
    expect(platformFromHeader('desktop-mac')).toBe('desktop-mac');
    expect(platformFromHeader(' IOS ')).toBe('ios');
    expect(platformFromHeader('vision-pro')).toBe('web');
    expect(platformFromHeader(undefined)).toBe('web');
  });
});
