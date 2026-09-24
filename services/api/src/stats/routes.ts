import { VisitBeacon } from '@pen/contracts';
import type { Bucket, ReportWindow } from '@pen/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { adminToken, machineIsAdmin } from '../admin.js';
import type { Claims } from '../identity.js';
import { logger } from '../logger.js';
import { clientKey, RateLimiter } from '../rate-limit.js';
import type { Services } from '../services.js';
import { visitAddress } from './address.js';

/**
 * The reporting API (ADR-0027).
 *
 * Two kinds of route and they could not be more different. `POST /api/visits`
 * is the busiest thing this server serves — every engaged page, every fifteen
 * seconds — and answers in one upsert. Everything under `/api/admin/stats` is
 * the opposite: rare, admin-only, and each one a single SQL statement against
 * the derived tables. No route here opens a ledger.
 *
 * Every report takes `from`, `to` and `bucket`, defaulting to the last thirty
 * days by day, so a dashboard can call any of them with no parameters at all.
 */

const DEFAULT_WINDOW_MS = 30 * 86_400_000;
const MAX_WINDOW_MS = 400 * 86_400_000;

const BucketQuery = z.enum(['hour', 'day', 'week', 'month']).default('day');

/** `from`/`to` in ms epoch, clamped so one request can never scan an unbounded range. */
function windowOf(
  c: { req: { query(name: string): string | undefined } },
  now: number,
): ReportWindow {
  const num = (name: string): number | null => {
    const raw = c.req.query(name);
    if (raw === undefined) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
  };
  const to = num('to') ?? now;
  const from = num('from') ?? to - DEFAULT_WINDOW_MS;
  const clamped = Math.max(from, to - MAX_WINDOW_MS);
  return { from: Math.min(clamped, to), to };
}

/** An unrecognised bucket falls back to `day`: a hand-typed query string must not 500. */
function bucketOf(c: { req: { query(name: string): string | undefined } }): Bucket {
  const parsed = BucketQuery.safeParse(c.req.query('bucket') ?? undefined);
  return parsed.success ? parsed.data : 'day';
}

/**
 * Beacons one address may send a minute. A page sends four, and a person with
 * six tabs open sends twenty-four; this is far above anything the product
 * produces and only catches something that has stopped behaving like a
 * browser. Past it the beacon is dropped in silence, exactly as an opted-out
 * one is — an unauthenticated endpoint that writes rows needs a ceiling.
 */
const VISIT_BEACONS_PER_MINUTE = 120;

export interface StatsRouteDeps {
  services: Services;
  /** The same bearer check the rest of the API uses, so opt-out stays refreshed. */
  bearer: (header: string | undefined) => Promise<Claims | null>;
  /**
   * The operations console's own allow-list check (ADR-0026), passed in
   * rather than rebuilt: one set of people may see `/api/admin/*`, and
   * revoking someone must not have to be done twice.
   */
  isAdmin: (header: string | undefined) => Promise<boolean>;
  now?: () => number;
}

