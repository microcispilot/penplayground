// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dayLabel } from '../src/lib/format.js';
import {
  BUCKET_MS,
  bucketFor,
  DEFAULT_CHOICE,
  describeRange,
  MAX_WINDOW_DAYS,
  periodsElapsed,
  RANGES,
  rangeQuery,
  readChoice,
  resolveRange,
  startOfDayUtc,
  toIsoDate,
  writeChoice,
} from '../src/lib/range.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 19, 10, 30); // 2026-09-19T10:30:00Z

/**
 * The date range, against the server that has to answer it.
 *
 * The first test is the one that matters most: the console's default view
 * and a bare call to any reporting endpoint must describe the same window,
 * or every number on the first screen is quietly for a different period than
 * the API's own idea of "recently". It is asserted against `routes.ts`
 * itself rather than against a number copied out of it.
 */

const ROUTES = readFileSync(
  fileURLToPath(new URL('../../../services/api/src/stats/routes.ts', import.meta.url)),
  'utf8',
);

/**
 * `const DEFAULT_WINDOW_MS = 30 * 86_400_000;` read as a number — the product
 * of its factors, not `eval`. If the declaration ever stops being a product
 * of literals this throws rather than quietly agreeing with itself.
 */
function constant(name: string): number {
  const found = new RegExp(`const ${name} = ([^;]+);`).exec(ROUTES);
  if (!found?.[1]) throw new Error(`routes.ts no longer declares ${name}`);
  const factors = found[1].split('*').map((part) => Number(part.trim().replace(/_/g, '')));
  if (factors.some((f) => !Number.isFinite(f)))
    throw new Error(`${name} is no longer a product of literals: ${found[1]}`);
  return factors.reduce((a, b) => a * b, 1);
}

describe('the default is the API’s own default', () => {
  it('matches DEFAULT_WINDOW_MS in routes.ts', () => {
    // `const DEFAULT_WINDOW_MS = 30 * 86_400_000;`
    const declared = constant('DEFAULT_WINDOW_MS');
    const range = resolveRange(DEFAULT_CHOICE, NOW);
    expect(range.to).toBe(NOW);
    expect(range.to - range.from).toBe(declared);
  });

  it('matches MAX_WINDOW_MS in routes.ts', () => {
    expect(MAX_WINDOW_DAYS * DAY).toBe(constant('MAX_WINDOW_MS'));
  });

  it('defaults the bucket to the one BucketQuery defaults to', () => {
    expect(ROUTES).toContain("z.enum(['hour', 'day', 'week', 'month']).default('day')");
    expect(resolveRange(DEFAULT_CHOICE, NOW).bucket).toBe('day');
  });

  it('is the first preset, so the control opens on it', () => {
    expect(RANGES[0]?.id).toBe(DEFAULT_CHOICE.presetId);
  });
});

describe('presets', () => {
  it('measures back from the moment it was resolved', () => {
    const range = resolveRange({ presetId: '7d' }, NOW);
    expect(range.to).toBe(NOW);
    expect(range.from).toBe(NOW - 7 * DAY);
    expect(range.bucket).toBe('day');
  });

  it('takes the preset’s bucket unless one was chosen', () => {
    expect(resolveRange({ presetId: '365d' }, NOW).bucket).toBe('month');
    expect(resolveRange({ presetId: '365d', bucket: 'week' }, NOW).bucket).toBe('week');
    expect(resolveRange({ presetId: '365d', bucket: 'week' }, NOW).bucketPinned).toBe(true);
    expect(resolveRange({ presetId: '365d' }, NOW).bucketPinned).toBe(false);
  });

  it('falls back to the default when the URL names a preset that does not exist', () => {
    expect(resolveRange({ presetId: 'last-tuesday' }, NOW).presetId).toBe(DEFAULT_CHOICE.presetId);
  });
});

