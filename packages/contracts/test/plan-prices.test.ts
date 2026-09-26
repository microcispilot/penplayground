import { describe, expect, it } from 'vitest';
import { monthlyEquivalentUsd, PLAN_PRICES_USD, PlanCode } from '../src/index.js';

/**
 * The prices in docs/PRODUCT.md and on the pricing page, pinned (ADR-0056).
 * The owner set them on 2026-09-25: Standard 29, Professional 49, a year at
 * ten months. A change here is a pricing decision, and it is made in the
 * ADR first.
 */
describe('plan prices', () => {
  it('are 0, 29 and 49 a month', () => {
    expect(PLAN_PRICES_USD.free.month).toBe(0);
    expect(PLAN_PRICES_USD.standard.month).toBe(29);
    expect(PLAN_PRICES_USD.professional.month).toBe(49);
  });

  it('charge ten months for a year, so "two months free" is true', () => {
    for (const plan of PlanCode.options) {
      const { month, year } = PLAN_PRICES_USD[plan];
      expect(year, plan).toBe(month * 10);
    }
  });

  it('are whole dollars, never fractions a card would round', () => {
    for (const plan of PlanCode.options)
      for (const usd of Object.values(PLAN_PRICES_USD[plan]))
        expect(Number.isInteger(usd)).toBe(true);
  });

  it('spread the year over twelve months on the page', () => {
    expect(monthlyEquivalentUsd('standard', 'month')).toBe(29);
    expect(monthlyEquivalentUsd('standard', 'year')).toBe(24);
    expect(monthlyEquivalentUsd('professional', 'year')).toBe(41);
    expect(monthlyEquivalentUsd('free', 'year')).toBe(0);
  });
});