export function registerStatsRoutes(app: Hono, deps: StatsRouteDeps): void {
  const { services } = deps;
  const now = deps.now ?? Date.now;
  const machineToken = adminToken(services.cfg);
  const beaconLimiter = new RateLimiter(VISIT_BEACONS_PER_MINUTE, 60_000);
  // Said once at boot, so "why can nobody read the dashboard" is answerable
  // from the logs rather than from the code.
  if (!services.cfg.PEN_ADMIN_EMAILS && !machineToken)
    logger.warn(
      { evt: 'stats.admin_unconfigured' },
      'admin reports refuse everyone: set PEN_ADMIN_EMAILS (a person) or PEN_ADMIN_TOKEN (a machine)',
    );

  /**
   * Null when this request may read the reports, and the refusal otherwise.
   * A person qualifies through the console's own allow-list; a machine
   * through `PEN_ADMIN_TOKEN`. Nothing else does, in any environment.
   */
  const admin = async (c: {
    req: { header(name: string): string | undefined };
    json: (body: unknown, status?: 403) => Response;
  }): Promise<Response | null> => {
    const headers = {
      authorization: c.req.header('authorization'),
      adminToken: c.req.header('x-admin-token'),
    };
    if (machineIsAdmin(machineToken, headers)) return null;
    if (await deps.isAdmin(headers.authorization)) return null;
    return c.json({ error: 'FORBIDDEN', message: 'This is not your dashboard.' }, 403);
  };

  // ── the beacon ─────────────────────────────────────────────────────────────
  /**
   * One visit heartbeat. Answers 200 whatever happens: a page must never be
   * told that counting it failed, and `counted` says whether anything was
   * written — false for a participant who turned analytics off, and false
   * when `PEN_VISIT_STATS=0`.
   */
  app.post('/api/visits', async (c) => {
    if (!beaconLimiter.allow(clientKey(c.req))) return c.json({ counted: false }, 200);
    // Parsed as JSON whatever the header says: the last beacon of a visit is
    // sent by `navigator.sendBeacon` as `text/plain`, because that is the
    // only content type it can send without a preflight it cannot make.
    const body = VisitBeacon.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ counted: false }, 200);
    const claims = await deps.bearer(c.req.header('authorization'));
    const counted = await services.visits.record(body.data, {
      participantId: claims?.sub ?? null,
      signedIn: claims !== null && !claims.anonymous,
      plan: claims?.plan ?? 'free',
      userAgent: c.req.header('user-agent'),
      // The same `X-Real-IP`-then-`X-Forwarded-For` resolution the per-IP
      // session cap uses (`clientKey`), validated into an address or into
      // nothing — never a header value taken on trust (ADR-0028).
      ipAddress: visitAddress(c.req),
      header: (name) => c.req.header(name),
      now: now(),
    });
    return c.json({ counted });
  });

  // ── reports ────────────────────────────────────────────────────────────────
  app.get('/api/admin/stats/overview', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const [overview, reuse, abandonment] = await Promise.all([
      services.reports.overview(w),
      services.reports.reuseTotals(w),
      services.reports.abandonment(w),
    ]);
    return c.json({ overview, reuse, abandonment });
  });

  app.get('/api/admin/stats/cost', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const bucket = bucketOf(c);
    const [series, byPlan, byExpert, byVoiceEngine, stages] = await Promise.all([
      services.reports.costSeries(w, bucket),
      services.reports.costByPlan(w),
      services.reports.costByExpert(w),
      services.reports.costByVoiceEngine(w),
      services.reports.stageSummary(w),
    ]);
    const totals = series.reduce(
      (acc, p) => ({
        sessions: acc.sessions + p.sessions,
        totalUsd: acc.totalUsd + p.totalUsd,
        llmUsd: acc.llmUsd + p.llmUsd,
        intentUsd: acc.intentUsd + p.intentUsd,
        imageUsd: acc.imageUsd + p.imageUsd,
        ttsUsd: acc.ttsUsd + p.ttsUsd,
        sttUsd: acc.sttUsd + p.sttUsd,
        searchUsd: acc.searchUsd + p.searchUsd,
        revenueUsd: acc.revenueUsd + p.revenueUsd,
        freshEquivalentUsd: acc.freshEquivalentUsd + p.freshEquivalentUsd,
        savedUsd: acc.savedUsd + p.savedUsd,
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
    return c.json({ window: w, bucket, series, totals, byPlan, byExpert, byVoiceEngine, stages });
  });

  /** Per stage and per error code, across the window: the observability half of the ask. */
  app.get('/api/admin/stats/stages', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const [stages, errors] = await Promise.all([
      services.reports.stageSummary(w),
      services.reports.errorSummary(w),
    ]);
    return c.json({ window: w, stages, errors });
  });

  /** Why sessions stop: the reason, the segment they stopped at, and what happened last. */
  app.get('/api/admin/stats/abandonment', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    return c.json(await services.reports.abandonment(windowOf(c, now())));
  });

  app.get('/api/admin/stats/retention', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const bucket = bucketOf(c);
    const metric = c.req.query('metric') === 'visit' ? 'visit' : 'session';
    const [grid, sizes] = await Promise.all([
      services.reports.retention(w, bucket, metric),
      services.reports.cohortSizes(w, bucket),
    ]);
    // A grid the dashboard can render without arithmetic: one row per cohort.
    const byCohort = new Map<number, number[]>();
    let widest = 0;
    for (const row of grid) {
      const periods = byCohort.get(row.cohort) ?? [];
      periods[row.period] = row.learners;
      byCohort.set(row.cohort, periods);
      widest = Math.max(widest, row.period + 1);
    }
    const cohorts = sizes.map(({ cohort, size }) => ({
      cohort,
      size,
      periods: Array.from({ length: widest }, (_, i) => byCohort.get(cohort)?.[i] ?? 0),
    }));
    return c.json({ window: w, bucket, metric, cohorts });
  });

  app.get('/api/admin/stats/sessions', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const completed = c.req.query('completed');
    const { rows, total } = await services.reports.sessions({
      window: w,
      ...(c.req.query('plan') ? { plan: c.req.query('plan') } : {}),
      ...(c.req.query('leaveReason') ? { leaveReason: c.req.query('leaveReason') } : {}),
      ...(c.req.query('voiceEngine') ? { voiceEngine: c.req.query('voiceEngine') } : {}),
      ...(c.req.query('hostId') ? { hostId: c.req.query('hostId') } : {}),
      ...(c.req.query('expertId') ? { expertId: c.req.query('expertId') } : {}),
      ...(completed !== undefined ? { completed: completed === 'true' } : {}),
      ...(c.req.query('orderBy') ? { orderBy: c.req.query('orderBy') } : {}),
      ...(c.req.query('direction') === 'asc' ? { direction: 'asc' as const } : {}),
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    });
    return c.json({ window: w, total, sessions: rows });
  });

  app.get('/api/admin/stats/sessions/:id', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const detail = await services.reports.session(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'NOT_FOUND' }, 404);
  });

  app.get('/api/admin/stats/users', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const { rows, total } = await services.reports.users({
      window: w,
      ...(c.req.query('orderBy') ? { orderBy: c.req.query('orderBy') } : {}),
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    });
    return c.json({ window: w, total, users: rows });
  });

  /** One person: their sessions, their spend, their visits. */
  app.get('/api/admin/stats/users/:id', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const id = c.req.param('id');
    const w = windowOf(c, now());
    const participant = await services.participants.get(id);
    if (!participant) return c.json({ error: 'NOT_FOUND' }, 404);
    const { rows } = await services.reports.sessions({
      window: w,
      hostId: id,
      limit: 200,
    });
    return c.json({
      participant: {
        id: participant.id,
        name: participant.name,
        plan: participant.plan,
        planInterval: participant.planInterval,
        planStatus: participant.planStatus,
        anonymous: participant.anonymous,
        email: participant.email,
        analyticsOptOut: participant.analyticsOptOut,
        createdAt: participant.createdAt,
        lastSeenAt: participant.lastSeenAt,
      },
      window: w,
      sessions: rows,
    });
  });

  /** Reuse totals, the sessions others lean on, and what those learners searched for. */
  app.get('/api/admin/stats/reuse', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const [totals, top] = await Promise.all([
      services.reports.reuseTotals(w),
      services.reports.mostReusedSessions(w),
    ]);
    return c.json({ ...totals, mostReused: top });
  });

  /** "This session has been reused fourteen times, for these searches." */
  app.get('/api/admin/stats/reuse/:id', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const id = c.req.param('id');
    const record = await services.sessions.get(id);
    const reuse = await services.reports.sessionReuse(id);
    return c.json({
      sessionId: id,
      topic: record?.topic ?? '',
      canonicalId: record?.canonicalId ?? null,
      ...reuse,
    });
  });

  app.get('/api/admin/stats/visits', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const bucket = bucketOf(c);
    const [series, totals, byScreen, byReferrer] = await Promise.all([
      services.reports.visitSeries(w, bucket),
      services.reports.visitTotals(w),
      services.reports.visitsByScreen(w),
      services.reports.visitsByReferrer(w),
    ]);
    return c.json({
      window: w,
      bucket,
      series,
      totals,
      byScreen,
      byReferrer,
      /** So a dashboard can print the definition beside the number. */
      activeTime: {
        heartbeatMs: 15_000,
        idleMs: 60_000,
        definition:
          'Engaged time: the page was visible and the visitor did something in the last minute, or a lesson was playing.',
      },
    });
  });

  app.get('/api/admin/stats/geography', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const rows = await services.reports.geography(w);
    return c.json({
      window: w,
      rows,
      /** Said out loud in the payload, so no dashboard can present a guess as a measurement. */
      note: services.cfg.PEN_TRUST_GEO_HEADERS
        ? 'Country, region and city come from the edge where it supplies them; otherwise the country is inferred from the browser timezone.'
        : 'Country is inferred from the browser timezone (no geo-IP is configured). Region and city are unavailable, and no location is derived from the visitor’s address.',
    });
  });

  app.get('/api/admin/stats/devices', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    return c.json({ window: w, rows: await services.reports.devices(w) });
  });

  app.get('/api/admin/stats/clock', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    return c.json(await services.reports.usageClock(windowOf(c, now())));
  });

  app.get('/api/admin/stats/plans', async (c) => {
    const refused = await admin(c);
    if (refused) return refused;
    const w = windowOf(c, now());
    const bucket = bucketOf(c);
    const [mix, changes] = await Promise.all([
      services.reports.planMix(w),
      services.reports.planChanges(w, bucket),
    ]);
    return c.json({ window: w, bucket, mix, changes });
  });
}
