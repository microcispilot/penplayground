import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  count,
  countCompact,
  countryLabel,
  dayLabel,
  dayOfWeekLabel,
  duration,
  geoSourceLabel,
  hourLabel,
  leaveReasonLabel,
  moment,
  percent,
  planLabel,
  referrerLabel,
  reuseKindLabel,
  screenLabel,
  shortId,
  stageLabel,
  usd,
  usdCompact,
} from '../src/lib/format.js';

/**
 * How the statistics pages read numbers.
 *
 * The cases that matter are the edges, and every one of them here is a way a
 * dashboard lies if it gets it wrong: a third of a cent shown as "$0.00", a
 * null shown as "0", a UTC bucket labelled in the reader's own zone.
 */

describe('money', () => {
  it('keeps a fraction of a cent visible rather than rounding it to nothing', () => {
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(0.0001)).toBe('$0.0001');
    // A lesson that really did cost a third of a cent must not read as free.
    expect(usd(0.0042)).not.toBe('$0.00');
  });

  it('is two places once the amount is worth cents', () => {
    expect(usd(0.005)).toBe('$0.01');
    expect(usd(12.3456)).toBe('$12.35');
    expect(usd(1234.5)).toBe('$1,234.50');
  });

  it('prints zero as a number, because a window with no lessons cost nothing', () => {
    expect(usd(0)).toBe('$0.00');
  });

  it('keeps the sign', () => {
    expect(usd(-3.5)).toBe('-$3.50');
  });

  it('compacts only where a tile would otherwise wrap', () => {
    expect(usdCompact(999)).toBe('$999.00');
    expect(usdCompact(12_345)).toBe('$12.3k');
    expect(usdCompact(2_400_000)).toBe('$2.4M');
  });

  it('says nothing it cannot say', () => {
    expect(usd(Number.NaN)).toBe('—');
    expect(usdCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('counts and rates', () => {
  it('groups thousands without asking the runtime for a locale', () => {
    expect(count(1234)).toBe('1,234');
    expect(count(1_000_000)).toBe('1,000,000');
    expect(count(0)).toBe('0');
  });

  it('compacts above ten thousand and not below', () => {
    expect(countCompact(9999)).toBe('9,999');
    expect(countCompact(12_345)).toBe('12.3k');
    expect(countCompact(3_400_000)).toBe('3.4M');
  });

  it('keeps a decimal on a rate below one percent', () => {
    expect(percent(0.004)).toBe('0.4%');
    expect(percent(0.732)).toBe('73%');
    expect(percent(1)).toBe('100%');
    expect(percent(0)).toBe('0%');
  });
});

describe('durations', () => {
  it('reads at the granularity a person can hold', () => {
    expect(duration(840)).toBe('840ms');
    expect(duration(1234)).toBe('1.2s');
    expect(duration(45_000)).toBe('45s');
    expect(duration(750_000)).toBe('12m 30s');
    expect(duration(3_900_000)).toBe('1h 05m');
    expect(duration(400_000_000)).toBe('4d 15h');
  });

  it('distinguishes never from zero', () => {
    // `time_to_first_audio_ms` is null when no audio ever played. That is a
    // different fact from a session that lasted no time, and the page has to
    // be able to say which.
    expect(duration(null)).toBe('—');
    expect(duration(undefined)).toBe('—');
    expect(duration(0)).toBe('0s');
  });
});

describe('bucket labels', () => {
  // 2026-03-03T14:30:00Z
  const at = Date.UTC(2026, 2, 3, 14, 30);

  it('labels a UTC bucket in UTC, whatever zone the reader is in', () => {
    expect(bucketLabel(at, 'hour')).toBe('3 Mar 14:00');
    expect(bucketLabel(at, 'day')).toBe('3 Mar');
    expect(bucketLabel(at, 'week')).toBe('w/c 3 Mar');
    expect(bucketLabel(at, 'month')).toBe('Mar 2026');
  });

  it('prints a whole date for a range summary', () => {
    expect(dayLabel(at)).toBe('3 Mar 2026');
  });

  it('reads a single moment in the reader’s own zone, with an ISO twin', () => {
    const m = moment(at);
    expect(m.iso).toBe(new Date(at).toISOString());
    expect(m.text).not.toBe('—');
    expect(moment(0).text).toBe('—');
  });

  it('names days and hours', () => {
    expect(dayOfWeekLabel(0)).toBe('Sun');
    expect(dayOfWeekLabel(6)).toBe('Sat');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});

describe('the product’s own words', () => {
  it('says every leave reason the derivation can produce', () => {
    // The eight in docs/STATISTICS.md, "Why a learner stopped".
    for (const reason of [
      'completed',
      'length_ceiling',
      'never_started',
      'left_during_ad',
      'left_after_error',
      'left_mid_segment',
      'idle_timeout',
      'unknown',
    ])
      expect(leaveReasonLabel(reason)).not.toBe(reason);
  });

  it('falls back to the raw name rather than to “unknown”', () => {
    expect(leaveReasonLabel('something_new')).toBe('Something new');
    expect(stageLabel('some_future_stage')).toBe('Some future stage');
  });

  it('names every stage the telemetry contract declares', () => {
    for (const stage of [
      'intake',
      'resolve',
      'context',
      'prepare',
      'llm',
      'intent',
      'image',
      'tts',
      'stt',
      'board',
      'turn',
      'ad',
      'join',
      'leave',
    ])
      expect(stageLabel(stage).length).toBeGreaterThan(0);
  });

  it('names every reuse kind ADR-0027 records', () => {
    for (const kind of ['pack', 'lesson', 'card', 'picture', 'voice'])
      expect(reuseKindLabel(kind)).not.toBe(kind);
  });

  it('spells the plan and its billing period the way the owner asks for them', () => {
    expect(planLabel('free')).toBe('Free');
    expect(planLabel('standard', 'month')).toBe('Personal, monthly');
    expect(planLabel('standard', 'year')).toBe('Personal, yearly');
    // Blank on a paid row that predates `plan_interval`, and the label must
    // not invent one.
    expect(planLabel('professional', null)).toBe('Professional');
  });
});

describe('places, screens and referrers', () => {
  it('turns a country code into a name and keeps an unknown code visible', () => {
    expect(countryLabel('US')).toContain('United States');
    // CLDR knows ZZ as the literal "Unknown Region"; QQ is unassigned, and
    // an unassigned code has to print as itself — the code is still a fact.
    expect(countryLabel('QQ')).toBe('QQ');
    expect(countryLabel(null)).toBe('Not known');
  });

  it('names the geography signal rather than printing its code', () => {
    expect(geoSourceLabel('timezone')).toBe('From the browser’s timezone');
    expect(geoSourceLabel('edge')).toBe('From the edge');
    expect(geoSourceLabel('none')).toBe('Nothing was available');
  });

  it('says where a visit with no referrer came from', () => {
    expect(referrerLabel(null, null)).toBe('Typed or bookmarked');
    expect(referrerLabel('news.ycombinator.com', null)).toBe('news.ycombinator.com');
    expect(referrerLabel('x.com', 'launch')).toBe('x.com · launch');
  });

  it('names the root screen', () => {
    expect(screenLabel('/')).toBe('Home');
    expect(screenLabel('')).toBe('Home');
    expect(screenLabel('/sessions/:id')).toBe('/sessions/:id');
  });

  it('shortens an id without inventing one', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('s_0123456789abcdef')).toBe('s_01234567…');
  });
});
