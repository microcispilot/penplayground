/**
 * A scripted reporting API (ADR-0027).
 *
 * One fixture, two shapes, used by both kinds of test:
 *
 *   · `full` — a deployment that has been running for a month. Every list
 *     has rows, every chart has columns, and the numbers are internally
 *     consistent enough that a screenshot can be read for sense rather than
 *     only for layout.
 *   · `empty` — a deployment deployed this morning. Every count is zero and
 *     every list is empty, which is the state the pages are hardest to get
 *     right in and the one a reviewer sees first.
 *
 * It is deterministic: a seeded generator, no `Math.random`, no `Date.now`
 * anywhere below. Two runs produce byte-identical payloads, so a screenshot
 * diff means a code change and a failing assertion means a regression.
 *
 * The shapes are the ones `services/api/src/stats/routes.ts` returns, parsed
 * by the same schemas the console parses a real answer with — so a fixture
 * that drifts from the server fails the screen test rather than quietly
 * testing something the API never sends.
 */

export type Mode = 'full' | 'empty';

/** Mulberry32: three lines, deterministic, and good enough for plausible shapes. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

export interface Fixture {
  window: { from: number; to: number };
  /** Path under `/api/admin/stats/`, without the query string. */
  reports: Record<string, unknown>;
}

export function buildFixture(mode: Mode, now: number): Fixture {
  const to = now;
  const from = now - 30 * DAY;
  const win = { from, to };
  const rand = seeded(20260919);
  const zero = mode === 'empty';

  // Thirty daily buckets, aligned to midnight UTC the way the server's
  // `bucketMs` aligns them.
  const startOfDay = Math.floor(from / DAY) * DAY;
  const days = Array.from({ length: 30 }, (_, i) => startOfDay + i * DAY);

  const sessionsPerDay = days.map((_, i) =>
    zero ? 0 : Math.max(2, Math.round(18 + i * 1.4 + rand() * 14)),
  );
  const totalSessions = sessionsPerDay.reduce((a, b) => a + b, 0);
  const completed = Math.round(totalSessions * 0.71);

  const costSeries = days.map((at, i) => {
    const sessions = sessionsPerDay[i] ?? 0;
    const llm = sessions * 0.0182;
    const tts = sessions * 0.0094;
    const image = sessions * 0.0041;
    const stt = sessions * 0.0016;
    const intent = sessions * 0.0004;
    const search = sessions * 0.0011;
    const total = llm + tts + image + stt + intent + search;
    return {
      at,
      sessions,
      totalUsd: round(total),
      llmUsd: round(llm),
      intentUsd: round(intent),
      imageUsd: round(image),
      ttsUsd: round(tts),
      sttUsd: round(stt),
      searchUsd: round(search),
      revenueUsd: round(sessions * 0.104),
      freshEquivalentUsd: round(total * 2.35),
      savedUsd: round(total * 1.35),
    };
  });
  const costTotals = costSeries.reduce(
    (acc, p) => ({
      sessions: acc.sessions + p.sessions,
      totalUsd: round(acc.totalUsd + p.totalUsd),
      llmUsd: round(acc.llmUsd + p.llmUsd),
      intentUsd: round(acc.intentUsd + p.intentUsd),
      imageUsd: round(acc.imageUsd + p.imageUsd),
      ttsUsd: round(acc.ttsUsd + p.ttsUsd),
      sttUsd: round(acc.sttUsd + p.sttUsd),
      searchUsd: round(acc.searchUsd + p.searchUsd),
      revenueUsd: round(acc.revenueUsd + p.revenueUsd),
      freshEquivalentUsd: round(acc.freshEquivalentUsd + p.freshEquivalentUsd),
      savedUsd: round(acc.savedUsd + p.savedUsd),
    }),
    {
      sessions: 0,
      totalUsd: 0,
      llmUsd: 0,
      intentUsd: 0,
      imageUsd: 0,
      ttsUsd: 0,
      sttUsd: 0,
      searchUsd: 0,
      revenueUsd: 0,
      freshEquivalentUsd: 0,
      savedUsd: 0,
    },
  );

  const visitSeries = days.map((at, i) => {
    const visits = zero ? 0 : Math.max(6, Math.round(64 + i * 3.1 + rand() * 40));
    const signedIn = Math.round(visits * 0.31);
    return {
      at,
      visits,
      visitors: Math.round(visits * 0.86),
      signedIn,
      anonymous: visits - signedIn,
      activeMs: visits * 96_000,
      bounces: Math.round(visits * 0.42),
      sessionsStarted: Math.round(visits * 0.19),
    };
  });
  const visits = visitSeries.reduce((a, p) => a + p.visits, 0);
  const activeMs = visitSeries.reduce((a, p) => a + p.activeMs, 0);
  const sessionsStarted = visitSeries.reduce((a, p) => a + p.sessionsStarted, 0);

  const stages = zero
    ? []
    : [
        stage('resolve', 1290, 1290, 0, 1102, 0, 0.42, 4, 11, 61),
        stage('context', 1284, 5140, 3, 4901, 0, 1.82, 3, 9, 74),
        stage('prepare', 214, 214, 2, 0, 1.44, 0, 2140, 5210, 9800),
        stage('llm', 1284, 8812, 21, 5210, 24.1, 31.4, 610, 1840, 7200),
        stage('intent', 1284, 2108, 1, 0, 0.51, 0, 92, 260, 910),
        stage('image', 1190, 1190, 9, 902, 5.42, 12.8, 1810, 4200, 14_900),
        stage('tts', 1284, 24_118, 44, 19_204, 12.4, 41.2, 210, 640, 3100),
        stage('stt', 902, 4211, 12, 0, 2.11, 0, 180, 520, 2400),
        stage('turn', 902, 4199, 0, 0, 0, 0, 840, 1920, 6400),
      ];

  const reasons = zero
    ? []
    : [
        reason('completed', completed, 1, 742_000, 7.8),
        reason('left_mid_segment', Math.round(totalSessions * 0.14), 0.41, 290_000, 3.1),
        reason('never_started', Math.round(totalSessions * 0.06), 0, 4200, 0),
        reason('idle_timeout', Math.round(totalSessions * 0.04), 0.52, 510_000, 4.1),
        reason('left_after_error', Math.round(totalSessions * 0.02), 0.33, 180_000, 2.6),
        reason('length_ceiling', Math.round(totalSessions * 0.02), 0.94, 900_000, 7.2),
        reason('left_during_ad', Math.round(totalSessions * 0.01), 0.48, 240_000, 3.8),
      ];

  const reuseByKind = zero
    ? []
    : [
        { kind: 'voice', links: 3120, uses: 19_204, savedUsd: 41.2 },
        { kind: 'lesson', links: 1104, uses: 5210, savedUsd: 31.4 },
        { kind: 'picture', links: 802, uses: 902, savedUsd: 12.8 },
        { kind: 'pack', links: 640, uses: 1102, savedUsd: 6.1 },
        { kind: 'card', links: 410, uses: 410, savedUsd: 2.4 },
      ];

  const sessionRows = zero
    ? []
    : Array.from({ length: 12 }, (_, i) => sessionRow(i, to - (i + 1) * 4_600_000, rand));

  const userRows = zero ? [] : Array.from({ length: 10 }, (_, i) => userRow(i, to, rand));

  const cohorts = zero
    ? []
    : Array.from({ length: 8 }, (_, i) => {
        const cohort = startOfDay - (7 - i) * 0 + i * 4 * DAY;
        const size = 40 + Math.round(rand() * 90);
        const periods = Array.from({ length: 8 }, (_, p) =>
          p === 0 ? size : Math.round(size * 0.62 ** p * (0.8 + rand() * 0.4)),
        );
        return { cohort, size, periods };
      });

  const geography = zero
    ? []
    : [
        geoRow('US', 4120, 3510, 640),
        geoRow('GB', 1802, 1544, 260),
        geoRow('DE', 1140, 991, 171),
        geoRow('IN', 902, 812, 108),
        geoRow('IR', 611, 540, 94),
        geoRow('BR', 412, 388, 51),
        geoRow(null, 88, 80, 4),
      ];

  const devices = zero
    ? []
    : [
        device('desktop', 'macOS', 'Chrome', 3120),
        device('desktop', 'Windows', 'Chrome', 2410),
        device('mobile', 'iOS', 'Safari', 1902),
        device('mobile', 'Android', 'Chrome', 1104),
        device('desktop', 'macOS', 'Safari', 611),
        device('tablet', 'iPadOS', 'Safari', 240),
        device('desktop', 'Linux', 'Firefox', 118),
      ];

  const clock = (offset: number) =>
    zero
      ? []
      : Array.from({ length: 7 }, (_, dayOfWeek) =>
          Array.from({ length: 24 }, (_, hour) => ({
            dayOfWeek,
            hour,
            n: Math.round(
              Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI) ** 3) * (30 + offset) +
                (dayOfWeek === 0 || dayOfWeek === 6 ? 4 : 12) * rand(),
            ),
            activeMs: 0,
          })),
        ).flat();

  return {
    window: win,
    reports: {
      overview: {
        overview: {
          window: win,
          sessions: totalSessions,
          completed,
          completionRate: ratio(completed, totalSessions),
          learners: zero ? 0 : 418,
          totalUsd: costTotals.totalUsd,
          revenueUsd: costTotals.revenueUsd,
          savedUsd: costTotals.savedUsd,
          freshEquivalentUsd: costTotals.freshEquivalentUsd,
          costPerSessionUsd: ratio(costTotals.totalUsd, totalSessions),
          reuseRate: ratio(costTotals.savedUsd, costTotals.freshEquivalentUsd),
          packHitRate: zero ? 0 : 0.61,
          durationMs: totalSessions * 640_000,
          avgDurationMs: zero ? 0 : 640_000,
          avgProgress: zero ? 0 : 0.81,
          errors: zero ? 0 : 92,
          timeToFirstAudioP50Ms: zero ? null : 1180,
          timeToFirstAudioP95Ms: zero ? null : 3420,
          visits,
          visitors: Math.round(visits * 0.86),
          activeMs,
          visitToSession: ratio(sessionsStarted, visits),
        },
        reuse: reuseTotals(win, totalSessions, costTotals, reuseByKind, zero),
        abandonment: {
          window: win,
          reasons,
          bySegment: dropCurve(zero, totalSessions),
          lastSeen: lastSeen(zero),
        },
      },
      cost: {
        window: win,
        bucket: 'day',
        series: zero ? [] : costSeries,
        totals: costTotals,
        byPlan: zero
          ? []
          : [
              { plan: 'free', sessions: 811, totalUsd: 21.4, costPerSessionUsd: 0.0264 },
              { plan: 'standard', sessions: 402, totalUsd: 14.1, costPerSessionUsd: 0.0351 },
              { plan: 'professional', sessions: 71, totalUsd: 4.2, costPerSessionUsd: 0.0592 },
            ],
        byVoiceEngine: zero
          ? []
          : [
              {
                engine: 'cartesia',
                sessions: 1_100,
                totalUsd: 31.2,
                ttsUsd: 9.4,
                costPerSessionUsd: 0.0284,
                ttsFirstChunkP50Ms: 172,
              },
              {
                engine: 'fish',
                sessions: 184,
                totalUsd: 8.5,
                ttsUsd: 2.1,
                costPerSessionUsd: 0.0462,
                ttsFirstChunkP50Ms: 690,
              },
            ],
        byExpert: zero
          ? []
          : [
              { expertId: 'ada', sessions: 402, totalUsd: 12.1 },
              { expertId: 'feynman', sessions: 318, totalUsd: 9.8 },
              { expertId: 'curie', sessions: 244, totalUsd: 7.4 },
              { expertId: 'turing', sessions: 190, totalUsd: 6.1 },
              { expertId: 'hypatia', sessions: 130, totalUsd: 4.3 },
            ],
        stages,
      },
      stages: { window: win, stages, errors: errorCodes(zero) },
      abandonment: {
        window: win,
        reasons,
        bySegment: dropCurve(zero, totalSessions),
        lastSeen: lastSeen(zero),
      },
      retention: { window: win, bucket: 'day', metric: 'session', cohorts },
      sessions: { window: win, total: zero ? 0 : 1284, sessions: sessionRows },
      users: { window: win, total: zero ? 0 : 418, users: userRows },
      people: {
        window: win,
        summary: zero
          ? {
              accounts: 0,
              newAccounts: 0,
              anonymous: 0,
              freeAccounts: 0,
              paying: 0,
              byPlan: { standard: 0, professional: 0 },
              byInterval: { month: 0, year: 0 },
              cancelling: 0,
              visitors: 0,
              returning: 0,
              active: { day: 0, week: 0, month: 0 },
              learners: 0,
              sessions: 0,
              avgActiveMsPerVisitor: 0,
              avgSessionMs: 0,
              totalUsd: 0,
              costPerLearnerUsd: 0,
              costPerPayingUsd: 0,
              revenueUsd: 0,
              subscribed: 0,
              churned: 0,
            }
          : {
              accounts: 418,
              newAccounts: 61,
              anonymous: 3902,
              freeAccounts: 371,
              paying: 47,
              byPlan: { standard: 39, professional: 8 },
              byInterval: { month: 35, year: 12 },
              cancelling: 2,
              visitors: 4320,
              returning: 812,
              active: { day: 96, week: 540, month: 1610 },
              learners: 640,
              sessions: totalSessions,
              avgActiveMsPerVisitor: 6 * 60_000 + 12_000,
              avgSessionMs: 9 * 60_000,
              totalUsd: 184.2,
              costPerLearnerUsd: 0.29,
              costPerPayingUsd: 3.92,
              revenueUsd: 1_411,
              subscribed: 19,
              churned: 4,
            },
        top: { byCost: userRows, bySessions: userRows, byTime: userRows },
      },
      surveys: {
        window: win,
        surveys: [
          {
            kind: 'signup_source',
            question: 'How did you hear about Pen Playground?',
            answered: zero ? 0 : 31,
            skipped: zero ? 0 : 9,
            options: [
              { id: 'search', label: 'Search engine', count: zero ? 0 : 12 },
              { id: 'social', label: 'Social media', count: zero ? 0 : 6 },
              { id: 'youtube', label: 'YouTube', count: zero ? 0 : 5 },
              { id: 'friend', label: 'A friend or colleague', count: zero ? 0 : 4 },
              { id: 'school_or_work', label: 'School or work', count: zero ? 0 : 2 },
              { id: 'podcast_or_newsletter', label: 'A podcast or newsletter', count: 0 },
              { id: 'article', label: 'An article or blog', count: zero ? 0 : 1 },
              { id: 'ad', label: 'An advertisement', count: 0 },
              { id: 'other', label: 'Other', count: zero ? 0 : 1 },
            ],
            others: zero
              ? []
              : [{ text: 'A conference talk', at: to - 3 * DAY, trigger: 'checkout' }],
          },
          {
            kind: 'cancel_reason',
            question: 'What made you decide to leave?',
            answered: zero ? 0 : 4,
            skipped: zero ? 0 : 2,
            options: [
              { id: 'too_expensive', label: 'It costs too much', count: zero ? 0 : 2 },
              { id: 'not_using', label: 'I am not using it enough', count: zero ? 0 : 1 },
              { id: 'missing_features', label: 'It is missing something I need', count: 0 },
              { id: 'quality', label: 'The lessons were not what I hoped for', count: 0 },
              { id: 'technical_problems', label: 'Technical problems', count: 0 },
              { id: 'alternative', label: 'I found something else', count: 0 },
              { id: 'temporary_need', label: 'I only needed it for a while', count: zero ? 0 : 1 },
              { id: 'other', label: 'Other', count: 0 },
            ],
            others: [],
          },
        ],
      },
      reuse: {
        ...reuseTotals(win, totalSessions, costTotals, reuseByKind, zero),
        mostReused: zero
          ? []
          : [
              {
                sessionId: 's_photosynthesis',
                topic: 'how photosynthesis works',
                reusedBy: 115,
                uses: 402,
                savedForOthersUsd: 8.4,
              },
              {
                sessionId: 's_bayes',
                topic: 'bayes theorem explained',
                reusedBy: 64,
                uses: 210,
                savedForOthersUsd: 5.1,
              },
              {
                sessionId: 's_tcp',
                topic: 'what happens in a tcp handshake',
                reusedBy: 41,
                uses: 118,
                savedForOthersUsd: 3.2,
              },
            ],
      },
      visits: {
        window: win,
        bucket: 'day',
        series: zero ? [] : visitSeries,
        totals: {
          visits,
          visitors: Math.round(visits * 0.86),
          activeMs,
          medianActiveMs: zero ? 0 : 74_000,
          bounceRate: zero ? 0 : 0.42,
          sessionsStarted,
          conversion: ratio(sessionsStarted, visits),
        },
        byScreen: zero
          ? []
          : [
              { screen: '/', views: 6120, visits: 4110, activeMs: 210_000_000 },
              { screen: '/sessions/:id', views: 3410, visits: 2104, activeMs: 402_000_000 },
              { screen: '/room/:id', views: 1290, visits: 1180, activeMs: 810_000_000 },
              { screen: '/experts', views: 902, visits: 740, activeMs: 40_000_000 },
              { screen: '/pricing', views: 611, visits: 540, activeMs: 22_000_000 },
              { screen: '/legal/privacy', views: 84, visits: 80, activeMs: 3_000_000 },
            ],
        byReferrer: zero
          ? []
          : [
              { referrerHost: null, campaignSource: null, visits: 3120, sessionsStarted: 610 },
              {
                referrerHost: 'news.ycombinator.com',
                campaignSource: null,
                visits: 1410,
                sessionsStarted: 402,
              },
              {
                referrerHost: 'google.com',
                campaignSource: null,
                visits: 1104,
                sessionsStarted: 188,
              },
              {
                referrerHost: 'x.com',
                campaignSource: 'launch',
                visits: 611,
                sessionsStarted: 140,
              },
              {
                referrerHost: 'reddit.com',
                campaignSource: null,
                visits: 240,
                sessionsStarted: 41,
              },
            ],
        activeTime: {
          heartbeatMs: 15_000,
          idleMs: 60_000,
          definition:
            'Engaged time: the page was visible and the visitor did something in the last minute, or a lesson was playing.',
        },
      },
      geography: {
        window: win,
        rows: geography,
        note: 'Country is inferred from the browser timezone (no geo-IP is configured). Region and city are unavailable, and no location is derived from the visitor’s address.',
      },
      devices: { window: win, rows: devices },
      clock: {
        window: win,
        sessionsUtc: clock(0).map(({ activeMs: _drop, ...rest }) => rest),
        visitsLocal: clock(40),
      },
      plans: {
        window: win,
        bucket: 'day',
        mix: zero
          ? []
          : [
              { plan: 'free', interval: null, status: null, participants: 3120, active: 811 },
              {
                plan: 'standard',
                interval: 'month',
                status: 'active',
                participants: 214,
                active: 188,
              },
              {
                plan: 'standard',
                interval: 'year',
                status: 'active',
                participants: 88,
                active: 74,
              },
              {
                plan: 'professional',
                interval: 'month',
                status: 'active',
                participants: 31,
                active: 28,
              },
              {
                plan: 'professional',
                interval: 'year',
                status: 'active',
                participants: 12,
                active: 11,
              },
              {
                plan: 'standard',
                interval: 'month',
                status: 'past_due',
                participants: 4,
                active: 1,
              },
            ],
        changes: zero
          ? []
          : days
              .filter((_, i) => i % 3 === 0)
              .map((at, i) => ({
                at,
                upgrades: 2 + (i % 4),
                cancellations: i % 3,
                monthly: 2 + (i % 3),
                yearly: i % 2,
                amountCents: 1900 * (2 + (i % 4)),
              })),
      },
    },
  };
}

