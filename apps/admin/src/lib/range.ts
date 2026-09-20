/**
 * The date range every statistics page reads, and the one place it is decided.
 *
 * The reporting API takes `from` and `to` in milliseconds, half-open
 * `[from, to)`, and a `bucket` of `hour|day|week|month`; with no parameters
 * at all it answers for the last thirty days by day
 * (`DEFAULT_WINDOW_MS` and `BucketQuery` in `services/api/src/stats/routes.ts`).
 * **`RANGES[0]` reproduces exactly that**, so the console's default view and a
 * bare call to any endpoint are the same window — a page cannot quietly
 * disagree with the API's own idea of "recently".
 *
 * The choice lives in the URL rather than in React state, for three reasons:
 * a reload keeps it, a link carries it, and moving between the seven pages
 * cannot lose it. What is stored is the *preset*, not the resolved
 * milliseconds — `?range=30d` still means the last thirty days tomorrow,
 * where `?from=…&to=…` would freeze. A custom range stores its two dates.
 */

export type Bucket = 'hour' | 'day' | 'week' | 'month';

export const BUCKETS: readonly Bucket[] = ['hour', 'day', 'week', 'month'];

export interface RangePreset {
  id: string;
  label: string;
  /** How far back from now, in days. */
  days: number;
  /** The bucket this span reads best at, unless the operator says otherwise. */
  bucket: Bucket;
}

/**
 * `RANGES[0]` is the API's own default and must stay so: thirty days, by day.
 * `range.test.ts` asserts it against the constants in `routes.ts`.
 */
export const RANGES: readonly RangePreset[] = [
  { id: '30d', label: '30 days', days: 30, bucket: 'day' },
  { id: '24h', label: '24 hours', days: 1, bucket: 'hour' },
  { id: '7d', label: '7 days', days: 7, bucket: 'day' },
  { id: '90d', label: '90 days', days: 90, bucket: 'week' },
  { id: '365d', label: '12 months', days: 365, bucket: 'month' },
];

/** `MAX_WINDOW_MS` in `routes.ts`: a request past this is clamped by the server. */
export const MAX_WINDOW_DAYS = 400;

const DAY_MS = 86_400_000;

export interface ReportRange {
  /** `[from, to)`, in ms epoch, exactly as the endpoints take it. */
  from: number;
  to: number;
  bucket: Bucket;
  /** The preset this came from, or `custom`. */
  presetId: string;
  /** True when the operator picked the bucket rather than taking the preset's. */
  bucketPinned: boolean;
  /** The server will clamp a window wider than `MAX_WINDOW_DAYS`. */
  clamped: boolean;
}

/** The state that is written to the URL — never the resolved milliseconds. */
export interface RangeChoice {
  presetId: string;
  /** `YYYY-MM-DD`, UTC, both inclusive. Only read when `presetId` is `custom`. */
  fromDate?: string;
  toDate?: string;
  bucket?: Bucket;
}

