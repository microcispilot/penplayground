import type { VisitBeacon } from '@pen/contracts';
import type { VisitBeaconWrite } from '@pen/db';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IDENTIFIER_SWEEP_MS,
  type VisitContext,
  VisitIngest,
  type VisitIngestDeps,
} from '../src/stats/visits.js';

/**
 * The retention promise, at the seam that makes it (ADR-0028).
 *
 * `stats-reports.test.ts` proves the clearing against a real Postgres. What
 * is proved here is the part a database cannot show: that the ingest decides
 * *whether* to write an identifier at all, and that the thing which forgets
 * them runs on its own clock from the sweeper that already exists — including
 * on a deployment where collection is switched off, because turning
 * collection off must not also turn off the forgetting.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 2, 1, 12, 0, 0);

const beacon = (patch: Partial<VisitBeacon> = {}): VisitBeacon =>
  ({
    visitId: 'v_retention_01',
    timezone: 'Europe/Berlin',
    language: 'de-DE',
    activeMs: 9_000,
    screens: [{ screen: 'home', views: 1, activeMs: 9_000 }],
    actions: {},
    final: false,
    ...patch,
  }) as VisitBeacon;

const context = (patch: Partial<VisitContext> = {}): VisitContext => ({
  participantId: null,
  signedIn: false,
  plan: 'free',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36',
  ipAddress: '203.0.113.7',
  header: () => undefined,
  now: NOW,
  ...patch,
});

interface Harness {
  ingest: VisitIngest;
  writes: VisitBeaconWrite[];
  /** Every cutoff the retention pass asked for, in order. */
  cutoffs: number[];
  closed: number[];
}

function harness(overrides: Partial<VisitIngestDeps> = {}): Harness {
  const writes: VisitBeaconWrite[] = [];
  const cutoffs: number[] = [];
  const closed: number[] = [];
  const ingest = new VisitIngest({
    stats: {
      applyVisitBeacon: async (w) => {
        writes.push(w);
        return w.id;
      },
      closeStaleVisits: async (now) => {
        closed.push(now);
        return 0;
      },
      recordEngagement: async () => undefined,
      clearVisitIdentifiers: async (olderThan) => {
        cutoffs.push(olderThan);
        return 0;
      },
    },
    optedOut: () => false,
    trustGeoHeaders: false,
    enabled: true,
    identifierRetentionMs: 30 * DAY,
    onError: (area, error) => {
      throw new Error(`unexpected ${area}: ${String(error)}`);
    },
    ...overrides,
  });
  return { ingest, writes, cutoffs, closed };
}