/** The one detail payload the console opens: `/sessions/:id`. */
export function sessionDetailFixture(id: string, now: number): unknown {
  return {
    session: { ...sessionRow(0, now - 4_600_000, seeded(7)), sessionId: id },
    downloads: 12,
    exports: 3,
    stages: [
      {
        stage: 'resolve',
        samples: 1,
        ok: 1,
        failed: 0,
        reused: 1,
        totalMs: 4,
        p50Ms: 4,
        p95Ms: 4,
        maxMs: 4,
        usd: 0,
        savedUsd: 0,
        firstAtMs: 120,
        lastAtMs: 124,
      },
      {
        stage: 'context',
        samples: 4,
        ok: 4,
        failed: 0,
        reused: 4,
        totalMs: 14,
        p50Ms: 3,
        p95Ms: 6,
        maxMs: 6,
        usd: 0,
        savedUsd: 0,
        firstAtMs: 210,
        lastAtMs: 402_000,
      },
      {
        stage: 'llm',
        samples: 7,
        ok: 7,
        failed: 0,
        reused: 4,
        totalMs: 9120,
        p50Ms: 610,
        p95Ms: 1840,
        maxMs: 2100,
        usd: 0.0182,
        savedUsd: 0.0241,
        firstAtMs: 240,
        lastAtMs: 610_000,
      },
      {
        stage: 'tts',
        samples: 61,
        ok: 60,
        failed: 1,
        reused: 48,
        totalMs: 18_400,
        p50Ms: 210,
        p95Ms: 640,
        maxMs: 1100,
        usd: 0.0094,
        savedUsd: 0.0318,
        firstAtMs: 900,
        lastAtMs: 640_000,
      },
      {
        stage: 'image',
        samples: 1,
        ok: 1,
        failed: 0,
        reused: 0,
        totalMs: 4200,
        p50Ms: 4200,
        p95Ms: 4200,
        maxMs: 4200,
        usd: 0.0041,
        savedUsd: 0,
        firstAtMs: 1200,
        lastAtMs: 5400,
      },
    ],
    errors: [{ code: 'TTS_TIMEOUT', stage: 'tts', n: 1, firstAtMs: 402_000, lastAtMs: 402_000 }],
    tookFrom: [
      { kind: 'pack', sourceSessionId: null, uses: 1, savedUsd: 0.004 },
      { kind: 'voice', sourceSessionId: 's_bayes', uses: 48, savedUsd: 0.0318 },
      { kind: 'lesson', sourceSessionId: 's_bayes', uses: 4, savedUsd: 0.0241 },
    ],
    gaveTo: {
      reusedBy: 115,
      uses: 402,
      savedForOthersUsd: 8.42,
      byKind: [
        { kind: 'voice', uses: 281, savedUsd: 5.1 },
        { kind: 'lesson', uses: 84, savedUsd: 2.4 },
        { kind: 'picture', uses: 37, savedUsd: 0.92 },
      ],
      searches: [
        { topic: 'how photosynthesis works', uses: 41, lastAt: now - 3_600_000 },
        { topic: 'photosynthesis for kids', uses: 28, lastAt: now - 9_000_000 },
        { topic: 'why are leaves green', uses: 19, lastAt: now - 18_000_000 },
        { topic: 'chlorophyll explained', uses: 14, lastAt: now - 40_000_000 },
        { topic: 'calvin cycle step by step', uses: 8, lastAt: now - 90_000_000 },
        { topic: 'light dependent reactions', uses: 5, lastAt: now - 140_000_000 },
      ],
    },
  };
}

