import type { Expert } from '@pen/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultExpertFor, resetDefaultExpertForTests } from '../src/lib/default-expert.js';

/**
 * Who sits in the search box before anything is typed (ADR-0040): the
 * account's default when the plan includes them, else one the plan includes
 * at random, chosen once per visit.
 */
const expert = (id: string, requiredPlan: Expert['requiredPlan']): Expert =>
  ({ id, displayName: id, requiredPlan }) as unknown as Expert;

const CATALOGUE: Expert[] = [
  expert('elena-biology-professor', null),
  expert('soren-philosophy-professor', null),
  expert('niko-database-expert', 'standard'),
  expert('socrates', 'standard'),
  expert('isaac-newton', 'professional'),
];

describe('defaultExpertFor', () => {
  beforeEach(() => resetDefaultExpertForTests());

  it('gives the free plan one of its two, at random, and only those', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      resetDefaultExpertForTests();
      seen.add(defaultExpertFor(CATALOGUE, { plan: 'free' })?.id ?? '');
    }
    expect([...seen].sort()).toEqual(['elena-biology-professor', 'soren-philosophy-professor']);
  });

  it('keeps the visit’s pick until the visit is over', () => {
    const first = defaultExpertFor(CATALOGUE, { plan: 'free' }, () => 0.9);
    const again = defaultExpertFor(CATALOGUE, { plan: 'free' }, () => 0.1);
    expect(again?.id).toBe(first?.id);
    resetDefaultExpertForTests();
    expect(defaultExpertFor(CATALOGUE, { plan: 'free' }, () => 0.1)?.id).toBe(
      'elena-biology-professor',
    );
  });

  it('starts a paying learner with their own default when the plan still includes them', () => {
    expect(defaultExpertFor(CATALOGUE, { plan: 'standard', defaultExpertId: 'socrates' })?.id).toBe(
      'socrates',
    );
    // A default above the plan is not honoured: a Standard learner who once
    // chose Newton on Professional gets the visit's pick instead.
    const fallen = defaultExpertFor(
      CATALOGUE,
      { plan: 'standard', defaultExpertId: 'isaac-newton' },
      () => 0,
    );
    expect(fallen?.id).not.toBe('isaac-newton');
    expect(fallen?.requiredPlan === null || fallen?.requiredPlan === 'standard').toBe(true);
  });

  it('never picks an expert the plan does not include', () => {
    for (let i = 0; i < 30; i += 1) {
      resetDefaultExpertForTests();
      const pick = defaultExpertFor(CATALOGUE, { plan: 'standard' });
      expect(pick?.requiredPlan).not.toBe('professional');
    }
  });

  it('is null with nothing to choose from', () => {
    expect(defaultExpertFor([], { plan: 'free' })).toBeNull();
  });
});
