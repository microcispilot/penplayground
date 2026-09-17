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

  constructor(cfg: Config) {
    this.client = cfg.POSTHOG_PROJECT_TOKEN
      ? new PostHog(cfg.POSTHOG_PROJECT_TOKEN, {
          host: cfg.POSTHOG_HOST,
          flushAt: 20,
          flushInterval: 10_000,
        })
      : null;
    if (!this.client) logger.info('analytics disabled: set POSTHOG_PROJECT_TOKEN');
  }

  capture(
    distinctId: string,
    event: string,
    properties: Record<string, string | number | boolean | null> = {},
  ): void {
    this.client?.capture({
      distinctId,
      event,
      properties: { ...properties, app: 'pen-academy-api' },
    });
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}