// ── small builders ───────────────────────────────────────────────────────────

const round = (v: number): number => Math.round(v * 10_000) / 10_000;
const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);

function stage(
  name: string,
  sessions: number,
  samples: number,
  failed: number,
  reused: number,
  usd: number,
  savedUsd: number,
  p50Ms: number,
  p95Ms: number,
  maxMs: number,
) {
  return { stage: name, sessions, samples, failed, reused, usd, savedUsd, p50Ms, p95Ms, maxMs };
}

function reason(name: string, sessions: number, progress: number, ms: number, segment: number) {
  return {
    reason: name,
    sessions,
    avgProgress: progress,
    avgDurationMs: ms,
    avgSegmentReached: segment,
  };
}

function dropCurve(zero: boolean, totalSessions: number) {
  if (zero) return [];
  const shares = [0.06, 0.09, 0.14, 0.11, 0.08, 0.05, 0.03, 0.02];
  return shares.map((s, segment) => ({
    segment,
    sessions: Math.round(totalSessions * 0.29 * s * 3),
  }));
}

function lastSeen(zero: boolean) {
  if (zero) return [];
  return [
    { lastInteraction: 'segment_started', lastStage: 'tts', sessions: 112 },
    { lastInteraction: 'question_asked', lastStage: 'llm', sessions: 64 },
    { lastInteraction: 'paused', lastStage: 'tts', sessions: 41 },
    { lastInteraction: 'ad_shown', lastStage: 'ad', sessions: 18 },
    { lastInteraction: '(none)', lastStage: '(none)', sessions: 9 },
  ];
}

