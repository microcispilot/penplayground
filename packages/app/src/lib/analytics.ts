import type { InteractionName, InteractionProps } from '@pen/contracts';
import posthog from 'posthog-js';
import type { Monitor, Platform } from '../platform/types.js';

/**
 * Client analytics (ADR-0011). Page views and typed interaction events; no
 * autocapture, no session recording, no PII, no content: every event carries
 * codes, counts and timings only, plus the session context (which session,
 * host or guest, which screen, which phase). Inside a room the same event is
 * also sent to the API as a `report`, so the session's ledger has it.
 */
export interface AnalyticsContext {
  sessionId: string | null;
  role: 'host' | 'guest' | null;
  screen: string;
  phase: string | null;
}

const context: AnalyticsContext = { sessionId: null, role: null, screen: '', phase: null };
let reporter: ((event: InteractionName, props: InteractionProps) => void) | null = null;
let monitor: Monitor | null = null;
/** When the learner clicked Start on Home (ms epoch); the room measures time-to-first-audio from it. */
let startClickedAt: number | null = null;

export function initAnalytics(platform: Platform): void {
  monitor = platform.monitor ?? null;
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

/** Sign-out: the next participant must not inherit this person's PostHog identity. */
export function resetAnalytics(): void {
  if (posthog.__loaded) posthog.reset();
}

/** The room (or a screen) tells analytics where the learner is; Sentry gets the same as tags. */
export function setAnalyticsContext(patch: Partial<AnalyticsContext>): void {
  Object.assign(context, patch);
  if (patch.sessionId !== undefined) monitor?.setTag('sessionId', patch.sessionId);
  if (patch.role !== undefined) monitor?.setTag('role', patch.role);
  if (patch.screen !== undefined) monitor?.setTag('screen', patch.screen);
}

export function getAnalyticsContext(): Readonly<AnalyticsContext> {
  return context;
}

/** RoomSession installs the socket reporter while connected; null outside a room. */
export function setRoomReporter(
  fn: ((event: InteractionName, props: InteractionProps) => void) | null,
): void {
  reporter = fn;
}

/** The learner clicked Start: remembered so the room can measure click → first audible audio. */
export function markStartClicked(): void {
  startClickedAt = Date.now();
}

/** Consumes the Start click (once) when it is recent enough to belong to this room visit. */
export function takeStartClickedAt(maxAgeMs = 90_000): number | null {
  const at = startClickedAt;
  startClickedAt = null;
  return at !== null && Date.now() - at <= maxAgeMs ? at : null;
}

/**
 * One typed interaction: to PostHog with the session context, to the room's
 * ledger via `report` when in a room, and as a Sentry breadcrumb so an error
 * report shows what the learner did before it.
 */
export function trackInteraction(event: InteractionName, props: InteractionProps = {}): void {
  const enriched: Record<string, string | number | boolean> = { ...props, screen: context.screen };
  if (context.sessionId) enriched.sessionId = context.sessionId;
  if (context.role) enriched.role = context.role;
  if (context.phase) enriched.phase = context.phase;
  track(event, enriched);
  reporter?.(event, props);
  monitor?.breadcrumb(event, props);
}

/** A client-side failure: captured (content-free) and, in a room, written to the ledger with its Sentry ref. */
export function reportClientError(code: string, error: unknown, stage?: string): string | null {
  const ref = monitor?.captureError(code, error, { ...context, stage: stage ?? null }) ?? null;
  trackInteraction('error_shown', ref ? { code, ref } : { code });
  return ref;
}

/** Tests: reset module state. */
export function resetAnalyticsForTests(): void {
  Object.assign(context, { sessionId: null, role: null, screen: '', phase: null });
  reporter = null;
  monitor = null;
  startClickedAt = null;
}
