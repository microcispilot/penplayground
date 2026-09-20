/**
 * How a number reads on the statistics pages.
 *
 * Every function here is pure and every one of them is deterministic — no
 * `toLocaleString` for anything a test asserts on, because ICU's grouping,
 * month names and currency placement move between Node builds and between
 * this machine and a reviewer's. The month names below are English and
 * written out for exactly that reason.
 *
 * Two rules the whole dashboard keeps:
 *
 *   · **Zero is a number, not a gap.** "$0.00" and "0" are printed; an
 *     em dash is reserved for *unknown*, which is a different fact from
 *     *none*. `session_stats.time_to_first_audio_ms` is null when no audio
 *     ever played; that is a dash. A window with no sessions in it costs
 *     zero dollars, and that is "$0.00".
 *   · **Money is never rounded to nothing.** A lesson can cost $0.0042.
 *     Printing that as "$0.00" would tell the owner their product is free.
 */

// ── money ────────────────────────────────────────────────────────────────────

/** Thousands separators without `toLocaleString`, so a test can assert on it. */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixed(value: number, places: number): string {
  const text = Math.abs(value).toFixed(places);
  const [whole = '0', fraction] = text.split('.');
  const body = fraction ? `${group(whole)}.${fraction}` : group(whole);
  return value < 0 ? `-${body}` : body;
}

/**
 * A dollar amount, at the precision the amount deserves. Anything at or above
 * a cent gets two places; below that the significant digits are kept, to four
 * places, because a per-session cost of a third of a cent is the interesting
 * case and "$0.00" is not an answer.
 */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '$0.00';
  // The sign goes outside the symbol: "-$3.50", never "$-3.50".
  const sign = value < 0 ? '-' : '';
  return `${sign}$${fixed(magnitude, magnitude < 0.005 ? 4 : 2)}`;
}

/** The same amount where space is short: $1.2k, $34.5k, $1.2M. */
export function usdCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude >= 1_000_000) return `${sign}$${fixed(magnitude / 1_000_000, 1)}M`;
  if (magnitude >= 10_000) return `${sign}$${fixed(magnitude / 1000, 1)}k`;
  return usd(value);
}

// ── counts ───────────────────────────────────────────────────────────────────

export function count(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return group(String(Math.round(value)));
}