function errorCodes(zero: boolean) {
  if (zero) return [];
  return [
    { code: 'TTS_TIMEOUT', stage: 'tts', n: 44, sessions: 38 },
    { code: 'MODEL_RATE_LIMIT', stage: 'llm', n: 21, sessions: 19 },
    { code: 'IMAGE_REFUSED', stage: 'image', n: 9, sessions: 9 },
    { code: 'STT_NO_SPEECH', stage: 'stt', n: 12, sessions: 11 },
    { code: 'SOURCE_FETCH_FAILED', stage: 'prepare', n: 2, sessions: 2 },
    { code: 'ONTEN_MISS', stage: 'context', n: 3, sessions: 3 },
  ];
}

function reuseTotals(
  win: { from: number; to: number },
  sessions: number,
  totals: { savedUsd: number; totalUsd: number; freshEquivalentUsd: number },
  byKind: Array<{ kind: string; links: number; uses: number; savedUsd: number }>,
  zero: boolean,
) {
  return {
    window: win,
    sessions,
    packHits: zero ? 0 : 1102,
    pictureReuses: zero ? 0 : 902,
    cardReuses: zero ? 0 : 410,
    memoSegmentsReused: zero ? 0 : 5210,
    memoSegmentsGenerated: zero ? 0 : 1840,
    ttsSentencesReused: zero ? 0 : 19_204,
    ttsSentencesGenerated: zero ? 0 : 4914,
    contextSpeculationHits: zero ? 0 : 4901,
    savedUsd: totals.savedUsd,
    totalUsd: totals.totalUsd,
    freshEquivalentUsd: totals.freshEquivalentUsd,
    savedShare: ratio(totals.savedUsd, totals.freshEquivalentUsd),
    byKind,
  };
}

