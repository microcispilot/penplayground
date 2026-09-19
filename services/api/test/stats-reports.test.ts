import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerEntry, StageSample, VisitBeacon } from '@pen/contracts';
import type { SessionRecord } from '@pen/db';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';
import { StatsDeriver } from '../src/stats/deriver.js';

/**
 * The whole path, end to end: ledgers on disk → derived rows → the reports the
 * dashboard reads. Nothing is mocked but the providers; the database is a real
 * (in-memory) Postgres, and every assertion below is against SQL that ran.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'pen-stats-'));
const ADMIN_TOKEN = 'a'.repeat(40);
let services: Services;
let app: Hono;

/** A fixed week, so bucket boundaries and hour-of-day are not the test runner's business. */
const DAY = 86_400_000;
const MONDAY = Date.UTC(2026, 0, 5, 9, 0, 0);

const metric = (t: number, sample: Omit<StageSample, 't'>): LedgerEntry => ({
  kind: 'metric',
  t,
  sample: { ...sample, t },
});
function costLine(
  line: { component: string; unit: string; units: number; usd: number },
  t: number,
): LedgerEntry {
  return { kind: 'cost', t, line: { ...line, meta: {} } } as LedgerEntry;
}
const interaction = (t: number, event: string, props: Record<string, number> = {}): LedgerEntry =>
  ({
    kind: 'interaction',
    t,
    interaction: { t, participantId: 'p_host_00000001', event, props },
  }) as LedgerEntry;

interface Fixture {
  id: string;
  hostId: string;
  topic: string;
  startedAt: number;
  /** Served from earlier work rather than generated. */
  reuse?: boolean;
  segmentsReached?: number;
  recap?: string[];
  canonicalId?: string | null;
  expertId?: string;
}

/** A lesson's ledger: four planned segments, `segmentsReached` of them taught. */
function ledgerFor(f: Fixture): LedgerEntry[] {
  const reused = f.reuse === true;
  const reached = f.segmentsReached ?? 4;
  const entries: LedgerEntry[] = [
    metric(0, { stage: 'join', ms: 0, ok: true, meta: { role: 'host' } }),
    metric(5, {
      stage: 'resolve',
      ms: 0,
      ok: true,
      meta: {
        canonicalId: f.canonicalId ?? 'en.how-compilers-work',
        reused,
        savedUsd: reused ? 0.4 : 0,
      },
    }),
    metric(10, {
      stage: 'llm',
      ms: reused ? 0 : 800,
      ok: true,
      meta: reused
        ? { purpose: 'plan', firstTokenMs: -1, reused: true, memo: true, savedUsd: 0.02 }
        : { purpose: 'plan', firstTokenMs: 250, reused: false },
    }),
    interaction(900, 'first_audio', { 'latency.fromStartMs': reused ? 300 : 1800 }),
  ];
  for (let segment = 0; segment < reached; segment += 1) {
    entries.push(
      metric(1000 + segment * 100, {
        stage: 'llm',
        ms: reused ? 0 : 600,
        ok: true,
        meta: reused
          ? { purpose: 'lesson', reused: true, memo: true, savedUsd: 0.01 }
          : { purpose: 'lesson', firstTokenMs: 200, reused: false },
      }),
      {
        kind: 'cue',
        t: 1020 + segment * 100,
        cue: {
          seq: segment,
          thread: 'lesson',
          segment,
          at: 0,
          event: { type: 'say', id: `s${segment}`, text: 'x', tone: 'neutral' },
        },
      } as LedgerEntry,
      metric(1050 + segment * 100, {
        stage: 'tts',
        ms: reused ? 4 : 350,
        ok: true,
        meta: { firstChunkMs: reused ? 3 : 140, reused, savedUsd: reused ? 0.003 : 0 },
      }),
    );
    if (!reused)
      entries.push(
        costLine(
          { component: 'tts', unit: 'bytes', units: 2048, usd: 0.002 },
          1060 + segment * 100,
        ),
      );
  }
  if (!reused) {
    entries.push(costLine({ component: 'llm', unit: 'tokens_in', units: 4000, usd: 0.012 }, 5000));
    entries.push(
      costLine({ component: 'image', unit: 'tokens_out', units: 400, usd: 0.016 }, 5100),
    );
    entries.push(
      metric(5100, {
        stage: 'image',
        ms: 9000,
        ok: true,
        meta: { purpose: 'session_thumbnail', reused: false },
      }),
    );
  } else {
    entries.push(
      metric(5100, {
        stage: 'image',
        ms: 0,
        ok: true,
        meta: { purpose: 'session_thumbnail', reused: true, savedUsd: 0.016 },
      }),
    );
  }
  if ((f.recap ?? []).length > 0) entries.push(interaction(9000, 'recap_shown'));
  return entries;
}

