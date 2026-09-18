import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPrivacyChoice,
  initAnalytics,
  resetAnalyticsForTests,
  track,
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
  registered: [] as unknown[],
  captured: [] as string[],
  optedIn: 0,
  optedOut: 0,
  resets: 0,
  init(token: string) {
    posthog.inits.push(token);
  },
  register(props: unknown) {
    posthog.registered.push(props);
  },
  capture(event: string) {
    posthog.captured.push(event);
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
    posthog.optedIn = 0;
    posthog.optedOut = 0;
    posthog.resets = 0;
  });

  it('starts cookieless when the learner has not opted out', async () => {
    initAnalytics(withAnalytics(), { analytics: true });
    await settle();
    expect(posthog.inits).toEqual(['phc_test']);
    expect(posthog.registered).toEqual([{ app: 'pen-academy-web' }]);
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