const TOPICS = [
  ['how photosynthesis works', 'Photosynthesis, from photon to sugar'],
  ['bayes theorem explained', 'Bayes’ theorem, one jar of marbles at a time'],
  ['what happens in a tcp handshake', 'The TCP handshake, packet by packet'],
  ['why is the sky blue', 'Rayleigh scattering and the colour of air'],
  ['how do vaccines work', 'Vaccines: teaching an immune system'],
  ['what is a fourier transform', 'The Fourier transform, drawn as circles'],
  ['how does a transformer model work', 'Attention, keys and values'],
  ['what caused the 2008 crash', 'Mortgages, tranches and the 2008 crash'],
  ['how do batteries store energy', 'Lithium ions, moving both ways'],
  ['what is the pythagorean theorem', 'Pythagoras, cut into squares'],
  ['how does gps know where i am', 'GPS: four clocks and a sphere'],
  ['why does bread rise', 'Yeast, gluten and carbon dioxide'],
] as const;

const REASONS = [
  'completed',
  'completed',
  'left_mid_segment',
  'completed',
  'never_started',
  'completed',
  'idle_timeout',
  'completed',
  'left_after_error',
  'completed',
  'length_ceiling',
  'left_during_ad',
] as const;

function sessionRow(i: number, startedAt: number, rand: () => number) {
  const [topic, title] = TOPICS[i % TOPICS.length] ?? ['', ''];
  const leaveReason = REASONS[i % REASONS.length] ?? 'unknown';
  const completed = leaveReason === 'completed';
  const planned = 8;
  const reached = completed ? 8 : Math.max(0, Math.round(rand() * 6));
  return {
    sessionId: `s_${String(i).padStart(2, '0')}_${topic.split(' ')[0]}`,
    topic,
    title,
    hostId: `p_${String(i % 5).padStart(3, '0')}`,
    plan: ['free', 'standard', 'professional'][i % 3] ?? 'free',
    expertId: ['ada', 'feynman', 'curie', 'turing'][i % 4] ?? 'ada',
    language: 'en-US',
    band: ['beginner', 'intermediate', 'advanced'][i % 3] ?? 'beginner',
    domain: 'science',
    canonicalId: `en.${topic.split(' ').slice(0, 2).join('-')}`,
    startedAt,
    endedAt: startedAt + 640_000,
    durationMs: completed ? 742_000 : 180_000 + Math.round(rand() * 300_000),
    segmentsPlanned: planned,
    segmentsReached: reached,
    progress: reached / planned,
    completed,
    leaveReason,
    lastStage: completed ? 'tts' : 'llm',
    lastInteraction: completed ? 'recap_shown' : 'segment_started',
    adPlayingAtEnd: leaveReason === 'left_during_ad',
    lastErrorCode: leaveReason === 'left_after_error' ? 'MODEL_RATE_LIMIT' : null,
    questions: Math.round(rand() * 6),
    interrupts: Math.round(rand() * 2),
    participants: 1,
    errors: leaveReason === 'left_after_error' ? 1 : 0,
    totalUsd: round(0.021 + rand() * 0.03),
    revenueUsd: round(rand() * 0.2),
    savedUsd: round(0.02 + rand() * 0.05),
    freshEquivalentUsd: round(0.08 + rand() * 0.06),
    packHit: i % 3 !== 0,
    timeToFirstAudioMs: leaveReason === 'never_started' ? null : 900 + Math.round(rand() * 2400),
    turnP50Ms: 1200 + Math.round(rand() * 900),
    views: Math.round(rand() * 400),
    replays: Math.round(rand() * 40),
    shares: Math.round(rand() * 12),
    reusedBy: Math.round(rand() * 115),
  };
}

