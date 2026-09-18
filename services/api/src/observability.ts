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
    else if (typeof v === 'string' && v.length <= 32 && /^[\w.:-]+$/.test(v)) safe[k] = v;
  Sentry.addBreadcrumb({ category: name, level: 'info', data: safe });
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
