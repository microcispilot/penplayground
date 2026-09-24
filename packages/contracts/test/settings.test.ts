import { describe, expect, it } from 'vitest';
import {
  type ChoiceRule,
  choiceMatrix,
  choicesEqual,
  choiceValuesValid,
  normaliseChoice,
  resolveChoice,
  SETTINGS,
  settingFor,
  VOICE_ENGINES,
} from '../src/index.js';

/**
 * A setting resolves like a flag but carries a value (ADR-0048): the
 * person first, then the visitor's answer, the cell, the plan, the
 * platform, the default.
 */
const base: ChoiceRule = {
  default: 'cartesia',
  plans: {},
  platforms: {},
  cells: {},
  participants: {},
};

describe('resolveChoice', () => {
  it('falls to the default when nothing speaks', () => {
    expect(resolveChoice(base, 'free', 'web')).toBe('cartesia');
  });

  it('lets the plan win over the platform, and the cell over both', () => {
    const r: ChoiceRule = {
      ...base,
      plans: { professional: 'fish' },
      platforms: { 'desktop-mac': 'cartesia' },
      cells: { 'professional:desktop-mac': 'cartesia', 'free:web': 'fish' },
    };
    expect(resolveChoice(r, 'professional', 'web')).toBe('fish');
    expect(resolveChoice(r, 'standard', 'desktop-mac')).toBe('cartesia');
    expect(resolveChoice(r, 'professional', 'desktop-mac')).toBe('cartesia');
    expect(resolveChoice(r, 'free', 'web')).toBe('fish');
  });

  it('answers a visitor first, and a named account before everything', () => {
    const r: ChoiceRule = {
      ...base,
      anonymous: 'fish',
      cells: { 'free:web': 'cartesia' },
      participants: { p_owner01: 'fish' },
    };
    expect(resolveChoice(r, 'free', 'web', { anonymous: true })).toBe('fish');
    expect(resolveChoice(r, 'free', 'web', { anonymous: false })).toBe('cartesia');
    expect(resolveChoice(r, 'professional', 'web', { participantId: 'p_owner01' })).toBe('fish');
    expect(resolveChoice(r, 'free', 'web', { anonymous: true, participantId: 'p_someone' })).toBe(
      'fish',
    );
  });

  it('draws the matrix from the same rule', () => {
    const m = choiceMatrix({ ...base, plans: { standard: 'fish' } });
    expect(m.standard.web).toBe('fish');
    expect(m.free.ios).toBe('cartesia');
  });
});

describe('the catalogue', () => {
  it('speaks with Cartesia unless told otherwise', () => {
    expect(SETTINGS.voice_engine.rule.default).toBe('cartesia');
    expect(settingFor({}, 'voice_engine', 'free', 'web')).toBe('cartesia');
    expect(
      settingFor({ voice_engine: { ...base, default: 'fish' } }, 'voice_engine', 'free', 'web'),
    ).toBe('fish');
    expect(SETTINGS.voice_engine.values).toEqual(VOICE_ENGINES);
  });

  it('refuses a value the setting does not name, and says where', () => {
    expect(choiceValuesValid(base, VOICE_ENGINES)).toBeNull();
    expect(choiceValuesValid({ ...base, plans: { free: 'eleven' } }, VOICE_ENGINES)).toMatch(
      /plan free: "eleven"/,
    );
    expect(choiceValuesValid({ ...base, participants: { p_x: 'nope' } }, VOICE_ENGINES)).toMatch(
      /participant p_x/,
    );
  });

  it('normalises and compares without caring about empty answers', () => {
    const noisy: ChoiceRule = {
      ...base,
      plans: { free: '' },
      anonymous: '',
      participants: { p_a: 'fish', p_b: '' },
    };
    expect(normaliseChoice(noisy)).toEqual({ ...base, participants: { p_a: 'fish' } });
    expect(choicesEqual(noisy, { ...base, participants: { p_a: 'fish' } })).toBe(true);
    expect(choicesEqual(noisy, base)).toBe(false);
  });
});