const NAMES = [
  'Ada Okafor',
  'Sam Rivera',
  'Mei Tanaka',
  'Jonas Bergström',
  'Priya Nair',
  'Tom Lasky',
  'Noor Haddad',
  'Guest 4f21',
  'Guest 91ac',
  'Elena Costa',
] as const;

function userRow(i: number, now: number, rand: () => number) {
  const anonymous = i >= 7;
  const sessions = Math.max(1, Math.round(rand() * 40));
  return {
    id: `p_${String(i).padStart(3, '0')}`,
    name: NAMES[i] ?? `Guest ${i}`,
    plan: anonymous ? 'free' : (['free', 'standard', 'professional'][i % 3] ?? 'free'),
    planInterval: anonymous || i % 3 === 0 ? null : i % 2 === 0 ? 'month' : 'year',
    anonymous,
    analyticsOptOut: i === 6,
    createdAt: now - (30 - i) * DAY,
    lastSeenAt: now - i * 3_600_000,
    sessions,
    completed: Math.round(sessions * 0.7),
    totalUsd: round(sessions * 0.028),
    sessionMs: sessions * 640_000,
    visits: sessions * 3,
    activeMs: sessions * 210_000,
    country: ['US', 'GB', 'DE', 'IN', 'IR'][i % 5] ?? null,
    deviceType: ['desktop', 'mobile', 'tablet'][i % 3] ?? 'desktop',
  };
}

function geoRow(country: string | null, visits: number, visitors: number, sessions: number) {
  return {
    country,
    // Region and city stay null: no edge in front of this deployment computes
    // them, and the page has to be able to say so honestly.
    region: null,
    city: null,
    source: country === null ? 'none' : 'timezone',
    visits,
    visitors,
    activeMs: visits * 94_000,
    sessions,
  };
}

function device(deviceType: string, os: string, browser: string, visits: number) {
  return {
    deviceType,
    os,
    browser,
    visits,
    visitors: Math.round(visits * 0.88),
    activeMs: visits * 91_000,
    sessions: Math.round(visits * 0.18),
  };
}
