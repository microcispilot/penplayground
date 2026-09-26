import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPrivacyChoice,
  distinctIdFromToken,
  initAnalytics,
  installMonitor,
  reportClientError,
  resetAnalyticsForTests,
  setAnalyticsContext,
  setAnalyticsPerson,
  track,
  trackAction,
} from '../src/lib/analytics.js';
import type { Platform } from '../src/platform/types.js';
import { testPlatform } from './harness.js';

/**
 * Privacy choices against a lazily-loaded SDK (ADR-0011 + ADR-0018).
 *
 * posthog-js is fetched after the app has booted rather than inside the entry
 * bundle, which opens a window the eager version never had: a few hundred
 * milliseconds in which "turn analytics off" has nothing to turn off yet. The
 * promise of "off means off" has to hold inside that window too — nothing may
 * be initialised, and nothing queued while the import was in flight may be
 * replayed into it afterwards.
 */

const posthog = {
  inits: [] as string[],
  initOptions: [] as Array<Record<string, unknown>>,
  registered: [] as unknown[],
  captured: [] as string[],
  capturedWith: [] as Array<{ event: string; props: Record<string, unknown> }>,
  optedIn: 0,
  optedOut: 0,
  resets: 0,
  init(token: string, options: Record<string, unknown> = {}) {
    posthog.inits.push(token);
    posthog.initOptions.push(options);
  },
  register(props: unknown) {
    posthog.registered.push(props);
  },
  capture(event: string, props: Record<string, unknown> = {}) {
    posthog.captured.push(event);
    posthog.capturedWith.push({ event, props });
  },
  identify() {},
  opt_in_capturing() {
    posthog.optedIn += 1;
  },
  opt_out_capturing() {
    posthog.optedOut += 1;
  },
  reset() {
    posthog.resets += 1;
  },
};

vi.mock('posthog-js', () => ({ default: posthog }));

/** A platform that would really start analytics, unlike the default fake. */
function withAnalytics(): Platform {
  return { ...testPlatform(), analytics: { token: 'phc_test', host: 'https://posthog.test' } };
}

/** Let the dynamic `import()` resolve and its `.then` run (a module load is not a microtask). */
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('privacy choices and the lazily-loaded SDK', () => {
  beforeEach(() => {
    resetAnalyticsForTests();
    posthog.inits = [];
    posthog.registered = [];
    posthog.captured = [];
    posthog.capturedWith = [];
    posthog.optedIn = 0;
    posthog.optedOut = 0;
    posthog.resets = 0;
  });

  it('starts cookieless when the learner has not opted out', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    await settle();
    expect(posthog.inits).toEqual(['phc_test']);
    // `environment` rides on every event (ADR-0059); the test platform names none, so development.
    expect(posthog.registered).toEqual([
      { app: 'pen-academy-web', platform: 'web', environment: 'development' },
    ]);
  });

  it('never fetches or starts the SDK for a learner who has opted out', async () => {
    initAnalytics(withAnalytics(), { analytics: false });
    await settle();
    track('anything');
    await settle();
    expect(posthog.inits).toEqual([]);
    expect(posthog.captured).toEqual([]);
  });

  it('makes no network call at all when the choice changes while the SDK is still loading', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    // Queued against a client that does not exist yet — the ordinary case for
    // anything that happens in the first moments of a page.
    track('page_view');
    // The learner opens Privacy choices and turns it off before the import lands.
    applyPrivacyChoice({ analytics: false });
    await settle();
    expect(posthog.inits, 'the SDK must never be initialised after a "no"').toEqual([]);
    expect(posthog.captured, 'and nothing queued may be replayed into it').toEqual([]);
  });

  it('stops capture and forgets the identity when the SDK is already running', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    await settle();
    applyPrivacyChoice({ analytics: false });
    expect(posthog.optedOut).toBe(1);
    expect(posthog.resets).toBe(1);
    applyPrivacyChoice({ analytics: true });
    expect(posthog.optedIn).toBe(1);
  });

  it('is a no-op, not a crash, when the host configures no analytics at all', async () => {
    initAnalytics(testPlatform(), { analytics: true });
    await settle();
    expect(posthog.inits).toEqual([]);
    expect(() => applyPrivacyChoice({ analytics: false })).not.toThrow();
  });
});

/**
 * Every decision a visitor makes outside a room (ADR-0038) reaches PostHog
 * as its own event, carrying the screen and whether the person is signed in
 * — and reaches nothing else, because there is no ledger for a visit.
 */