describe('what a visit records about the request', () => {
  it('writes the address and the raw string beside the parsed columns', async () => {
    const h = harness();
    expect(await h.ingest.record(beacon(), context())).toBe(true);
    expect(h.writes[0]).toMatchObject({
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36',
      deviceType: 'desktop',
      browser: 'Chrome',
      browserMajor: 140,
    });
  });

  it('writes neither when the retention period is zero', async () => {
    const h = harness({ identifierRetentionMs: 0 });
    await h.ingest.record(beacon(), context());
    expect(h.writes[0]).toMatchObject({ ipAddress: null, userAgent: null });
    // And everything a report groups by is still there.
    expect(h.writes[0]).toMatchObject({ deviceType: 'desktop', country: 'DE' });
  });

  it('stores nothing at all for a participant who has analytics off', async () => {
    const h = harness({ optedOut: () => true });
    expect(await h.ingest.record(beacon(), context({ participantId: 'p_quiet_0000001' }))).toBe(
      false,
    );
    expect(h.writes).toEqual([]);
  });

  it('bounds the raw string and strips what a forged one could hide in it', async () => {
    const h = harness();
    await h.ingest.record(
      beacon(),
      context({ userAgent: `Evil/1.0\n\rX-Injected: yes ${'x'.repeat(1_000)}` }),
    );
    const stored = h.writes[0]?.userAgent ?? '';
    expect(stored.length).toBe(400);
    expect(stored).not.toMatch(/[\n\r]/);
    expect(stored.startsWith('Evil/1.0')).toBe(true);
  });

  it('takes the language from Accept-Language only when the page sent none', async () => {
    const h = harness();
    const headers = (value: string) => (name: string) =>
      name.toLowerCase() === 'accept-language' ? value : undefined;
    await h.ingest.record(
      beacon({ visitId: 'v_lang_0000001', language: null }),
      context({ header: headers('fr-CA,fr;q=0.9,en;q=0.8') }),
    );
    expect(h.writes[0]?.language).toBe('fr-CA');
    await h.ingest.record(
      beacon({ visitId: 'v_lang_0000002', language: 'de-DE' }),
      context({ header: headers('fr-CA,fr;q=0.9') }),
    );
    expect(h.writes[1]?.language).toBe('de-DE');
    // A wildcard is not a language.
    await h.ingest.record(
      beacon({ visitId: 'v_lang_0000003', language: null }),
      context({ header: headers('*') }),
    );
    expect(h.writes[2]?.language).toBeNull();
  });

  it('keeps the window measurements the browser volunteers, and refuses nonsense', async () => {
    const h = harness();
    await h.ingest.record(
      beacon({
        screenWidth: 390,
        screenHeight: 844,
        viewportWidth: 390,
        viewportHeight: 664,
        devicePixelRatio: 2.625,
      }),
      context(),
    );
    expect(h.writes[0]).toMatchObject({
      screenWidth: 390,
      screenHeight: 844,
      viewportWidth: 390,
      viewportHeight: 664,
      devicePixelRatio: 2.63,
    });
    const nonsense = harness();
    await nonsense.ingest.record(beacon({ devicePixelRatio: null }), context());
    expect(nonsense.writes[0]).toMatchObject({
      screenWidth: null,
      viewportHeight: null,
      devicePixelRatio: null,
    });
  });
});

describe('the sweep that forgets them', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('runs the retention pass on the first sweep and then hourly, not every minute', async () => {
    await h.ingest.sweep(NOW);
    expect(h.cutoffs).toEqual([NOW - 30 * DAY]);
    // The next fifty-nine minutes of one-minute sweeps close visits and do
    // not re-ask: a period measured in days does not need checking sixty
    // times an hour.
    for (let minute = 1; minute < 60; minute += 1) await h.ingest.sweep(NOW + minute * 60_000);
    expect(h.cutoffs).toHaveLength(1);
    expect(h.closed).toHaveLength(60);

    await h.ingest.sweep(NOW + IDENTIFIER_SWEEP_MS);
    expect(h.cutoffs).toEqual([NOW - 30 * DAY, NOW + IDENTIFIER_SWEEP_MS - 30 * DAY]);
  });

  it('forgets even where collection is switched off', async () => {
    const off = harness({ enabled: false });
    await off.ingest.sweep(NOW);
    expect(off.cutoffs).toEqual([NOW - 30 * DAY]);
    // Nothing is being counted, so nothing is being closed.
    expect(off.closed).toEqual([]);
  });

  it('clears everything already stored when the period is zero', async () => {
    const none = harness({ identifierRetentionMs: 0 });
    await none.ingest.sweep(NOW);
    expect(none.cutoffs).toEqual([NOW]);
  });

  it('a failed retention pass is reported and never thrown at the sweeper', async () => {
    const seen: string[] = [];
    const broken = new VisitIngest({
      stats: {
        applyVisitBeacon: async (w) => w.id,
        closeStaleVisits: async () => 0,
        recordEngagement: async () => undefined,
        clearVisitIdentifiers: async () => {
          throw new Error('database is away');
        },
      },
      optedOut: () => false,
      trustGeoHeaders: false,
      enabled: true,
      identifierRetentionMs: 30 * DAY,
      onError: (area) => seen.push(area),
    });
    await expect(broken.sweep(NOW)).resolves.toBe(0);
    expect(seen).toEqual(['stats.visit_retention']);
  });
});
