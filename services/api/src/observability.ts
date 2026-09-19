import type { RoomObserver } from '@pen/session-engine';
import * as Sentry from '@sentry/node';
import type { Config } from './config.js';
import { logger } from './logger.js';

let sentryEnabled = false;

/** Tags every event carries; per-session tags are added by `scopedObserver`. */
const TAG_KEYS = new Set([
  'sessionId',
  'expertId',
  'plan',
  'stage',
  'provider',
  'provider.llm',
  'provider.tts',
  'provider.stt',
  'code',
]);

/** Structured events that become Sentry breadcrumbs (phase transitions, decisions). */
const BREADCRUMB_EVENTS = new Set([
  'room.phase',
  'room.mode',
  'room.resolve',
  'room.intent',
  'room.intent_unsure',
  'room.turn',
  'room.ended',
  'room.language',
  'stt.session_open',
  'export.start',
  'export.done',
]);

export function initSentry(cfg: Config): boolean {
  if (!cfg.SENTRY_DSN) return false;
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.SENTRY_ENVIRONMENT,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      // Never ship transcripts, questions or spoken text: only codes, areas and numbers.
      if (event.extra)
        for (const k of Object.keys(event.extra))
          if (/text|question|transcript|say|topic|title/i.test(k)) delete event.extra[k];
      if (event.breadcrumbs)
        for (const b of event.breadcrumbs)
          if (b.data)
            for (const k of Object.keys(b.data))
              if (/text|question|transcript|say|topic|title/i.test(k)) delete b.data[k];
      return event;
    },
  });
  Sentry.setTags({
    'provider.llm': cfg.PEN_LLM_PROVIDER,
    'provider.tts': cfg.PEN_TTS_PROVIDER,
    'provider.stt': cfg.PEN_STT_PROVIDER,
  });
  sentryEnabled = true;
  return true;
}

/** For tests: pretend Sentry is (not) configured. */
export function setSentryEnabledForTests(enabled: boolean): void {
  sentryEnabled = enabled;
}

/**
 * Capture to Sentry with content-free context: known keys become tags
 * (filterable), numbers and booleans become extras, everything else is
 * dropped. Returns the event id so the ledger can point at the issue.
 */
export function captureError(
  area: string,
  error: unknown,
  data: Record<string, unknown> = {},
): string | null {
  logger.error({
    area,
    err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    ...data,
  });
  if (!sentryEnabled) return null;
  let id: string | null = null;
  Sentry.withScope((scope) => {
    scope.setTag('area', area);
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      if (TAG_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number'))
        scope.setTag(k, String(v).slice(0, 200));
      else if (typeof v === 'number' || typeof v === 'boolean') scope.setExtra(k, v);
    }
    id = Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
  return id;
}

/**
 * A condition worth a human's attention that is not a failure — the day's
 * spend crossing its warning line, say. Same content-free rule as
 * `captureError`: codes, numbers and booleans only.
 */
export function captureWarning(
  area: string,
  message: string,
  data: Record<string, unknown> = {},
): string | null {
  logger.warn({ area, msg: message, ...data });
  if (!sentryEnabled) return null;
  let id: string | null = null;
  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setTag('area', area);
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      if (TAG_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number'))
        scope.setTag(k, String(v).slice(0, 200));
      else if (typeof v === 'number' || typeof v === 'boolean') scope.setExtra(k, v);
    }
    id = Sentry.captureMessage(message, 'warning');
  });
  return id;
}

function breadcrumb(name: string, data: Record<string, unknown>): void {
  if (!sentryEnabled || !BREADCRUMB_EVENTS.has(name)) return;
  const safe: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data))
    if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (typeof v === 'string' && TAG_KEYS.has(k)) safe[k] = v;
    // No spaces, no punctuation that makes a sentence, and short: a code or an
    // identifier, never free text. `/` is in the set because provider model ids
    // are written that way (`typesafe/jev-1.13`), and `room.intent`'s `via` is
    // the field that says which classifier decided.
    else if (typeof v === 'string' && v.length <= 32 && /^[\w./:-]+$/.test(v)) safe[k] = v;
  Sentry.addBreadcrumb({ category: name, level: 'info', data: safe });
}