describe('actions outside a room', () => {
  beforeEach(() => {
    resetAnalyticsForTests();
    posthog.inits = [];
    posthog.initOptions = [];
    posthog.registered = [];
    posthog.captured = [];
    posthog.capturedWith = [];
  });

  it('sends an action with the screen it happened on, marked as an action', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    await settle();
    setAnalyticsContext({ screen: 'home' });
    trackAction('start_clicked', { source: 'box', withExpert: false });
    expect(posthog.capturedWith).toEqual([
      {
        event: 'start_clicked',
        props: { source: 'box', withExpert: false, screen: 'home', kind: 'action' },
      },
    ]);
  });

  it('registers who the visitor is, so every later event says anonymous and plan', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    // Before the SDK lands: the answer must survive the queue.
    setAnalyticsPerson({ anonymous: true, plan: 'free' });
    await settle();
    // Both registrations carry the base too: `reset()` (sign-out, delete,
    // analytics off) clears every registered property, and this is what
    // puts `app` and `platform` back on every later event.
    expect(posthog.registered).toEqual([
      {
        app: 'pen-academy-web',
        platform: 'web',
        environment: 'development',
        anonymous: true,
        plan: 'free',
      },
      {
        app: 'pen-academy-web',
        platform: 'web',
        environment: 'development',
        anonymous: true,
        plan: 'free',
      },
    ]);
  });

  it('queues an action made before the SDK loads and replays it once', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    trackAction('upgrade_clicked', { source: 'home_limit' });
    await settle();
    expect(posthog.captured).toEqual(['upgrade_clicked']);
  });

  it('sends nothing for a visitor who has analytics off', async () => {
    initAnalytics(withAnalytics(), { analytics: false });
    await settle();
    trackAction('sign_in_opened');
    await settle();
    expect(posthog.captured).toEqual([]);
  });
});

/**
 * The monitor is installed before any effect runs, so the first render's
 * crash — the one the error boundary catches before `initAnalytics` has had
 * its turn — is captured rather than lost.
 */
describe('the monitor is there before analytics is', () => {
  beforeEach(() => resetAnalyticsForTests());

  it('captures an error through a monitor installed synchronously', () => {
    const seen: string[] = [];
    const platform: Platform = {
      ...testPlatform(),
      monitor: {
        setTag: () => undefined,
        breadcrumb: () => undefined,
        captureError: (code) => {
          seen.push(code);
          return 'evt_1';
        },
      },
    };
    installMonitor(platform);
    expect(reportClientError('PEN_APP_RENDER', new Error('boom'))).toBe('evt_1');
    expect(seen).toEqual(['PEN_APP_RENDER']);
  });

  it('returns null, never throws, with no monitor at all', () => {
    installMonitor(testPlatform());
    expect(reportClientError('PEN_APP_RENDER', new Error('boom'))).toBeNull();
  });
});

/**
 * Who the SDK starts as. The bearer already names the participant, so the
 * SDK is bootstrapped with that id and never mints a stranger to merge.
 */
describe('starting as the person the bearer names', () => {
  beforeEach(() => {
    resetAnalyticsForTests();
    posthog.inits = [];
    posthog.initOptions = [];
  });

  // base64url by hand: the app decodes with `atob`, and the test runs in the
  // same browser-shaped environment, so no Node buffer here.
  const jwt = (claims: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

  it('reads the participant id out of a bearer, and nothing out of anything else', () => {
    expect(distinctIdFromToken(jwt({ sub: 'p_abc123', plan: 'free' }))).toBe('p_abc123');
    expect(distinctIdFromToken(null)).toBeNull();
    expect(distinctIdFromToken('not-a-jwt')).toBeNull();
    expect(distinctIdFromToken(jwt({ plan: 'free' }))).toBeNull();
    expect(distinctIdFromToken('h.%%%.sig')).toBeNull();
  });

  it('bootstraps the SDK with the stored bearer’s participant id', async () => {
    const platform = withAnalytics();
    platform.storage.set('pen.token', jwt({ sub: 'p_returning' }));
    initAnalytics(platform, { analytics: true });
    await settle();
    expect(posthog.initOptions[0]?.bootstrap).toEqual({
      distinctID: 'p_returning',
      isIdentifiedID: true,
    });
  });

  it('starts without a bootstrap on a first visit, and only once per page', async () => {
    const platform = withAnalytics();
    initAnalytics(platform, { analytics: true });
    initAnalytics(platform, { analytics: true });
    await settle();
    expect(posthog.inits).toEqual(['phc_test']);
    expect(posthog.initOptions[0]?.bootstrap).toBeUndefined();
  });
});
