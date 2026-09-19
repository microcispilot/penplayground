import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Connection,
  connect,
  type DerivedSessionWrite,
  NO_VISIT_ACTIONS,
  StatsRepository,
  schema,
  type VisitBeaconWrite,
} from '../src/index.js';

/**
 * The writing half of the statistics, against a real Postgres. What is being
 * proved here is the two things that are easy to get wrong and impossible to
 * notice: that deriving a session twice leaves one set of rows, and that a
 * visit's engaged time accumulates without a single beacon being able to
 * inflate it.
 */

let conn: Connection;
let stats: StatsRepository;

beforeAll(async () => {
  conn = await connect('pglite://memory');
  stats = new StatsRepository(conn.db);
}, 120_000);

afterAll(async () => {
  await conn.close();
});

beforeEach(async () => {
  for (const table of [
    'session_reuse_links',
    'stats_work_origin',
    'session_stage_stats',
    'session_error_stats',
    'session_engagement',
    'session_stats',
    'site_visit_screens',
    'site_visits',
    'plan_events',
  ])
    await conn.db.execute(sql.raw(`delete from ${table}`));
});

const AT = Date.UTC(2026, 0, 5, 9, 0, 0);

function write(patch: Partial<DerivedSessionWrite> = {}): DerivedSessionWrite {
  const sessionId = patch.session?.sessionId ?? 's_one_000000001';
  return {
    session: {
      sessionId,
      schemaVersion: 1,
      derivedAt: AT,
      ledgerEntries: 20,
      hostId: 'p_host_00000001',
      plan: 'free',
      expertId: 'ada',
      language: 'en-US',
      band: 'beginner',
      domain: 'computing',
      canonicalId: 'en.x',
      scopeKey: 'en.x|beginner|ada|en-US',
      startedAt: AT,
      endedAt: AT + 1000,
      totalUsd: 0.03,
      ...patch.session,
    },
    stages: patch.stages ?? [
      { sessionId, stage: 'tts', samples: 4, ok: 4, failed: 0, reused: 0, totalMs: 1200 },
      { sessionId, stage: 'llm', samples: 2, ok: 2, failed: 0, reused: 0, totalMs: 900 },
    ],
    errors: patch.errors ?? [
      { sessionId, code: 'PEN_TTS_TIMEOUT', stage: 'tts', n: 1, firstAtMs: 10, lastAtMs: 10 },
    ],
    generated: patch.generated ?? [{ kind: 'lesson', scopeKey: 'en.x|beginner|ada|en-US' }],
    reused: patch.reused ?? [],
    topic: patch.topic ?? 'how compilers work',
  };
}

/** `execute()` yields `{ rows }` on PGlite and a bare array on postgres-js. */
const count = async (table: string): Promise<number> => {
  const res: unknown = await conn.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown }).rows ?? []);
  const first = (rows as Array<Record<string, unknown>>)[0];
  return Number(first?.n ?? 0);
};