function recordFor(f: Fixture): SessionRecord {
  return {
    id: f.id,
    topic: f.topic,
    title: f.topic,
    promise: '',
    expertId: f.expertId ?? 'ada-lovelace',
    hostId: f.hostId,
    hostName: 'Learner',
    band: 'beginner',
    domain: 'computing',
    visibility: 'public',
    startedAt: f.startedAt,
    endedAt: f.startedAt + 600_000,
    durationMs: 600_000,
    segments: 4,
    questions: 0,
    recap: f.recap ?? [],
    views: 0,
    thumbnail: null,
    canonicalId: f.canonicalId ?? 'en.how-compilers-work',
    language: 'en-US',
    description: '',
    keywords: [],
    likes: 0,
  };
}

/**
 * Three learners of the same topic and one of another: the first pays for the
 * work, the next two are given it. That is the shape every reuse assertion
 * below leans on.
 */
const fixtures: Fixture[] = [
  {
    id: 's_first_0000001',
    hostId: 'p_alice_0000001',
    topic: 'how compilers work',
    startedAt: MONDAY,
    recap: ['a'],
  },
  {
    id: 's_second_000001',
    hostId: 'p_bob_00000001',
    topic: 'compiler basics please',
    startedAt: MONDAY + DAY,
    reuse: true,
    recap: ['a'],
  },
  {
    id: 's_third_0000001',
    hostId: 'p_cara_0000001',
    topic: 'what is a compiler',
    startedAt: MONDAY + 2 * DAY,
    reuse: true,
    // Stopped half way, with no recap: the abandonment case.
    segmentsReached: 2,
  },
  {
    id: 's_other_0000001',
    hostId: 'p_alice_0000001',
    topic: 'how kidneys work',
    startedAt: MONDAY + 3 * DAY,
    canonicalId: 'en.how-kidneys-work',
    expertId: 'marie-curie',
    recap: ['a'],
  },
];

const admin = { 'x-admin-token': ADMIN_TOKEN };
const get = async (path: string, headers: Record<string, string> = admin) => {
  const res = await app.request(path, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
};

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
    PEN_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  services = await buildServices(cfg);
  ({ app } = buildApp(services));

  for (const f of fixtures) {
    await services.participants.ensure({
      id: f.hostId,
      name: 'Learner',
      plan: 'free',
      anonymous: true,
    });
    await services.sessions.upsert(recordFor(f));
    for (const entry of ledgerFor(f)) services.ledger.append(f.id, entry);
  }
  // Oldest first — the same order the backfill walks, and what makes the
  // origin of a reused lesson the session that actually taught it first.
  for (const f of fixtures)
    await services.deriver.derive(f.id, { completed: (f.recap ?? []).length > 0 });
}, 120_000);

