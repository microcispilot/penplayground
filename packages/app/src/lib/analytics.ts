import posthog from 'posthog-js';
import type { Platform } from '../platform/types.js';

/** Page views and a few product events; no autocapture, no session recording, no PII. */
export function initAnalytics(platform: Platform): void {
  if (!platform.analytics) return;
  posthog.init(platform.analytics.token, {
    api_host: platform.analytics.host,
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
    persistence: 'localStorage',
    person_profiles: 'identified_only',
  });
  posthog.register({ app: `pen-academy-${platform.name}` });
}

export function track(
  event: string,
  properties: Record<string, string | number | boolean> = {},
): void {
  if (posthog.__loaded) posthog.capture(event, properties);
}

export function identify(id: string): void {
  if (posthog.__loaded) posthog.identify(id);
}
