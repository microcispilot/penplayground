import { describe, expect, it } from 'vitest';
import {
  guestsPerRoom,
  PLAN_LIMITS,
  type PlanCode,
  PlanUsage,
  planLimits,
  sessionsRemaining,
  utcDayStart,
} from '../src/index.js';

/**
 * The plan promises in docs/PRODUCT.md, pinned as numbers. These are the
 * server's answer to "may I start a session"; a silent drift here would change
 * what a learner paid for.
 */
const DAY = 86_400_000;
const PLANS: readonly PlanCode[] = ['free', 'standard', 'professional'];

describe('PLAN_LIMITS', () => {
  it('holds the published allowances for every plan', () => {
    expect(PLAN_LIMITS).toEqual({
      free: { sessionsPerDay: 3, maxSessionMinutes: 20, maxParticipants: 1 },
      standard: { sessionsPerDay: null, maxSessionMinutes: 45, maxParticipants: 1 },
      professional: { sessionsPerDay: null, maxSessionMinutes: 60, maxParticipants: 12 },
    });
    for (const plan of PLANS) expect(planLimits(plan)).toBe(PLAN_LIMITS[plan]);
  });

  it('seats guests only in a Professional room', () => {
    expect(guestsPerRoom('free')).toBe(0);
    expect(guestsPerRoom('standard')).toBe(0);
    expect(guestsPerRoom('professional')).toBe(11);
  });
});

describe('utcDayStart', () => {
  it('lands on midnight UTC and is idempotent', () => {
    const noon = Date.UTC(2026, 8, 17, 12, 34, 56, 789);
    const midnight = Date.UTC(2026, 8, 17);
    expect(utcDayStart(noon)).toBe(midnight);
    expect(new Date(utcDayStart(noon)).toISOString()).toBe('2026-09-17T00:00:00.000Z');
    expect(utcDayStart(utcDayStart(noon))).toBe(midnight);
  });

  it('puts the millisecond before midnight in the previous day', () => {
    const midnight = Date.UTC(2026, 8, 17);
    expect(utcDayStart(midnight - 1)).toBe(midnight - DAY);
    expect(utcDayStart(midnight)).toBe(midnight);
  });

  it('does not drift across a DST change in the host timezone', () => {
    // Quotas reset at one moment worldwide, so only UTC may decide the day.
    const before = Date.UTC(2026, 2, 8, 6, 0);
    const after = Date.UTC(2026, 2, 8, 18, 0);
    expect(utcDayStart(before)).toBe(utcDayStart(after));
  });
});

describe('sessionsRemaining', () => {
  it('counts the free plan down and floors at zero', () => {
    expect(sessionsRemaining('free', 0)).toBe(3);
    expect(sessionsRemaining('free', 1)).toBe(2);
    expect(sessionsRemaining('free', 3)).toBe(0);
    expect(sessionsRemaining('free', 9)).toBe(0);
  });

  it('is null for the unlimited plans, however many were started', () => {
    expect(sessionsRemaining('standard', 0)).toBeNull();
    expect(sessionsRemaining('standard', 50)).toBeNull();
    expect(sessionsRemaining('professional', 50)).toBeNull();
  });
});

describe('PlanUsage', () => {
  const usage: PlanUsage = {
    plan: 'free',
    sessionsToday: 1,
    sessionsPerDay: 3,
    remaining: 2,
    maxSessionMinutes: 20,
    resetsAt: Date.UTC(2026, 8, 18),
    canStart: true,
    reason: null,
  };

  it('round-trips a valid payload, unlimited plans included', () => {
    expect(PlanUsage.parse(usage)).toEqual(usage);
    const unlimited: PlanUsage = {
      ...usage,
      plan: 'professional',
      sessionsPerDay: null,
      remaining: null,
      maxSessionMinutes: 60,
    };
    expect(PlanUsage.parse(unlimited)).toEqual(unlimited);
  });

  it('rejects a negative session count', () => {
    expect(PlanUsage.safeParse({ ...usage, sessionsToday: -1 }).success).toBe(false);
  });

  it('rejects a reason the client has no wording for', () => {
    expect(PlanUsage.safeParse({ ...usage, reason: 'because' }).success).toBe(false);
  });
});