afterAll(async () => {
  services.deriver.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Wide enough to hold both halves of the fixture: the sessions, which sit on a
 * fixed week so bucket boundaries are not the test runner's business, and the
 * visits, which are stamped with the real clock because that is what the
 * endpoint does.
 */
const window = `from=${MONDAY - DAY}&to=${Date.now() + DAY}`;

describe('derivation lands in the database', () => {
  it('one row per session, with the cost and the reuse the ledger recorded', async () => {
    const { body } = await get(
      `/api/admin/stats/sessions?${window}&orderBy=startedAt&direction=asc`,
    );
    const rows = body.sessions as unknown as Array<Record<string, unknown>>;
    expect(body.total).toBe(4);
    expect(rows.map((r) => r.sessionId)).toEqual(fixtures.map((f) => f.id));
    const first = rows[0] as Record<string, number | boolean | string>;
    // Four tts lines at $0.002, one llm at $0.012, one image at $0.016.
    expect(first.totalUsd).toBeCloseTo(0.036, 6);
    expect(first.packHit).toBe(false);
    expect(first.savedUsd).toBe(0);
    expect(first.topic).toBe('how compilers work');
    const second = rows[1] as Record<string, number | boolean>;
    expect(second.packHit).toBe(true);
    expect(second.totalUsd).toBe(0);
    expect(second.savedUsd).toBeGreaterThan(0.4);
    expect(second.freshEquivalentUsd).toBeCloseTo(second.savedUsd as number, 6);
  });

  it('re-deriving replaces the rows rather than doubling them', async () => {
    const before = await get(`/api/admin/stats/sessions/${fixtures[0]?.id}`);
    const stagesBefore = (before.body.stages as unknown as unknown[]).length;
    await services.deriver.derive(fixtures[0]?.id ?? '');
    const after = await get(`/api/admin/stats/sessions/${fixtures[0]?.id}`);
    expect((after.body.stages as unknown as unknown[]).length).toBe(stagesBefore);
    expect((await get(`/api/admin/stats/sessions?${window}`)).body.total).toBe(4);
  });

  it('gives per-stage counts, percentiles and spend across every session', async () => {
    const { body } = await get(`/api/admin/stats/stages?${window}`);
    const stages = body.stages as unknown as Array<Record<string, number | string>>;
    const tts = stages.find((s) => s.stage === 'tts');
    expect(tts?.sessions).toBe(4);
    // 4 + 4 + 2 + 4 sentences across the four sessions.
    expect(tts?.samples).toBe(14);
    expect(tts?.reused).toBe(6);
    expect(stages.find((s) => s.stage === 'image')?.samples).toBe(4);
  });
});

describe('reuse, answered as the owner asked it', () => {
  it('names the session whose work was reused, and the searches it was reused for', async () => {
    const { body } = await get(`/api/admin/stats/reuse/${fixtures[0]?.id}`);
    expect(body.reusedBy).toBe(2);
    const searches = (body.searches as unknown as Array<{ topic: string; uses: number }>).map(
      (s) => s.topic,
    );
    expect(searches.sort()).toEqual(['compiler basics please', 'what is a compiler']);
    const kinds = (body.byKind as unknown as Array<{ kind: string }>).map((k) => k.kind).sort();
    expect(kinds).toEqual(['lesson', 'pack', 'picture', 'voice']);
    expect(body.savedForOthersUsd).toBeGreaterThan(0.8);
  });

  it('a session nobody has reused says so plainly', async () => {
    const { body } = await get(`/api/admin/stats/reuse/${fixtures[3]?.id}`);
    expect(body.reusedBy).toBe(0);
    expect(body.searches).toEqual([]);
  });

  it('never claims a session reused itself', async () => {
    const { body } = await get(`/api/admin/stats/sessions/${fixtures[0]?.id}`);
    // It generated this scope, so it takes from nobody — and the two that took
    // from it are other sessions.
    expect(body.tookFrom).toEqual([]);
    const { body: reuse } = await get(`/api/admin/stats/reuse/${fixtures[0]?.id}`);
    expect(reuse.reusedBy).toBe(2);
  });

  it('totals the reuse and what it saved, and ranks the sessions others lean on', async () => {
    const { body } = await get(`/api/admin/stats/reuse?${window}`);
    expect(body.packHits).toBe(2);
    expect(body.memoSegmentsReused).toBe(6);
    expect(body.memoSegmentsGenerated).toBe(8);
    expect(body.ttsSentencesReused).toBe(6);
    expect(body.savedShare).toBeGreaterThan(0.8);
    const top = body.mostReused as unknown as Array<{ sessionId: string; reusedBy: number }>;
    expect(top[0]).toMatchObject({ sessionId: fixtures[0]?.id, reusedBy: 2 });
  });

  it('a session the consumer took from is on the consumer’s own detail', async () => {
    const { body } = await get(`/api/admin/stats/sessions/${fixtures[1]?.id}`);
    const took = body.tookFrom as unknown as Array<{ kind: string; sourceSessionId: string }>;
    expect(took.length).toBeGreaterThan(0);
    for (const t of took) expect(t.sourceSessionId).toBe(fixtures[0]?.id);
  });
});

describe('why sessions stop', () => {
  it('sorts sessions into reasons, with how far in they were', async () => {
    const { body } = await get(`/api/admin/stats/abandonment?${window}`);
    const reasons = Object.fromEntries(
      (body.reasons as unknown as Array<{ reason: string; sessions: number }>).map((r) => [
        r.reason,
        r.sessions,
      ]),
    );
    expect(reasons.completed).toBe(3);
    expect(reasons.left_mid_segment).toBe(1);
    const bySegment = body.bySegment as unknown as Array<{ segment: number; sessions: number }>;
    expect(bySegment).toEqual([{ segment: 2, sessions: 1 }]);
  });

  it('an order-by nobody offered falls back instead of reaching SQL', async () => {
    // `constructor` and `toString` are truthy properties of every object, so
    // a whitelist that is an object rather than a map lets them through.
    for (const orderBy of ['constructor', 'toString', '__proto__', 'no_such_column']) {
      const res = await get(`/api/admin/stats/sessions?${window}&orderBy=${orderBy}`);
      expect(res.status, orderBy).toBe(200);
      expect((res.body.sessions as unknown as unknown[]).length).toBeGreaterThan(0);
      const users = await get(`/api/admin/stats/users?${window}&orderBy=${orderBy}`);
      expect(users.status, orderBy).toBe(200);
    }
  });

  it('can be filtered to just the ones that stopped', async () => {
    const { body } = await get(`/api/admin/stats/sessions?${window}&leaveReason=left_mid_segment`);
    expect(body.total).toBe(1);
    const row = (body.sessions as unknown as Array<Record<string, number>>)[0];
    expect(row?.progress).toBe(0.5);
    expect(row?.segmentsReached).toBe(2);
  });
});

describe('cost', () => {
  it('buckets spend over time and splits it by component, plan and expert', async () => {
    const { body } = await get(`/api/admin/stats/cost?${window}&bucket=day`);
    const series = body.series as unknown as Array<{ at: number; totalUsd: number }>;
    // Four sessions on four different days.
    expect(series).toHaveLength(4);
    const totals = body.totals as unknown as Record<string, number>;
    expect(totals.sessions).toBe(4);
    // Two fresh sessions at $0.036 each; the two reused ones cost nothing.
    expect(totals.totalUsd).toBeCloseTo(0.072, 6);
    expect(totals.ttsUsd).toBeCloseTo(0.016, 6);
    expect(totals.imageUsd).toBeCloseTo(0.032, 6);
    expect(totals.savedUsd).toBeGreaterThan(0.8);
    const experts = body.byExpert as unknown as Array<{ expertId: string; sessions: number }>;
    expect(experts.find((e) => e.expertId === 'marie-curie')?.sessions).toBe(1);
  });

  it('a week bucket puts the same spend in one point', async () => {
    const { body } = await get(`/api/admin/stats/cost?${window}&bucket=week`);
    expect((body.series as unknown as unknown[]).length).toBeLessThanOrEqual(2);
  });
});

describe('the headline', () => {
  it('answers the numbers a dashboard opens on', async () => {
    const { body } = await get(`/api/admin/stats/overview?${window}`);
    const o = body.overview as unknown as Record<string, number>;
    expect(o.sessions).toBe(4);
    expect(o.completed).toBe(3);
    expect(o.completionRate).toBe(0.75);
    expect(o.learners).toBe(3);
    expect(o.costPerSessionUsd).toBeCloseTo(0.018, 6);
    expect(o.reuseRate).toBeGreaterThan(0.8);
    expect(o.timeToFirstAudioP50Ms).toBeGreaterThan(0);
  });
});

describe('when people learn', () => {
  it('counts sessions by UTC hour and day of week', async () => {
    const { body } = await get(`/api/admin/stats/clock?${window}`);
    const cells = body.sessionsUtc as unknown as Array<{ hour: number; n: number }>;
    expect(cells.every((c) => c.hour === 9)).toBe(true);
    expect(cells.reduce((n, c) => n + c.n, 0)).toBe(4);
  });
});

describe('visits, including the ones nobody signed in for', () => {
  const beacon = (patch: Partial<VisitBeacon> & { visitId: string }): VisitBeacon =>
    ({
      timezone: 'Europe/Berlin',
      language: 'de-DE',
      activeMs: 12_000,
      screens: [{ screen: 'home', views: 1, activeMs: 12_000 }],
      actions: {},
      final: false,
      ...patch,
    }) as VisitBeacon;

  const send = (body: VisitBeacon, headers: Record<string, string> = {}) =>
    app.request('/api/visits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it('counts a visitor with no bearer at all, with their device and country', async () => {
    const res = await send(beacon({ visitId: 'v_anonymous_01' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counted: true });

    const devices = await get(`/api/admin/stats/devices?${window}`);
    const rows = devices.body.rows as unknown as Array<Record<string, string | number>>;
    expect(rows.find((r) => r.deviceType === 'mobile')).toMatchObject({
      os: 'iOS',
      browser: 'Safari',
    });
    const geo = await get(`/api/admin/stats/geography?${window}`);
    const places = geo.body.rows as unknown as Array<Record<string, string | number>>;
    expect(places.find((p) => p.country === 'DE')).toMatchObject({
      source: 'timezone',
      city: null,
    });
    // The payload says out loud where the country came from.
    expect(String(geo.body.note)).toContain('browser timezone');
  });

  it('accumulates engaged time across beacons and caps what one beacon may add', async () => {
    // A country of its own, so the geography report isolates this one visit.
    const nz = { visitId: 'v_engaged_001', timezone: 'Pacific/Auckland' } as const;
    await send(beacon({ ...nz, activeMs: 15_000, screens: [] }));
    // A beacon claiming an hour is credited only one interval's worth.
    await send(beacon({ ...nz, activeMs: 3_600_000, screens: [] }));
    const { body } = await get(`/api/admin/stats/geography?${window}`);
    const row = (body.rows as unknown as Array<Record<string, number | string>>).find(
      (r) => r.country === 'NZ',
    );
    expect(row?.visits).toBe(1);
    // 15 000 accepted as sent, plus the 22 500 ms ceiling — never the hour.
    expect(row?.activeMs).toBe(37_500);
  });

  it('keeps each screen’s share of the time, and never more than the beacon carried', async () => {
    await send(
      beacon({
        visitId: 'v_screens_001',
        activeMs: 15_000,
        screens: [
          { screen: 'home', views: 1, activeMs: 10_000 },
          { screen: 'room', views: 1, activeMs: 40_000 },
        ],
      }),
    );
    const { body } = await get(`/api/admin/stats/visits?${window}`);
    const byScreen = body.byScreen as unknown as Array<{ screen: string; activeMs: number }>;
    const total = byScreen.reduce((n, s) => n + s.activeMs, 0);
    // Everything across every visit in the window, and still no more than the
    // beacons were allowed to claim.
    expect(total).toBeLessThanOrEqual(37_500 + 15_000 + 12_000 + 1);
    expect(byScreen.find((s) => s.screen === 'room')?.activeMs).toBeLessThanOrEqual(15_000);
  });

  it('counts a session started from a visit, and the conversion that makes', async () => {
    await send(
      beacon({
        visitId: 'v_converted_01',
        actions: { session_started: 1 },
        sessionId: fixtures[0]?.id,
      }),
    );
    const { body } = await get(`/api/admin/stats/visits?${window}`);
    const totals = body.totals as unknown as Record<string, number>;
    expect(totals.sessionsStarted).toBeGreaterThanOrEqual(1);
    expect(totals.conversion).toBeGreaterThan(0);
  });

  it('a replay and a share counted from a beacon reach the session’s own row', async () => {
    await send(
      beacon({
        visitId: 'v_replayed_001',
        actions: { replay_started: 1, share_copied: 1 },
        sessionId: fixtures[0]?.id,
      }),
    );
    const { body } = await get(`/api/admin/stats/sessions/${fixtures[0]?.id}`);
    expect((body.session as unknown as Record<string, number>).replays).toBe(1);
    expect((body.session as unknown as Record<string, number>).shares).toBe(1);
  });

  it('refuses a malformed beacon without telling the page anything went wrong', async () => {
    const res = await app.request('/api/visits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitId: 'short' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counted: false });
  });
});

describe('the analytics opt-out is honoured on the server', () => {
  it('writes nothing for a participant who turned it off, and erases what was written', async () => {
    const auth = await app.request('/api/auth/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quiet' }),
    });
    const { token, participant } = (await auth.json()) as {
      token: string;
      participant: { id: string };
    };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const beacon = (visitId: string) =>
      JSON.stringify({
        visitId,
        timezone: 'Europe/Paris',
        activeMs: 9_000,
        screens: [{ screen: 'home', views: 1, activeMs: 9_000 }],
        actions: {},
        final: false,
      });

    const counted = await app.request('/api/visits', {
      method: 'POST',
      headers,
      body: beacon('v_optout_0001'),
    });
    expect(await counted.json()).toEqual({ counted: true });
    const rowsFor = async (country: string) =>
      (
        (await get(`/api/admin/stats/geography?${window}`)).body.rows as unknown as Array<
          Record<string, number | string>
        >
      ).find((r) => r.country === country);
    expect(await rowsFor('FR')).toMatchObject({ visits: 1 });

    // Turn analytics off, exactly as Privacy choices does.
    const off = await app.request('/api/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ analyticsOptOut: true }),
    });
    expect(off.status).toBe(200);

    // France is this test's own country, so the geography report is the proof.
    const france = async () =>
      (
        (await get(`/api/admin/stats/geography?${window}`)).body.rows as unknown as Array<
          Record<string, number | string>
        >
      ).find((r) => r.country === 'FR');
    expect(await france()).toBeUndefined();

    // … and the next beacon writes nothing at all.
    const refused = await app.request('/api/visits', {
      method: 'POST',
      headers,
      body: beacon('v_optout_0002'),
    });
    expect(await refused.json()).toEqual({ counted: false });
    expect(await france()).toBeUndefined();
    expect(participant.id).toMatch(/^p_/);
  });
});