/**
 * Sentry Cron heartbeat: every `intervalMinutes` the API runs its own
 * readiness probe and checks in (`ok` / `error`) against the monitor named by
 * `SENTRY_CRON_MONITOR_SLUG`. Two failures are therefore visible without
 * anyone watching: a *missed* check-in (the process is dead, wedged, or the
 * host is gone) and an *error* check-in (the process runs but cannot serve —
 * database down, disk full, keys missing).
 *
 * The monitor's schedule is upserted with each check-in, so the alert exists
 * even on a fresh Sentry project and never drifts from this code: interval
 * `intervalMinutes`, the same again as margin, `failureIssueThreshold: 1`.
 * A dead API is therefore an issue within two intervals (10 minutes at the
 * default), which is the number docs/RUNBOOK.md promises.
 *
 * Returns a stop function; the caller owns the lifetime. Without a DSN or a
 * slug it does nothing and says so, so the same code runs in development.
 */
export function startCronHeartbeat(
  cfg: Config,
  probe: () => Promise<boolean>,
  opts: { now?: () => number; setInterval?: typeof setInterval } = {},
): (() => void) | null {
  const slug = cfg.SENTRY_CRON_MONITOR_SLUG;
  if (!slug) return null;
  if (!sentryEnabled) {
    logger.warn({ slug }, 'SENTRY_CRON_MONITOR_SLUG is set but Sentry is not: no heartbeat');
    return null;
  }
  const minutes = cfg.SENTRY_CRON_INTERVAL_MINUTES;
  const now = opts.now ?? (() => Date.now());
  const monitorConfig = {
    schedule: { type: 'interval', value: minutes, unit: 'minute' },
    // Missed by more than one interval → issue; one good check-in closes it.
    checkinMargin: minutes,
    maxRuntime: Math.max(1, Math.ceil(minutes / 2)),
    timezone: 'Etc/UTC',
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  } as const;

  const beat = async (): Promise<void> => {
    const startedAt = now();
    let ok = false;
    try {
      ok = await probe();
    } catch (error) {
      captureError('heartbeat.probe', error);
      ok = false;
    }
    const duration = Math.max(0, (now() - startedAt) / 1000);
    try {
      Sentry.captureCheckIn(
        { monitorSlug: slug, status: ok ? 'ok' : 'error', duration },
        monitorConfig,
      );
      logger.debug({ evt: 'heartbeat', slug, ok, duration });
    } catch (error) {
      // Never let telemetry take the process down: the lesson matters more.
      captureError('heartbeat.checkin', error, { slug });
    }
  };

  void beat();
  const schedule = opts.setInterval ?? setInterval;
  const timer = schedule(() => void beat(), minutes * 60_000);
  timer.unref?.();
  logger.info({ slug, minutes, environment: cfg.SENTRY_ENVIRONMENT }, 'sentry cron heartbeat on');
  return () => clearInterval(timer);
}

/** Structured events to logs (+ breadcrumbs); failures to logs + Sentry with content-free context. */
export const observer: RoomObserver = {
  event(name, data) {
    logger.info({ evt: name, ...data });
    breadcrumb(name, data);
  },
  error(area, error, data) {
    return captureError(area, error, data);
  },
};

/**
 * The observer a room gets: every event and error carries the session's
 * identity as Sentry tags (`sessionId`, `expertId`, `plan`), so an issue can
 * be traced back to its ledger and its Insights tab.
 */
export function scopedObserver(tags: {
  sessionId: string;
  expertId: string;
  plan: string;
}): RoomObserver {
  return {
    event: (name, data) => observer.event(name, { ...tags, ...data }),
    error: (area, error, data) => observer.error(area, error, { ...tags, ...data }),
  };
}