describe('putDerivedSession', () => {
  it('is idempotent: the same session derived twice leaves one set of rows', async () => {
    await stats.putDerivedSession(write());
    await stats.putDerivedSession(write());
    expect(await count('session_stats')).toBe(1);
    expect(await count('session_stage_stats')).toBe(2);
    expect(await count('session_error_stats')).toBe(1);
    expect(await count('stats_work_origin')).toBe(1);
  });

  it('a later derivation replaces the stage rows rather than adding to them', async () => {
    await stats.putDerivedSession(write());
    // The thumbnail landed after the room closed: one more stage, one more entry.
    await stats.putDerivedSession(
      write({
        session: { sessionId: 's_one_000000001', ledgerEntries: 24 } as never,
        stages: [
          {
            sessionId: 's_one_000000001',
            stage: 'image',
            samples: 1,
            ok: 1,
            failed: 0,
            reused: 0,
            totalMs: 9000,
          },
        ],
      }),
    );
    const rows = await conn.db
      .select()
      .from(schema.sessionStageStats)
      .where(eq(schema.sessionStageStats.sessionId, 's_one_000000001'));
    expect(rows.map((r) => r.stage)).toEqual(['image']);
    const [session] = await conn.db
      .select()
      .from(schema.sessionStats)
      .where(eq(schema.sessionStats.sessionId, 's_one_000000001'));
    expect(session?.ledgerEntries).toBe(24);
  });

  it('the first session to generate a scope owns it; a later one does not steal it', async () => {
    await stats.putDerivedSession(write());
    await stats.putDerivedSession(
      write({
        session: { sessionId: 's_two_000000001', startedAt: AT + 1000 } as never,
        topic: 'again please',
      }),
    );
    const origins = await conn.db.select().from(schema.statsWorkOrigin);
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      sessionId: 's_one_000000001',
      topic: 'how compilers work',
    });
  });

  it('points a reuse link at whoever owns the scope, and carries the consumer’s search', async () => {
    await stats.putDerivedSession(write());
    await stats.putDerivedSession(
      write({
        session: { sessionId: 's_two_000000001', startedAt: AT + 1000 } as never,
        generated: [],
        reused: [{ kind: 'lesson', scopeKey: 'en.x|beginner|ada|en-US', uses: 4, savedUsd: 0.05 }],
        topic: 'teach me compilers',
      }),
    );
    const [link] = await conn.db.select().from(schema.sessionReuseLinks);
    expect(link).toMatchObject({
      sessionId: 's_two_000000001',
      sourceSessionId: 's_one_000000001',
      kind: 'lesson',
      uses: 4,
      topic: 'teach me compilers',
    });
  });

  it('never points a session at itself, even when it both generated and reused a scope', async () => {
    await stats.putDerivedSession(
      write({
        generated: [{ kind: 'lesson', scopeKey: 'en.x|beginner|ada|en-US' }],
        reused: [{ kind: 'lesson', scopeKey: 'en.x|beginner|ada|en-US', uses: 2, savedUsd: 0.01 }],
      }),
    );
    const [link] = await conn.db.select().from(schema.sessionReuseLinks);
    expect(link?.sourceSessionId).toBeNull();
  });

  it('leaves the origin honestly null when nobody in the statistics generated the scope', async () => {
    // A seeded pack: real reuse, and no session ever paid for it.
    await stats.putDerivedSession(
      write({
        generated: [],
        reused: [{ kind: 'pack', scopeKey: 'en.x', uses: 1, savedUsd: 0.4 }],
      }),
    );
    const [link] = await conn.db.select().from(schema.sessionReuseLinks);
    expect(link?.sourceSessionId).toBeNull();
    expect(link?.savedUsd).toBeCloseTo(0.4, 6);
  });

  it('deleting a session takes its rows and un-names it on the links that pointed at it', async () => {
    await stats.putDerivedSession(write());
    await stats.putDerivedSession(
      write({
        session: { sessionId: 's_two_000000001', startedAt: AT + 1000 } as never,
        generated: [],
        reused: [{ kind: 'lesson', scopeKey: 'en.x|beginner|ada|en-US', uses: 4, savedUsd: 0.05 }],
      }),
    );
    await stats.removeSession('s_one_000000001');
    expect(await count('session_stats')).toBe(1);
    const [link] = await conn.db.select().from(schema.sessionReuseLinks);
    // The reuse still happened and is still counted; it simply names nobody now.
    expect(link?.sessionId).toBe('s_two_000000001');
    expect(link?.sourceSessionId).toBeNull();
  });

  it('reports what is stale so the backfill knows what to re-derive', async () => {
    await stats.putDerivedSession(write());
    const state = await stats.derivedState(['s_one_000000001', 's_missing_00001']);
    expect(state.get('s_one_000000001')).toMatchObject({ ledgerEntries: 20, schemaVersion: 1 });
    expect(state.get('s_missing_00001')).toBeUndefined();
    expect(await stats.outdated(2)).toEqual(['s_one_000000001']);
    expect(await stats.outdated(1)).toEqual([]);
  });
});

// ── visits ───────────────────────────────────────────────────────────────────
const beacon = (patch: Partial<VisitBeaconWrite> = {}): VisitBeaconWrite => ({
  id: 'v_one_00000001',
  at: AT,
  participantId: 'p_host_00000001',
  signedIn: false,
  plan: 'free',
  activeMs: 15_000,
  views: 1,
  screen: 'home',
  screens: [{ screen: 'home', views: 1, activeMs: 15_000 }],
  referrerHost: null,
  campaignSource: null,
  campaignMedium: null,
  campaignName: null,
  deviceType: 'desktop',
  os: 'macOS',
  browser: 'Safari',
  browserMajor: 17,
  country: 'DE',
  region: null,
  city: null,
  geoSource: 'timezone',
  timezone: 'Europe/Berlin',
  utcOffsetMinutes: 60,
  language: 'de-DE',
  sessionId: null,
  final: false,
  gapMs: 30 * 60_000,
  actions: { ...NO_VISIT_ACTIONS },
  ...patch,
});

const visitRow = async (id: string) =>
  (await conn.db.select().from(schema.siteVisits).where(eq(schema.siteVisits.id, id)))[0];