describe('plans and people', () => {
  it('reports the plan mix, with the monthly/yearly split Stripe knows', async () => {
    await services.participants.ensure({
      id: 'p_paid_000000001',
      name: 'Paid',
      plan: 'free',
      anonymous: false,
    });
    await services.participants.setPlan('p_paid_000000001', 'standard', 'cus_1', {
      interval: 'year',
      status: 'active',
      since: new Date(MONDAY),
    });
    await services.stats.recordPlanEvent({
      participantId: 'p_paid_000000001',
      at: MONDAY,
      fromPlan: 'free',
      toPlan: 'standard',
      interval: 'year',
      status: 'active',
      amountCents: 9900,
      currency: 'usd',
    });
    // A redelivered webhook must not become a second conversion.
    await services.stats.recordPlanEvent({
      participantId: 'p_paid_000000001',
      at: MONDAY,
      fromPlan: 'free',
      toPlan: 'standard',
      interval: 'year',
      status: 'active',
      amountCents: 9900,
      currency: 'usd',
    });

    const { body } = await get(`/api/admin/stats/plans?${window}&bucket=day`);
    const mix = body.mix as unknown as Array<Record<string, string | number | null>>;
    expect(mix.find((m) => m.plan === 'standard')).toMatchObject({
      interval: 'year',
      participants: 1,
    });
    const changes = body.changes as unknown as Array<Record<string, number>>;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ upgrades: 1, yearly: 1, monthly: 0, amountCents: 9900 });
  });

  it('per-user detail joins their sessions, spend and time on the site', async () => {
    const { body } = await get(`/api/admin/stats/users?${window}&orderBy=sessions`);
    const users = body.users as unknown as Array<Record<string, string | number>>;
    const alice = users.find((u) => u.id === 'p_alice_0000001');
    expect(alice).toMatchObject({ sessions: 2, completed: 2 });
    expect(alice?.totalUsd).toBeCloseTo(0.072, 6);
  });

  it('one person, with the sessions they hosted', async () => {
    const { body } = await get(`/api/admin/stats/users/p_alice_0000001?${window}`);
    expect((body.participant as unknown as { id: string }).id).toBe('p_alice_0000001');
    expect((body.sessions as unknown as unknown[]).length).toBe(2);
  });

  it('retention puts learners in the cohort they arrived in', async () => {
    // Participant rows are stamped with the clock, so the cohort is today;
    // this learner's session has to be today too for the grid to mean
    // anything. The four fixtures above are a fixed week in the past and
    // therefore sit before their own cohort, which is exactly what the
    // `a.at >= c.cohort` guard exists to drop.
    const at = Date.now();
    await services.participants.ensure({
      id: 'p_fresh_000001',
      name: 'Fresh',
      plan: 'free',
      anonymous: true,
    });
    const fresh: Fixture = {
      id: 's_fresh_0000001',
      hostId: 'p_fresh_000001',
      topic: 'how engines work',
      startedAt: at,
      canonicalId: 'en.how-engines-work',
      recap: ['a'],
    };
    await services.sessions.upsert(recordFor(fresh));
    for (const entry of ledgerFor(fresh)) services.ledger.append(fresh.id, entry);
    await services.deriver.derive(fresh.id, { completed: true });

    const { body } = await get(
      `/api/admin/stats/retention?from=${at - 30 * DAY}&to=${at + DAY}&bucket=day&metric=session`,
    );
    const cohorts = body.cohorts as unknown as Array<{ size: number; periods: number[] }>;
    expect(cohorts.length).toBeGreaterThan(0);
    const today = cohorts[cohorts.length - 1];
    expect(today?.size).toBeGreaterThanOrEqual(1);
    expect(today?.periods[0]).toBeGreaterThanOrEqual(1);
    // Nobody can be more active than the cohort is large.
    for (const c of cohorts) for (const p of c.periods) expect(p).toBeLessThanOrEqual(c.size);
  });
});