/** 1,234 stays itself; 12,345 becomes 12.3k. Headline tiles only. */
export function countCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${fixed(value / 1_000_000, 1)}M`;
  if (magnitude >= 10_000) return `${fixed(value / 1000, 1)}k`;
  return count(value);
}

/**
 * A rate given as 0–1. Whole percents once it is worth one, one decimal
 * below that — a 0.4 % conversion is a real number and "0%" is not.
 */
export function percent(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const p = rate * 100;
  if (p !== 0 && Math.abs(p) < 1) return `${fixed(p, 1)}%`;
  return `${fixed(p, 0)}%`;
}

// ── time ─────────────────────────────────────────────────────────────────────

/**
 * A duration, at the granularity a reader can hold in their head: sub-second
 * in milliseconds, seconds to one decimal, then m/s, then h/m. Null is "—":
 * it means the thing never happened, which is not the same as zero.
 */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms === 0) return '0s';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 10_000) return `${fixed(ms / 1000, 1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (abs < 3_600_000) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (abs < 86_400_000 * 2) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type Bucket = 'hour' | 'day' | 'week' | 'month';

/**
 * A bucket's label. Buckets are UTC on the server (`bucketMs` in
 * `packages/db/src/reports.ts`), so they are read in UTC here — labelling a
 * UTC bucket in the reader's own zone puts the wrong date on it, and the one
 * report that *is* in local time says so on the page instead.
 */
export function bucketLabel(atMs: number, bucket: Bucket): string {
  const d = new Date(atMs);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()] ?? '';
  switch (bucket) {
    case 'hour':
      return `${day} ${month} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    case 'week':
      return `w/c ${day} ${month}`;
    case 'month':
      return `${month} ${d.getUTCFullYear()}`;
    default:
      return `${day} ${month}`;
  }
}

/** A calendar day, UTC, for a range summary: "3 Mar 2026". */
export function dayLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/**
 * A moment, in the reader's own zone, for a row about one thing that
 * happened. Deliberately local: "when did this session run" is a question
 * about the operator's day. Paired with an ISO string for the `<time>`.
 */
export function moment(atMs: number): { text: string; iso: string } {
  if (!Number.isFinite(atMs) || atMs <= 0) return { text: '—', iso: new Date(0).toISOString() };
  const d = new Date(atMs);
  const text = `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
  return { text, iso: d.toISOString() };
}

export const dayOfWeekLabel = (index: number): string => DAYS[index] ?? '';

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// ── the product's own words ──────────────────────────────────────────────────

/**
 * `session_stats.leave_reason`, in the owner's language rather than the
 * derivation's. The order of the table in `docs/STATISTICS.md` is the order
 * these are decided in; the words here say what happened, never how bad it is.
 */
const LEAVE_REASONS: Record<string, string> = {
  completed: 'Reached the recap',
  // Not "stopped part-way through": the learner did not stop, we did.
  interrupted: 'Interrupted by a deploy',
  length_ceiling: 'Hit the plan’s length limit',
  never_started: 'No audio ever played',
  left_during_ad: 'Left during an ad',
  left_after_error: 'Left just after an error',
  left_mid_segment: 'Stopped part-way through',
  idle_timeout: 'Room closed while empty',
  unknown: 'Not determined',
};

export function leaveReasonLabel(reason: string): string {
  return LEAVE_REASONS[reason] ?? titleCase(reason);
}

/** Whether a leave reason is one the product would rather not see. */
export function leaveReasonIsGood(reason: string): boolean {
  return reason === 'completed';
}

/** `StageName` (packages/contracts/src/telemetry.ts), said in plain words. */
const STAGES: Record<string, string> = {
  intake: 'Intake',
  resolve: 'Registry lookup',
  context: 'Onten query',
  prepare: 'Gathering sources',
  llm: 'Model call',
  intent: 'Intent',
  image: 'Picture',
  tts: 'Speech out',
  stt: 'Speech in',
  board: 'Board',
  turn: 'Turn',
  ad: 'Ad',
  join: 'Join',
  leave: 'Leave',
};

export function stageLabel(stage: string): string {
  return STAGES[stage] ?? titleCase(stage);
}

/** Cost components, as `/cost` names them. */
export const COST_COMPONENTS = [
  { key: 'llmUsd', label: 'Model' },
  { key: 'ttsUsd', label: 'Speech out' },
  { key: 'imageUsd', label: 'Pictures' },
  { key: 'sttUsd', label: 'Speech in' },
  { key: 'intentUsd', label: 'Intent' },
  { key: 'searchUsd', label: 'Sources' },
] as const;

/** `session_reuse_links.kind`, said the way the owner talks about them. */
const REUSE_KINDS: Record<string, string> = {
  pack: 'Knowledge pack',
  lesson: 'Lesson text',
  card: 'Session card',
  picture: 'Session picture',
  voice: 'Spoken audio',
};

export function reuseKindLabel(kind: string): string {
  return REUSE_KINDS[kind] ?? titleCase(kind);
}

const PLANS: Record<string, string> = {
  free: 'Free',
  standard: 'Personal',
  professional: 'Professional',
};

export function planLabel(plan: string, interval?: string | null): string {
  const base = PLANS[plan] ?? titleCase(plan);
  if (plan === 'free' || !interval) return base;
  return `${base}, ${interval === 'year' ? 'yearly' : 'monthly'}`;
}

/**
 * A country code as a name. `Intl.DisplayNames` is in every browser this
 * console runs in and in Node 22; a code it does not know is printed as
 * itself rather than as "unknown", because the code is still the truth.
 */
let regionNames: Intl.DisplayNames | null | undefined;
export function countryLabel(code: string | null): string {
  if (!code) return 'Not known';
  if (regionNames === undefined) {
    try {
      // `fallback: 'code'` so a code ICU does not know prints as itself
      // rather than as the words "Unknown Region", which reads like a place.
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The route patterns a visit beacon reports, as screen names. */
export function screenLabel(screen: string): string {
  if (screen === '' || screen === '/') return 'Home';
  return screen;
}

export function referrerLabel(host: string | null, campaign: string | null): string {
  if (campaign) return host ? `${host} · ${campaign}` : campaign;
  return host ?? 'Typed or bookmarked';
}

export function deviceLabel(device: string): string {
  return titleCase(device);
}

/** `geo_source`, as the sentence a reader needs rather than as a code. */
export const GEO_SOURCES: Record<string, string> = {
  edge: 'From the edge',
  timezone: 'From the browser’s timezone',
  none: 'Nothing was available',
};

export function geoSourceLabel(source: string): string {
  return GEO_SOURCES[source] ?? titleCase(source);
}

function titleCase(raw: string): string {
  if (raw.length === 0) return '';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

/** A session id, shortened for a table cell but never invented. */
export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}