describe('applyVisitBeacon', () => {
  it('creates the visit on the first beacon and adds to it on the next', async () => {
    expect(await stats.applyVisitBeacon(beacon())).toBe('v_one_00000001');
    await stats.applyVisitBeacon(beacon({ at: AT + 15_000, activeMs: 9_000 }));
    const row = await visitRow('v_one_00000001');
    expect(row).toMatchObject({
      activeMs: 24_000,
      views: 2,
      beacons: 2,
      startedAt: AT,
      lastSeenAt: AT + 15_000,
      country: 'DE',
      deviceType: 'desktop',
      utcOffsetMinutes: 60,
    });
    // Still open: only a `final` beacon or the sweep closes it.
    expect(row?.endedAt).toBeNull();
  });

  it('a beacon after a silence longer than the gap starts a new visit', async () => {
    await stats.applyVisitBeacon(beacon());
    const later = await stats.applyVisitBeacon(beacon({ at: AT + 31 * 60_000 }));
    expect(later).not.toBe('v_one_00000001');
    expect(await count('site_visits')).toBe(2);
    // The first is left exactly as it was, not extended across the gap.
    expect((await visitRow('v_one_00000001'))?.lastSeenAt).toBe(AT);
    expect((await visitRow(later))?.activeMs).toBe(15_000);
  });

  it('a final beacon closes the visit there and then', async () => {
    await stats.applyVisitBeacon(beacon({ final: true }));
    expect((await visitRow('v_one_00000001'))?.endedAt).toBe(AT);
  });

  it('accumulates each screen’s own time', async () => {
    await stats.applyVisitBeacon(
      beacon({
        screens: [
          { screen: 'home', views: 1, activeMs: 5_000 },
          { screen: 'room', views: 1, activeMs: 10_000 },
        ],
      }),
    );
    await stats.applyVisitBeacon(
      beacon({ at: AT + 15_000, screens: [{ screen: 'room', views: 2, activeMs: 8_000 }] }),
    );
    const rows = await conn.db.select().from(schema.siteVisitScreens);
    const byScreen = Object.fromEntries(rows.map((r) => [r.screen, r]));
    expect(byScreen.home).toMatchObject({ views: 1, activeMs: 5_000 });
    expect(byScreen.room).toMatchObject({ views: 3, activeMs: 18_000 });
  });

  it('counts the actions a visit took', async () => {
    await stats.applyVisitBeacon(
      beacon({ actions: { ...NO_VISIT_ACTIONS, sessionsStarted: 1, likes: 2 } }),
    );
    await stats.applyVisitBeacon(
      beacon({ at: AT + 10_000, actions: { ...NO_VISIT_ACTIONS, likes: 1 } }),
    );
    expect(await visitRow('v_one_00000001')).toMatchObject({ sessionsStarted: 1, likes: 3 });
  });

  it('a sign-in part-way through changes who the visit belongs to', async () => {
    await stats.applyVisitBeacon(beacon({ participantId: null, signedIn: false }));
    await stats.applyVisitBeacon(
      beacon({
        at: AT + 10_000,
        participantId: 'p_account_00001',
        signedIn: true,
        plan: 'standard',
      }),
    );
    expect(await visitRow('v_one_00000001')).toMatchObject({
      participantId: 'p_account_00001',
      signedIn: true,
      plan: 'standard',
    });
  });

  it('closes visits that stopped sending, and leaves the live ones alone', async () => {
    await stats.applyVisitBeacon(beacon({ id: 'v_old_00000001', at: AT }));
    await stats.applyVisitBeacon(beacon({ id: 'v_new_00000001', at: AT + 60 * 60_000 }));
    const closed = await stats.closeStaleVisits(AT + 61 * 60_000, 30 * 60_000);
    expect(closed).toBe(1);
    expect((await visitRow('v_old_00000001'))?.endedAt).toBe(AT);
    expect((await visitRow('v_new_00000001'))?.endedAt).toBeNull();
  });

  it('erases a participant’s visits when they ask not to be counted', async () => {
    await stats.applyVisitBeacon(beacon({ id: 'v_mine_0000001' }));
    await stats.applyVisitBeacon(
      beacon({ id: 'v_theirs_00001', participantId: 'p_someone_00001' }),
    );
    expect(await stats.removeVisits('p_host_00000001')).toBe(1);
    expect(await count('site_visits')).toBe(1);
    // Their screens go with them; nobody else's do.
    expect(await count('site_visit_screens')).toBe(1);
    expect(await visitRow('v_theirs_00001')).toBeDefined();
  });
});

describe('engagement and the subscription history', () => {
  it('counts replays, shares, downloads and exports separately', async () => {
    await stats.recordEngagement('s_one_000000001', 'replays', AT);
    await stats.recordEngagement('s_one_000000001', 'replays', AT + 1);
    await stats.recordEngagement('s_one_000000001', 'shares', AT + 2);
    const [row] = await conn.db.select().from(schema.sessionEngagement);
    expect(row).toMatchObject({ replays: 2, shares: 1, downloads: 0, lastAt: AT + 2 });
  });

  it('a redelivered Stripe webhook is not a second plan change', async () => {
    const event = {
      participantId: 'p_host_00000001',
      at: AT,
      fromPlan: 'free',
      toPlan: 'standard',
      interval: 'year' as const,
      status: 'active',
      amountCents: 9900,
      currency: 'usd',
    };
    await stats.recordPlanEvent(event);
    await stats.recordPlanEvent(event);
    expect(await count('plan_events')).toBe(1);
    // A real later change is still recorded.
    await stats.recordPlanEvent({ ...event, at: AT + 1000, fromPlan: 'standard', toPlan: 'free' });
    expect(await count('plan_events')).toBe(2);
  });
});