describe('only an admin may read any of it', () => {
  it('refuses with no bearer and no token', async () => {
    const res = await app.request(`/api/admin/stats/overview?${window}`);
    expect(res.status).toBe(403);
  });

  it('refuses an ordinary signed-in learner: a bearer is not an allow-list entry', async () => {
    const auth = await app.request('/api/auth/anonymous', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { token } = (await auth.json()) as { token: string };
    const res = await app.request(`/api/admin/stats/cost?${window}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'FORBIDDEN' });
  });

  it('refuses a machine token that is close but not equal', async () => {
    const res = await app.request(`/api/admin/stats/cost?${window}`, {
      headers: { 'x-admin-token': `${'a'.repeat(39)}b` },
    });
    expect(res.status).toBe(403);
  });

  it('guards every report, not only the first', async () => {
    for (const path of [
      'overview',
      'cost',
      'stages',
      'abandonment',
      'retention',
      'sessions',
      'users',
      'reuse',
      'visits',
      'geography',
      'devices',
      'clock',
      'plans',
    ]) {
      const res = await app.request(`/api/admin/stats/${path}?${window}`);
      expect(res.status, `/${path} was not guarded`).toBe(403);
    }
  });
});

describe('the queue a finished room hands its ledger to', () => {
  it('a room that ends queues rather than derives: nothing shares the connection with a lesson', async () => {
    const id = 's_queued_00001';
    await services.participants.ensure({
      id: 'p_queue_000001',
      name: 'Q',
      plan: 'free',
      anonymous: true,
    });
    const f: Fixture = {
      id,
      hostId: 'p_queue_000001',
      topic: 'how queues work',
      startedAt: MONDAY + 4 * DAY,
      canonicalId: 'en.how-queues-work',
      recap: ['a'],
    };
    await services.sessions.upsert(recordFor(f));
    for (const entry of ledgerFor(f)) services.ledger.append(id, entry);

    services.deriver.enqueue(id, { completed: true });
    expect(services.deriver.pending).toBe(1);
    // Nothing is written until something drains it.
    expect((await get(`/api/admin/stats/sessions/${id}`)).status).toBe(404);

    expect(await services.deriver.drain()).toBe(1);
    expect((await get(`/api/admin/stats/sessions/${id}`)).status).toBe(200);
    // The settle pass is queued behind it, for work that lands late — and it
    // is not due yet, so draining again does nothing at all.
    expect(services.deriver.pending).toBe(1);
    expect(await services.deriver.drain()).toBe(0);
    expect(services.deriver.pending).toBe(1);
  });

  it('a session queued twice before a drain is derived once', () => {
    const before = services.deriver.pending;
    const id = fixtures[0]?.id ?? '';
    services.deriver.enqueue(id, { completed: true });
    services.deriver.enqueue(id, { completed: true });
    expect(services.deriver.pending).toBe(before + 1);
  });

  it('a queued session with no ledger and no row is dropped, not retried forever', async () => {
    services.deriver.enqueue('s_nothing_00001');
    const drained = await services.deriver.drain();
    expect(drained).toBeGreaterThanOrEqual(1);
    expect((await get('/api/admin/stats/sessions/s_nothing_00001')).status).toBe(404);
  });

  it('a closed deriver accepts nothing and drains nothing', async () => {
    const closed = new StatsDeriver({
      ledger: services.ledger,
      sessions: services.sessions,
      participants: services.participants,
      stats: services.stats,
      onError: () => undefined,
    });
    closed.close();
    closed.enqueue(fixtures[0]?.id ?? '');
    expect(closed.pending).toBe(0);
    expect(await closed.drain()).toBe(0);
  });
});

describe('the beacon a page sends as it goes away', () => {
  /**
   * `navigator.sendBeacon` cannot make a CORS preflight, so the final beacon
   * of every visit arrives as `text/plain`. If this endpoint ever stops
   * accepting that, every goodbye is silently lost and only the active-time
   * totals would show it — quietly, and much later.
   */
  it('is accepted as text/plain, which is the only type sendBeacon can use', async () => {
    const res = await app.request('/api/visits', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        visitId: 'v_goodbye_0001',
        timezone: 'Europe/Lisbon',
        activeMs: 4_000,
        screens: [{ screen: 'home', views: 1, activeMs: 4_000 }],
        actions: {},
        final: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counted: true });
    const { body } = await get(`/api/admin/stats/geography?${window}`);
    const rows = body.rows as unknown as Array<Record<string, number | string>>;
    expect(rows.find((r) => r.country === 'PT')).toMatchObject({ visits: 1, activeMs: 4_000 });
  });
});

describe('the beacon endpoint has a ceiling', () => {
  /**
   * It is the one route here that anyone may call without signing in, and
   * every call writes a row. A page sends four a minute; this proves the
   * hundred-and-twenty-first is dropped rather than stored, and dropped the
   * way everything else here is — in silence, with a 200.
   */
  it('drops beacons past the per-address limit, without telling the caller', async () => {
    const beaconFor = (visitId: string) =>
      JSON.stringify({
        visitId,
        timezone: 'Asia/Tokyo',
        activeMs: 1_000,
        screens: [{ screen: 'home', views: 1, activeMs: 1_000 }],
        actions: {},
        final: false,
      });
    const send = (visitId: string) =>
      app.request('/api/visits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.7' },
        body: beaconFor(visitId),
      });

    let counted = 0;
    for (let i = 0; i < 140; i += 1) {
      const res = await send(`v_flood_${String(i).padStart(6, '0')}`);
      expect(res.status).toBe(200);
      if (((await res.json()) as { counted: boolean }).counted) counted += 1;
    }
    expect(counted).toBe(120);
    const { body } = await get(`/api/admin/stats/geography?${window}`);
    const rows = body.rows as unknown as Array<Record<string, number | string>>;
    expect(rows.find((r) => r.country === 'JP')?.visits).toBe(120);
  });
});