export const DEFAULT_CHOICE: RangeChoice = { presetId: RANGES[0]?.id ?? '30d' };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC at the start of a `YYYY-MM-DD`, or null if it is not one. */
export function startOfDayUtc(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  // Rejects 2026-02-31 and friends: `Date.UTC` rolls them over silently.
  const back = new Date(ms);
  if (back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return null;
  return ms;
}

export function toIsoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function presetById(id: string): RangePreset | null {
  return RANGES.find((r) => r.id === id) ?? null;
}

/**
 * The choice, turned into the three query parameters an endpoint takes.
 *
 * A custom range is read as whole UTC days, both ends inclusive as the
 * operator typed them: `to` is midnight *after* the last day, because the
 * window is half-open and a range that ended at midnight on its own last day
 * would silently drop it. Two dates the wrong way round are swapped rather
 * than refused — it is obvious what was meant.
 */
export function resolveRange(choice: RangeChoice, now: number): ReportRange {
  const preset = presetById(choice.presetId);
  let from: number;
  let to: number;
  if (preset) {
    to = now;
    from = now - preset.days * DAY_MS;
  } else {
    const a = choice.fromDate ? startOfDayUtc(choice.fromDate) : null;
    const b = choice.toDate ? startOfDayUtc(choice.toDate) : null;
    if (a === null || b === null) {
      // An unreadable custom range is the default rather than an error: the
      // page still has to render something, and the default is the honest
      // thing to render.
      return resolveRange(DEFAULT_CHOICE, now);
    }
    from = Math.min(a, b);
    to = Math.max(a, b) + DAY_MS;
  }
  const clamped = to - from > MAX_WINDOW_DAYS * DAY_MS;
  const bucket = choice.bucket ?? preset?.bucket ?? bucketFor(to - from);
  return {
    from: Math.round(from),
    to: Math.round(to),
    bucket,
    presetId: preset ? preset.id : 'custom',
    bucketPinned: choice.bucket !== undefined,
    clamped,
  };
}

/**
 * A bucket that gives a custom span a readable number of columns: never more
 * than about a hundred, never fewer than about five.
 */
export function bucketFor(spanMs: number): Bucket {
  const days = spanMs / DAY_MS;
  if (days <= 2) return 'hour';
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

/**
 * A bucket's length, copied from `BUCKET_MS` in `packages/db/src/reports.ts`.
 * A month is thirty days there because a cohort period is computed in days
 * and divided; the same approximation has to be made here or the console
 * would draw a grid the server did not compute.
 */
export const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/**
 * How many periods of a cohort have actually happened by `to`.
 *
 * The retention grid is rectangular — the server pads every cohort's row to
 * the width of the widest — so a cohort formed yesterday carries zeros for
 * periods that have not occurred. Zero means "nobody came back", and a
 * period that has not happened yet means nothing at all; printing the first
 * where the second is true is the single most common way a cohort grid
 * lies. Cells past this count are drawn as empty.
 */
export function periodsElapsed(cohortAt: number, to: number, bucket: Bucket): number {
  return Math.max(1, Math.floor((to - cohortAt) / BUCKET_MS[bucket]) + 1);
}

// ── the URL ──────────────────────────────────────────────────────────────────

export function readChoice(params: URLSearchParams): RangeChoice {
  const presetId = params.get('range') ?? DEFAULT_CHOICE.presetId;
  const bucket = params.get('bucket');
  const choice: RangeChoice = {
    presetId: presetById(presetId)
      ? presetId
      : presetId === 'custom'
        ? 'custom'
        : DEFAULT_CHOICE.presetId,
  };
  const fromDate = params.get('from');
  const toDate = params.get('to');
  if (fromDate) choice.fromDate = fromDate;
  if (toDate) choice.toDate = toDate;
  if (bucket && (BUCKETS as readonly string[]).includes(bucket)) choice.bucket = bucket as Bucket;
  return choice;
}

/**
 * The choice written back, dropping everything that is already the default —
 * so the console's ordinary state is a clean URL and a shared link says only
 * what was actually chosen.
 */
export function writeChoice(params: URLSearchParams, choice: RangeChoice): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['range', 'from', 'to', 'bucket']) next.delete(key);
  if (choice.presetId !== DEFAULT_CHOICE.presetId) next.set('range', choice.presetId);
  if (choice.presetId === 'custom') {
    if (choice.fromDate) next.set('from', choice.fromDate);
    if (choice.toDate) next.set('to', choice.toDate);
  }
  if (choice.bucket) next.set('bucket', choice.bucket);
  return next;
}

/** The query string the endpoints take, in a stable order so it caches. */
export function rangeQuery(range: ReportRange): Record<string, string> {
  return { from: String(range.from), to: String(range.to), bucket: range.bucket };
}

/** "3 Mar 2026 – 2 Apr 2026", from the resolved window, for the page to say out loud. */
export function describeRange(range: ReportRange, label: (ms: number) => string): string {
  // `to` is exclusive, so the last day the window covers is the millisecond
  // before it. Printing `to` itself would claim a day that is not included.
  return `${label(range.from)} – ${label(range.to - 1)}`;
}
