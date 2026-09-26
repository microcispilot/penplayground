import { PostHog } from 'posthog-node';
import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Product analytics (PostHog). Content-free by design: topics, transcripts
 * and spoken text never leave the server; only codes, counts and timings do.
 * Disabled until POSTHOG_PROJECT_TOKEN is set.
 */
export class Analytics {
  private readonly client: PostHog | null;
  /**
   * Participants who turned analytics off (Privacy choices). Kept in memory and
   * refreshed from the participant row on every authenticated request, so the
   * choice is honoured on the server too — turning it off in the browser and
   * still being counted here would make the switch a lie.
   */
  private readonly optedOut = new Set<string>();

  /** Which deployment sent the event (ADR-0059): one PostHog project, filtered by this. */
  private readonly environment: string;

  constructor(cfg: Config) {
    this.environment = cfg.PEN_ENVIRONMENT;
    this.client = cfg.POSTHOG_PROJECT_TOKEN
      ? new PostHog(cfg.POSTHOG_PROJECT_TOKEN, {
          host: cfg.POSTHOG_HOST,
          flushAt: 20,
          flushInterval: 10_000,
        })
      : null;
    if (!this.client) logger.info('analytics disabled: set POSTHOG_PROJECT_TOKEN');
  }

  /** Remember a participant's analytics choice (from their row). */
  setOptOut(participantId: string, optedOut: boolean): void {
    if (optedOut) this.optedOut.add(participantId);
    else this.optedOut.delete(participantId);
  }

  optedOutOf(participantId: string): boolean {
    return this.optedOut.has(participantId);
  }

  capture(
    distinctId: string,
    event: string,
    properties: Record<string, string | number | boolean | null> = {},
  ): void {
    if (this.optedOut.has(distinctId)) return;
    this.client?.capture({
      distinctId,
      event,
      properties: { ...properties, app: 'pen-academy-api', environment: this.environment },
    });
  }

  /** Push what is queued now (session end): the summary should be queryable within seconds. */
  async flush(): Promise<void> {
    await this.client?.flush();
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}
