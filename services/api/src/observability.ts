import type { RoomObserver } from '@pen/session-engine';
import * as Sentry from '@sentry/node';
import type { Config } from './config.js';
import { logger } from './logger.js';

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
          if (/text|question|transcript|say/i.test(k)) delete event.extra[k];
      return event;
    },
  });
  return true;
}

/** Structured events to logs; failures to logs + Sentry with content-free context. */
export const observer: RoomObserver = {
  event(name, data) {
    logger.info({ evt: name, ...data });
  },
  error(area, error, data) {
    logger.error({
      area,
      err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      ...data,
    });
    Sentry.withScope((scope) => {
      scope.setTag('area', area);
      if (data)
        for (const [k, v] of Object.entries(data))
          if (typeof v === 'number' || typeof v === 'boolean') scope.setExtra(k, v);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  },
};