describe('a custom range is whole UTC days, both ends inclusive', () => {
  it('ends at midnight after the last day, because the window is half-open', () => {
    const range = resolveRange(
      { presetId: 'custom', fromDate: '2026-03-01', toDate: '2026-03-03' },
      NOW,
    );
    expect(range.from).toBe(Date.UTC(2026, 2, 1));
    expect(range.to).toBe(Date.UTC(2026, 2, 4));
    // Three whole days, not two-and-a-bit.
    expect(range.to - range.from).toBe(3 * DAY);
  });

  it('swaps two dates given the wrong way round', () => {
    const a = resolveRange(
      { presetId: 'custom', fromDate: '2026-03-03', toDate: '2026-03-01' },
      NOW,
    );
    const b = resolveRange(
      { presetId: 'custom', fromDate: '2026-03-01', toDate: '2026-03-03' },
      NOW,
    );
    expect(a).toEqual(b);
  });

  it('falls back to the default rather than rendering an error page', () => {
    const range = resolveRange({ presetId: 'custom', fromDate: 'yesterday' }, NOW);
    expect(range.presetId).toBe(DEFAULT_CHOICE.presetId);
  });

  it('refuses a date that is not one, including a rolled-over day', () => {
    expect(startOfDayUtc('2026-02-31')).toBeNull();
    expect(startOfDayUtc('2026-13-01')).toBeNull();
    expect(startOfDayUtc('not-a-date')).toBeNull();
    expect(startOfDayUtc('2026-02-28')).toBe(Date.UTC(2026, 1, 28));
  });

  it('round-trips a date through the input’s own format', () => {
    expect(toIsoDate(Date.UTC(2026, 0, 5))).toBe('2026-01-05');
    expect(startOfDayUtc(toIsoDate(NOW))).toBe(Date.UTC(2026, 8, 19));
  });

  it('flags a window the server will clamp', () => {
    const wide = resolveRange(
      { presetId: 'custom', fromDate: '2024-01-01', toDate: '2026-01-01' },
      NOW,
    );
    expect(wide.clamped).toBe(true);
    expect(resolveRange(DEFAULT_CHOICE, NOW).clamped).toBe(false);
  });
});

describe('buckets', () => {
  it('chooses a readable number of columns for a custom span', () => {
    expect(bucketFor(DAY)).toBe('hour');
    expect(bucketFor(30 * DAY)).toBe('day');
    expect(bucketFor(120 * DAY)).toBe('week');
    expect(bucketFor(365 * DAY)).toBe('month');
  });

  it('carries the same bucket lengths the server computes cohorts with', () => {
    // BUCKET_MS in packages/db/src/reports.ts — a month is thirty days there.
    expect(BUCKET_MS).toEqual({
      hour: 3_600_000,
      day: DAY,
      week: 7 * DAY,
      month: 30 * DAY,
    });
  });

  it('knows how many cohort periods have actually happened', () => {
    const to = Date.UTC(2026, 8, 19);
    // A cohort formed today has had exactly one period: its own.
    expect(periodsElapsed(to, to, 'day')).toBe(1);
    expect(periodsElapsed(to - 3 * DAY, to, 'day')).toBe(4);
    expect(periodsElapsed(to - 21 * DAY, to, 'week')).toBe(4);
  });
});

describe('the URL', () => {
  it('leaves the default out, so the ordinary console URL is clean', () => {
    const written = writeChoice(new URLSearchParams(), DEFAULT_CHOICE);
    expect(written.toString()).toBe('');
  });

  it('round-trips a custom range and a pinned bucket', () => {
    const choice = {
      presetId: 'custom',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      bucket: 'week' as const,
    };
    const written = writeChoice(new URLSearchParams(), choice);
    expect(readChoice(written)).toEqual(choice);
  });

  it('keeps parameters that are not the range’s', () => {
    const written = writeChoice(new URLSearchParams('plan=free&page=2'), { presetId: '7d' });
    expect(written.get('plan')).toBe('free');
    expect(written.get('page')).toBe('2');
    expect(written.get('range')).toBe('7d');
  });

  it('ignores a bucket the endpoints do not accept', () => {
    expect(readChoice(new URLSearchParams('bucket=fortnight')).bucket).toBeUndefined();
  });

  it('drops the custom dates when a preset is chosen again', () => {
    const written = writeChoice(new URLSearchParams('range=custom&from=2026-03-01&to=2026-03-31'), {
      presetId: '7d',
    });
    expect(written.get('from')).toBeNull();
    expect(written.get('to')).toBeNull();
  });
});

describe('what the endpoints are sent, and what the page says', () => {
  it('sends the three parameters every report takes', () => {
    const range = resolveRange({ presetId: '7d' }, NOW);
    expect(rangeQuery(range)).toEqual({
      from: String(NOW - 7 * DAY),
      to: String(NOW),
      bucket: 'day',
    });
  });

  it('describes the last day the window actually covers, not the exclusive end', () => {
    const range = resolveRange(
      { presetId: 'custom', fromDate: '2026-03-01', toDate: '2026-03-03' },
      NOW,
    );
    expect(describeRange(range, dayLabel)).toBe('1 Mar 2026 – 3 Mar 2026');
  });
});
