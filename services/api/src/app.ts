import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNodeWebSocket } from '@hono/node-ws';
import {
  ClientMessage,
  decodeAudioFrame,
  hasEntitlement,
  ParticipantId,
  type ServerErrorCode,
  type ServerMessage,
  SessionId,
  sttUsd,
} from '@pen/contracts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { WSContext } from 'hono/ws';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { ExportRefused, exportFilename } from './export/index.js';
import { GoogleTokenError } from './google.js';
import type { Claims } from './identity.js';
import { Identity, safeName } from './identity.js';
import { logger } from './logger.js';
import { observer } from './observability.js';
import { clientKey, RateLimiter } from './rate-limit.js';
import { ReadinessProbe } from './readiness.js';
import { RecognizerRouter } from './recognizer-router.js';
import { type LiveRoom, RoomRegistry } from './rooms.js';
import {
  learningResourceJsonLd,
  robotsTxt,
  SITEMAP_MAX_SESSIONS,
  SITEMAP_TTL_MS,
  sitemapXml,
} from './seo.js';
import { DATA_DIR, type Services } from './services.js';
import { aggregateReuse, computeTelemetry } from './telemetry.js';
import { THUMB_CONTENT_TYPE, THUMB_SIZES, type ThumbnailKind } from './thumbnails.js';

export interface App {
  app: Hono;
  rooms: RoomRegistry;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
}

const CreateSession = z.object({
  topic: z.string().trim().min(2).max(200),
  band: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  expertId: z.string().optional(),
  visibility: z.enum(['public', 'private']).default('public'),
  /** BCP-47; detected from the topic when omitted. */
  language: z.string().min(2).max(12).optional(),
});

const Anonymous = z.object({ name: z.string().max(60).optional() });
const GoogleBody = z.object({ idToken: z.string().min(16).max(4096) });
const Rename = z.object({ name: z.string().trim().min(1).max(60) });
const DevGoogleBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().optional(),
});

/** The participant as the client sees it; `anonymous` decides whether the account chip offers sign-in or sign-out. */
function participantView(row: {
  id: string;
  name: string;
  plan: Claims['plan'];
  anonymous: boolean;
  email?: string | null;
  avatarUrl?: string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    anonymous: row.anonymous,
    email: row.email ?? null,
    avatarUrl: row.avatarUrl ?? null,
  };
}

/** Strip the creator from a session record for anyone but the host. */
function anonymise<T extends { hostId: string; hostName: string }>(record: T): T {
  return { ...record, hostId: '', hostName: '' };
}

export function buildApp(services: Services): App {
  const app = new Hono();
  const identity = new Identity(services.cfg.PEN_JWT_SECRET);
  const rooms = new RoomRegistry(services);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const sessionLimiter = new RateLimiter(20, 60_000);
  const authLimiter = new RateLimiter(30, 60_000);
  const allowSession = (key: string) => sessionLimiter.allow(key);
  const allowAuth = (key: string) => authLimiter.allow(key);
  const readiness = new ReadinessProbe({ db: services.db, cfg: services.cfg });

  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    cors({
      origin: [services.cfg.PEN_PUBLIC_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: false,
    }),
  );

  /** Verify the token, then take the plan from the participant row so billing changes apply at once. */
  const bearer = async (header: string | undefined): Promise<Claims | null> => {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? await identity.verify(token) : null;
    if (!claims) return null;
    const row = await services.participants.get(claims.sub);
    return row
      ? {
          ...claims,
          name: row.name,
          plan: services.cfg.PEN_DEV_PLAN ?? row.plan,
          anonymous: row.anonymous,
        }
      : claims;
  };

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      tts: services.synthesizer.id,
      llm: services.cfg.PEN_LLM_PROVIDER,
      stt: services.cfg.PEN_STT_PROVIDER,
      acquirer: services.acquirer !== null,
      render: services.renderUnavailable === null,
      google: services.google !== null,
      rooms: services.livekit !== null,
      ads: services.ads.demand.source,
    }),
  );

  /**
   * Readiness for machines (compose healthcheck, the edge, the uptime monitor):
   * 200 only while the database, the data directory and the provider keys a
   * lesson needs are all usable, 503 otherwise, with which check failed.
   * `/api/health` stays 200 through a dependency outage on purpose — it is the
   * "what is this process and how is it configured" answer a human reads.
   */
  app.get('/api/ready', async (c) => {
    const result = await readiness.check();
    if (!result.ok) observer.event('ready.degraded', { ms: result.ms });
    return c.json(result, result.ok ? 200 : 503);
  });

  app.post('/api/auth/anonymous', async (c) => {
    const ip = clientKey(c.req);
    if (!allowAuth(ip)) return c.json({ error: 'RATE_LIMITED' }, 429);
    const body = Anonymous.safeParse(await c.req.json().catch(() => ({})));
    const name = safeName(body.success ? body.data.name : undefined);
    const plan = services.cfg.PEN_DEV_PLAN ?? 'free';
    const issued = await identity.issue({ name, plan, anonymous: true });
    const row = await services.participants.ensure({
      id: issued.claims.sub,
      name,
      plan,
      anonymous: true,
    });
    return c.json({
      token: issued.token,
      participant: participantView({ ...row, plan: issued.claims.plan }),
    });
  });

  /**
   * Google sign-in. The ID token comes from Google Identity Services in the
   * browser; the verifier checks it was minted for our client id. With a
   * bearer for an anonymous participant the same row is upgraded, so the
   * caller keeps its id, its sessions and (re-issued with the new claims)
   * its bearer. Without one, or for an account that already exists, the
   * account's own bearer is returned.
   */
  app.post('/api/identity/google', async (c) => {
    const ip = clientKey(c.req);
    if (!allowAuth(ip)) return c.json({ error: 'RATE_LIMITED' }, 429);
    if (!services.google)
      return c.json(
        { error: 'GOOGLE_DISABLED', message: 'Google sign-in is not available here.' },
        503,
      );
    const body = GoogleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const claims = await bearer(c.req.header('authorization'));
    const caller = claims ? await services.participants.get(claims.sub) : null;
    try {
      const result = await services.google.signIn(body.data.idToken, caller);
      const plan = services.cfg.PEN_DEV_PLAN ?? result.participant.plan;
      const issued = await identity.issue({
        sub: result.participant.id,
        name: result.participant.name,
        plan,
        anonymous: false,
      });
      observer.event('identity.google', {
        outcome: result.outcome,
        adoptedSessions: result.adoptedSessions,
        adoptedSaved: result.adoptedLists.saved,
        adoptedLiked: result.adoptedLists.liked,
        adoptedHistory: result.adoptedLists.history,
      });
      services.analytics.capture(result.participant.id, 'signed_in', {
        provider: 'google',
        outcome: result.outcome,
      });
      return c.json({
        token: issued.token,
        participant: participantView({ ...result.participant, plan }),
        outcome: result.outcome,
      });
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        observer.event('identity.google_rejected', { reason: error.reason });
        return c.json(
          {
            error: 'INVALID_TOKEN',
            reason: error.reason,
            message:
              error.reason === 'expired'
                ? 'That sign-in expired. Please try again.'
                : 'Google did not accept that sign-in. Please try again.',
          },
          401,
        );
      }
      observer.error('identity.google', error);
      return c.json({ error: 'SIGN_IN_FAILED', message: 'Could not sign you in.' }, 502);
    }
  });

  app.get('/api/me', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const row = await services.participants.get(claims.sub);
    return c.json({
      participant: participantView(
        row
          ? { ...row, plan: claims.plan }
          : { id: claims.sub, name: claims.name, plan: claims.plan, anonymous: claims.anonymous },
      ),
    });
  });

  /** Rename in place: the id, sessions and bearer are untouched. */
  app.patch('/api/me', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const body = Rename.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const row = await services.participants.rename(claims.sub, safeName(body.data.name));
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json({ participant: participantView({ ...row, plan: claims.plan }) });
  });

  // ── the participant's lists (ADR-0015) ───────────────────────────────────
  /** Membership ids + the counts beside the sidebar rows, in one read. */
  app.get('/api/me/lists', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json(await services.lists.summary(claims.sub));
  });
  /** Every session this participant sat in (host or guest), most recent seat first. */
  app.get('/api/me/history', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const history = await services.lists.historyFor(claims.sub);
    return c.json({
      sessions: history.map((h) => ({
        ...(h.session.hostId === claims.sub ? h.session : anonymise(h.session)),
        visit: { role: h.role, at: h.at },
      })),
    });
  });
  app.get('/api/me/saved', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const saved = await services.lists.savedFor(claims.sub);
    return c.json({ sessions: saved.map((r) => (r.hostId === claims.sub ? r : anonymise(r))) });
  });
  app.get('/api/me/liked', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const liked = await services.lists.likedFor(claims.sub);
    return c.json({ sessions: liked.map((r) => (r.hostId === claims.sub ? r : anonymise(r))) });
  });
  /** Hosted sessions whose MP4 is rendered and on disk (the Downloads screen). */
  app.get('/api/me/downloads', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const hosted = await services.sessions.listForHost(claims.sub);
    const downloads = hosted.flatMap((record) => {
      if (record.endedAt === null) return [];
      const job = services.exports.status(record.id);
      return job && job.status === 'ready'
        ? [{ ...record, export: { bytes: job.bytes, renderedAt: job.finishedAt } }]
        : [];
    });
    return c.json({ sessions: downloads });
  });

  app.get('/api/experts', (c) => c.json({ experts: services.experts.all() }));
  app.get('/api/experts/:id', (c) => {
    const e = services.experts.get(c.req.param('id'));
    return e ? c.json({ expert: e }) : c.json({ error: 'NOT_FOUND' }, 404);
  });
  app.get('/experts/portraits/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9-]+-w(96|192|384)\.webp$/.test(file)) return c.notFound();
    const p = join(DATA_DIR, 'experts', 'portraits', file);
    if (!existsSync(p)) return c.notFound();
    c.header('Content-Type', 'image/webp');
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(Readable.toWeb(createReadStream(p)) as ReadableStream);
  });

  /** Public catalog: like any public video, without who started it. */
  app.get('/api/sessions', async (c) =>
    c.json({ sessions: (await services.sessions.listPublic()).map(anonymise) }),
  );
  app.get('/api/sessions/mine', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json({ sessions: await services.sessions.listForHost(claims.sub) });
  });
  app.post('/api/sessions', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    if (!allowSession(claims.sub)) return c.json({ error: 'RATE_LIMITED' }, 429);
    const body = CreateSession.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const today = await services.sessions.countToday(claims.sub);
    if (claims.plan === 'free' && today >= 3)
      return c.json(
        {
          error: 'ENTITLEMENT_REQUIRED',
          message: 'Free plan: 3 sessions a day. Standard is unlimited.',
        },
        402,
      );
    const live = await rooms.create({
      topic: body.data.topic,
      host: { id: claims.sub, name: claims.name, plan: claims.plan },
      band: body.data.band,
      visibility: body.data.visibility,
      ...(body.data.expertId ? { expertId: body.data.expertId } : {}),
      ...(body.data.language ? { language: body.data.language } : {}),
    });
    return c.json({ session: live.record, state: live.room.getState() }, 201);
  });
  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const claims = await bearer(c.req.header('authorization'));
    const live = rooms.get(id);
    return c.json({
      session: claims?.sub === record.hostId ? record : anonymise(record),
      live: live !== null,
      state: live?.room.getState() ?? null,
      expert: services.experts.get(record.expertId),
    });
  });
  /**
   * Save ("Learn later") and like, as idempotent PUT/DELETE pairs on the session.
   * Any bearer may use them — an anonymous participant's lists are device-bound
   * until a Google sign-in adopts them. Likes move the public counter.
   */
  const listTarget = async (c: {
    req: { header(name: string): string | undefined; param(name: string): string };
  }): Promise<
    | { ok: true; claims: Claims; id: string }
    | { ok: false; status: 401 | 404; body: { error: string } }
  > => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } };
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success || !(await services.sessions.get(id)))
      return { ok: false, status: 404, body: { error: 'NOT_FOUND' } };
    return { ok: true, claims, id };
  };
  app.put('/api/sessions/:id/save', async (c) => {
    const t = await listTarget(c);
    if (!t.ok) return c.json(t.body, t.status);
    await services.lists.save(t.claims.sub, t.id);
    services.analytics.capture(t.claims.sub, 'session_saved', { sessionId: t.id });
    return c.json({ saved: true });
  });
  app.delete('/api/sessions/:id/save', async (c) => {
    const t = await listTarget(c);
    if (!t.ok) return c.json(t.body, t.status);
    await services.lists.unsave(t.claims.sub, t.id);
    return c.json({ saved: false });
  });
  app.put('/api/sessions/:id/like', async (c) => {
    const t = await listTarget(c);
    if (!t.ok) return c.json(t.body, t.status);
    const { likes } = await services.lists.like(t.claims.sub, t.id);
    services.analytics.capture(t.claims.sub, 'session_liked', { sessionId: t.id });
    return c.json({ liked: true, likes });
  });
  app.delete('/api/sessions/:id/like', async (c) => {
    const t = await listTarget(c);
    if (!t.ok) return c.json(t.body, t.status);
    const { likes } = await services.lists.unlike(t.claims.sub, t.id);
    return c.json({ liked: false, likes });
  });
  app.get('/api/sessions/:id/ledger', async (c) => {
    const id = c.req.param('id');
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    await services.sessions.recordView(id);
    const claims = await bearer(c.req.header('authorization'));
    const host = claims?.sub === record.hostId;
    return c.json({
      session: host ? record : anonymise(record),
      entries: services.ledger
        .read(id)
        .map((e) => (!host && e.kind === 'join' ? { ...e, name: 'Learner' } : e)),
      expert: services.experts.get(record.expertId),
    });
  });
  app.get('/api/sessions/:id/audio/:file', (c) => {
    const p = services.ledger.audioPath(c.req.param('id'), c.req.param('file'));
    if (!p) return c.notFound();
    c.header('Content-Type', 'application/octet-stream');
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(Readable.toWeb(createReadStream(p)) as ReadableStream);
  });
  /**
   * The session's telemetry (ADR-0011): stage timings, costs, interactions,
   * errors and what was reused, computed from its ledger. Host only — it
   * carries the host's plan and spend.
   */
  app.get('/api/sessions/:id/telemetry', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.hostId !== claims.sub) return c.json({ error: 'NOT_HOST' }, 403);
    const live = rooms.get(id);
    return c.json(
      computeTelemetry({
        sessionId: id,
        plan: live?.plan ?? claims.plan,
        expertId: record.expertId,
        language: live?.room.getState().language ?? 'und',
        entries: services.ledger.read(id),
      }),
    );
  });

  /**
   * Same-intent reuse across every session on this node's disk: how often an
   * existing pack and memo served a topic instead of fresh generation, and what
   * that saved. Any signed-in bearer for now (like /api/admin/costs).
   */
  app.get('/api/stats/reuse', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const topic = c.req.query('topic') ?? null;
    const sessions = services.ledger
      .list()
      .map((id) => computeTelemetry({ sessionId: id, entries: services.ledger.read(id) }))
      .filter((t) => topic === null || t.canonicalId === topic);
    return c.json(aggregateReuse(sessions));
  });

  /**
   * Development only: attach a made-up Google identity to the caller's
   * anonymous row (same in-place upgrade as the real flow, without Google), so
   * the signed-in shell can be exercised by e2e and screenshots without a
   * real account. Never mounted in production.
   */
  if (services.cfg.NODE_ENV !== 'production')
    app.post('/api/dev/me/google', async (c) => {
      const claims = await bearer(c.req.header('authorization'));
      if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
      const body = DevGoogleBody.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
      const name = safeName(body.data.name ?? claims.name);
      const row = await services.participants.linkGoogle(claims.sub, {
        googleSub: `dev:${claims.sub}`,
        email: body.data.email ?? `${claims.sub}@example.test`,
        name,
        avatarUrl: null,
      });
      if (!row) return c.json({ error: 'NOT_FOUND' }, 404);
      const issued = await identity.issue({
        sub: row.id,
        name,
        plan: claims.plan,
        anonymous: false,
      });
      return c.json({
        token: issued.token,
        participant: participantView({ ...row, plan: claims.plan }),
        outcome: 'linked',
      });
    });
  /**
   * Development only: raise one synthetic error inside a session so the
   * Sentry → ledger link can be verified end to end with real keys. The
   * event carries the session tags and its id lands in the ledger.
   */
  if (services.cfg.NODE_ENV !== 'production')
    app.post('/api/dev/sessions/:id/error', async (c) => {
      const claims = await bearer(c.req.header('authorization'));
      if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
      const live = rooms.get(c.req.param('id'));
      if (!live) return c.json({ error: 'NOT_FOUND' }, 404);
      if (live.record.hostId !== claims.sub) return c.json({ error: 'NOT_HOST' }, 403);
      const ref =
        observer.error('dev.test_error', new Error('PEN_TEST_ERROR: deliberate test error'), {
          sessionId: live.record.id,
          expertId: live.record.expertId,
          plan: live.plan,
          stage: 'turn',
        }) ?? null;
      live.metrics.error({ code: 'PEN_TEST_ERROR', stage: 'turn', ref });
      return c.json({ ok: true, ref });
    });

  // ── thumbnails (ADR-0013) ────────────────────────────────────────────────
  /**
   * The sketch and its rasters. Public sessions are public assets with a long
   * cache; a private session's thumbnail is only for its host, uncached by
   * proxies. A missing thumbnail is a 404 the client treats as "not ready".
   */
  const thumbnail = async (
    c: {
      req: { header(name: string): string | undefined; param(name: string): string };
      header(name: string, value: string): void;
      body(data: null | ReadableStream, status?: 200 | 304): Response;
      json(body: { error: string }, status: 401 | 403 | 404): Response;
    },
    kind: ThumbnailKind,
  ): Promise<Response> => {
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.visibility === 'private') {
      const claims = await bearer(c.req.header('authorization'));
      if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
      if (claims.sub !== record.hostId) return c.json({ error: 'NOT_HOST' }, 403);
    }
    const path = record.thumbnail ? await services.thumbnails.file(id, kind) : null;
    if (!path) return c.json({ error: 'NOT_READY' }, 404);
    const { size, etag } = services.thumbnails.stat(path);
    c.header('ETag', etag);
    c.header('Vary', 'Authorization');
    c.header(
      'Cache-Control',
      record.visibility === 'public'
        ? 'public, max-age=86400, stale-while-revalidate=604800'
        : 'private, max-age=3600',
    );
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    c.header('Content-Type', THUMB_CONTENT_TYPE[kind]);
    c.header('Content-Length', String(size));
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
  };
  app.get('/api/sessions/:id/thumb.svg', (c) => thumbnail(c, 'svg'));
  app.get('/api/sessions/:id/thumb.png', (c) => thumbnail(c, 'card'));
  app.get('/api/sessions/:id/og.png', (c) => thumbnail(c, 'og'));

  app.post('/api/sessions/:id/end', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const live = rooms.get(c.req.param('id'));
    if (!live) return c.json({ error: 'NOT_FOUND' }, 404);
    if (live.record.hostId !== claims.sub) return c.json({ error: 'NOT_HOST' }, 403);
    await rooms.end(live.record.id);
    return c.json({ ok: true, state: live.room.getState() });
  });

  // ── MP4 export (paid) ───────────────────────────────────────────────────
  /**
   * Host + `export` entitlement + ended session, or the matching error. The
   * plan comes from the participant row (`bearer`), so an upgrade applies at once.
   */
  const exportAccess = async (c: {
    req: { header(name: string): string | undefined; param(name: string): string };
  }): Promise<
    | {
        ok: true;
        claims: Claims;
        record: NonNullable<Awaited<ReturnType<typeof services.sessions.get>>>;
      }
    | { ok: false; status: 401 | 402 | 403 | 404 | 409; body: { error: string; message?: string } }
  > => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } };
    // Ids become directory names under the data dir: only well-formed ones get anywhere near the disk.
    if (!SessionId.safeParse(c.req.param('id')).success)
      return { ok: false, status: 404, body: { error: 'NOT_FOUND' } };
    const record = await services.sessions.get(c.req.param('id'));
    if (!record) return { ok: false, status: 404, body: { error: 'NOT_FOUND' } };
    if (record.hostId !== claims.sub)
      return {
        ok: false,
        status: 403,
        body: { error: 'NOT_HOST', message: 'Only the host can export a session.' },
      };
    if (!hasEntitlement(claims.plan, 'export'))
      return {
        ok: false,
        status: 402,
        body: {
          error: 'ENTITLEMENT_REQUIRED',
          message: 'Video export is part of the Standard plan.',
        },
      };
    const live = rooms.get(record.id);
    if (record.endedAt === null || (live && live.room.getState().phase !== 'ended'))
      return {
        ok: false,
        status: 409,
        body: { error: 'SESSION_LIVE', message: 'End the session before exporting it.' },
      };
    return { ok: true, claims, record };
  };
  /** What the client sees: never the file system path. */
  const exportView = async (
    job: ReturnType<typeof services.exports.status>,
    claims: Claims,
    sessionId: string,
  ) => {
    if (!job || job.status === 'stale')
      return {
        status: 'none' as const,
        progress: 0,
        error: null,
        downloadUrl: null,
        bytes: null,
        durationMs: null,
      };
    const downloadUrl =
      job.status === 'ready'
        ? `${services.cfg.PEN_API_URL}/api/sessions/${encodeURIComponent(sessionId)}/export.mp4?token=${encodeURIComponent(await services.downloadTokens.issue(claims.sub, sessionId))}`
        : null;
    return {
      status: job.status,
      progress: job.progress,
      error: job.status === 'failed' ? (job.error ?? 'The render failed.') : null,
      downloadUrl,
      bytes: job.bytes,
      durationMs: job.durationMs,
    };
  };
  app.post('/api/sessions/:id/export', async (c) => {
    const access = await exportAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    if (services.renderUnavailable) {
      // A known boot condition (logged once at startup), not a new incident per click.
      observer.event('export.unavailable', { sessionId: access.record.id });
      return c.json(
        { error: 'RENDER_UNAVAILABLE', message: 'Video export is temporarily unavailable.' },
        503,
      );
    }
    let job: ReturnType<typeof services.exports.request>;
    try {
      job = services.exports.request(access.record.id);
    } catch (error) {
      if (!(error instanceof ExportRefused)) throw error;
      const status = error.code === 'QUEUE_FULL' ? 503 : error.code === 'TOO_LONG' ? 413 : 409;
      return c.json({ error: `EXPORT_${error.code}`, message: error.message }, status);
    }
    services.analytics.capture(access.claims.sub, 'export_requested', { status: job.status });
    return c.json(
      await exportView(job, access.claims, access.record.id),
      job.status === 'ready' ? 200 : 202,
    );
  });
  app.get('/api/sessions/:id/export', async (c) => {
    const access = await exportAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    return c.json(
      await exportView(services.exports.status(access.record.id), access.claims, access.record.id),
    );
  });
  /** The file itself: a bearer works, and so does the short-lived `token` the status endpoint hands out for `<a download>`. */
  app.get('/api/sessions/:id/export.mp4', async (c) => {
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const token = c.req.query('token');
    let participantId: string | null = token
      ? await services.downloadTokens.verify(token, id)
      : null;
    if (!participantId) {
      const claims = await bearer(c.req.header('authorization'));
      if (claims && hasEntitlement(claims.plan, 'export')) participantId = claims.sub;
    }
    if (!participantId) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.hostId !== participantId) return c.json({ error: 'NOT_HOST' }, 403);
    const job = services.exports.status(id);
    if (job?.status !== 'ready' || !job.output || !existsSync(job.output))
      return c.json({ error: 'NOT_READY', message: 'The video is not ready yet.' }, 404);
    const st = statSync(job.output);
    const size = st.size;
    // A resumed download after a re-render must never splice two files.
    const etag = `"${Math.round(st.mtimeMs)}-${size}"`;
    c.header('ETag', etag);
    c.header('Content-Type', 'video/mp4');
    c.header('Content-Disposition', `attachment; filename="${exportFilename(record.title)}"`);
    c.header('Cache-Control', 'private, no-store');
    c.header('Accept-Ranges', 'bytes');
    const ifRange = c.req.header('if-range');
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2]) && (!ifRange || ifRange === etag)) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        c.header('Content-Range', `bytes */${size}`);
        return c.body(null, 416);
      }
      c.header('Content-Range', `bytes ${start}-${end}/${size}`);
      c.header('Content-Length', String(end - start + 1));
      return c.body(
        Readable.toWeb(createReadStream(job.output, { start, end })) as ReadableStream,
        206,
      );
    }
    c.header('Content-Length', String(size));
    return c.body(Readable.toWeb(createReadStream(job.output)) as ReadableStream);
  });

  /** Share page metadata: crawlers get OG tags, humans get redirected to the app. */
  app.get('/s/:id', async (c) => {
    const record = await services.sessions.get(c.req.param('id'));
    if (!record) return c.notFound();
    const expert = services.experts.get(record.expertId);
    const target = `${services.cfg.PEN_PUBLIC_URL}/sessions/${record.id}`;
    const esc = (s: string) =>
      s.replace(
        /[&<>"]/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
      );
    const description =
      record.description ||
      record.promise ||
      `A session with ${expert?.displayName ?? 'an AI expert'} on Pen Playground`;
    // Scrapers rarely rasterise SVG, so Open Graph gets the 1200 × 630 PNG; only public sessions
    // can be fetched without a bearer, so only they advertise an image.
    const image =
      record.thumbnail && record.visibility === 'public'
        ? `${services.cfg.PEN_API_URL}/api/sessions/${encodeURIComponent(record.id)}/og.png`
        : null;
    const imageTags = image
      ? `<meta property="og:image" content="${esc(image)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="${THUMB_SIZES.og.width}"><meta property="og:image:height" content="${THUMB_SIZES.og.height}"><meta property="og:image:alt" content="${esc(`Whiteboard sketch: ${record.title}`)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(image)}"><meta name="twitter:image:alt" content="${esc(`Whiteboard sketch: ${record.title}`)}">`
      : '<meta name="twitter:card" content="summary">';
    // Structured data only for a page a crawler can actually read: a private session is
    // host-only, so advertising it as a learning resource would be a lie.
    const jsonLd =
      record.visibility === 'public'
        ? `<script type="application/ld+json">${learningResourceJsonLd({
            record,
            expertName: expert?.displayName ?? null,
            url: target,
            siteUrl: services.cfg.PEN_PUBLIC_URL,
            imageUrl: image,
            description,
          })}</script>`
        : '';
    c.header('Cache-Control', record.visibility === 'public' ? 'public, max-age=3600' : 'private');
    return c.html(`<!doctype html><html lang="${esc(record.language)}"><head><meta charset="utf-8"><title>${esc(record.title)} · Pen Playground</title>
<meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(target)}"><meta property="og:title" content="${esc(record.title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="video.other"><meta property="og:site_name" content="Pen Playground"><meta property="og:locale" content="${esc(record.language.replace('-', '_'))}"><meta property="og:url" content="${esc(target)}">${imageTags}
<meta name="twitter:title" content="${esc(record.title)}"><meta name="twitter:description" content="${esc(description)}">${jsonLd}
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head><body><a href="${esc(target)}">Open the session</a></body></html>`);
  });

  // ── crawlers: robots, sitemap ────────────────────────────────────────────
  /**
   * The sitemap is the public catalogue plus the pages that always exist. It
   * is the same for everyone, so it is built at most once an hour in the
   * process and cached for an hour at the edge.
   */
  let sitemap: { xml: string; at: number } | null = null;
  app.get('/sitemap.xml', async (c) => {
    const now = Date.now();
    if (!sitemap || now - sitemap.at > SITEMAP_TTL_MS) {
      const sessions = await services.sessions.listPublic(SITEMAP_MAX_SESSIONS);
      sitemap = {
        xml: sitemapXml({ publicUrl: services.cfg.PEN_PUBLIC_URL, sessions, now }),
        at: now,
      };
      observer.event('seo.sitemap_built', { sessions: sessions.length, bytes: sitemap.xml.length });
    }
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(sitemap.xml);
  });
  /**
   * The web container serves its own `robots.txt` (a static file next to the
   * app). This one is what a crawler gets when it reaches the API directly,
   * and it is generated from the same public URL the sitemap uses.
   */
  app.get('/robots.txt', (c) => {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(robotsTxt(services.cfg.PEN_PUBLIC_URL));
  });

  // ── rooms: human-to-human audio (LiveKit) ────────────────────────────────
  /**
   * A signed-in member of a live session, or the matching error. Membership is
   * the room's own participant list, so a token can only be minted after the
   * WebSocket join succeeded (which is where plan and capacity are enforced).
   */
  const roomAudioAccess = async (c: {
    req: { header(name: string): string | undefined; param(name: string): string };
  }): Promise<
    | {
        ok: true;
        claims: Claims;
        live: LiveRoom;
        member: { id: string; name: string; role: string };
      }
    | { ok: false; status: 401 | 403 | 404 | 503; body: { error: string; message?: string } }
  > => {
    if (!services.livekit)
      return {
        ok: false,
        status: 503,
        body: {
          error: 'ROOMS_UNAVAILABLE',
          message: 'Voice between participants is not available here.',
        },
      };
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } };
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success)
      return { ok: false, status: 404, body: { error: 'NOT_FOUND' } };
    const live = rooms.get(id);
    const state = live?.room.getState();
    if (!live || !state || state.phase === 'ended')
      return {
        ok: false,
        status: 404,
        body: { error: 'SESSION_NOT_LIVE', message: 'This session is not live.' },
      };
    const member = state.participants.find((p) => p.id === claims.sub);
    if (!member)
      return {
        ok: false,
        status: 403,
        body: { error: 'NOT_MEMBER', message: 'Join the session first.' },
      };
    return { ok: true, claims, live, member };
  };
  /** The plan comes from the host's participant row so a billing change applies at once (same rule as `bearer`). */
  const hostPlanOf = async (live: LiveRoom) =>
    services.cfg.PEN_DEV_PLAN ??
    (await services.participants.get(live.record.hostId))?.plan ??
    'free';
  app.post('/api/rooms/:id/token', async (c) => {
    const access = await roomAudioAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    const livekit = services.livekit;
    if (!livekit) return c.json({ error: 'ROOMS_UNAVAILABLE' }, 503);
    if (!hasEntitlement(await hostPlanOf(access.live), 'rooms'))
      return c.json(
        {
          error: 'ENTITLEMENT_REQUIRED',
          message: 'Rooms with voice between participants need the Professional plan.',
        },
        402,
      );
    const roomAdmin = access.member.role === 'host';
    const canPublish = access.member.role !== 'viewer';
    const token = await livekit.token({
      room: access.live.record.id,
      identity: access.member.id,
      name: access.member.name,
      canPublish,
      roomAdmin,
    });
    observer.event('rooms.audio.token', { sessionId: access.live.record.id, roomAdmin });
    return c.json({ url: livekit.url, token, canPublish, roomAdmin });
  });
  const MuteBody = z.object({
    /** A guest to mute; absent = everyone but the host. */
    participantId: ParticipantId.optional(),
  });
  app.post('/api/rooms/:id/mute', async (c) => {
    const access = await roomAudioAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    const livekit = services.livekit;
    if (!livekit) return c.json({ error: 'ROOMS_UNAVAILABLE' }, 503);
    if (access.member.role !== 'host')
      return c.json({ error: 'NOT_HOST', message: 'Only the host can mute.' }, 403);
    const body = MuteBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const sessionId = access.live.record.id;
    const state = access.live.room.getState();
    const target = body.data.participantId;
    if (target !== undefined && !state.participants.some((p) => p.id === target))
      return c.json({ error: 'NOT_MEMBER', message: 'That person is not in the room.' }, 404);
    try {
      const muted =
        target === undefined
          ? await livekit.muteAll(sessionId, [state.hostId])
          : (await livekit.muteParticipant(sessionId, target)) > 0
            ? [target]
            : [];
      observer.event('rooms.audio.mute', {
        sessionId,
        all: target === undefined,
        count: muted.length,
      });
      return c.json({ muted });
    } catch (error) {
      observer.error('rooms.audio.mute', error, { sessionId, all: target === undefined });
      return c.json({ error: 'ROOMS_FAILED', message: 'Could not reach the voice server.' }, 502);
    }
  });

  // ── billing ──────────────────────────────────────────────────────────────
  const CheckoutBody = z.object({
    plan: z.enum(['standard', 'professional']),
    interval: z.enum(['month', 'year']).default('month'),
  });
  app.get('/api/billing/status', (c) => c.json({ enabled: services.billing.enabled }));
  app.post('/api/billing/checkout', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    if (!services.billing.enabled)
      return c.json({ error: 'BILLING_DISABLED', message: 'Checkout is not available yet.' }, 503);
    const body = CheckoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID' }, 400);
    try {
      const url = await services.billing.checkout(claims.sub, body.data.plan, body.data.interval);
      return c.json({ url });
    } catch (error) {
      observer.error('billing.checkout', error);
      return c.json({ error: 'BILLING_FAILED', message: 'Could not start checkout.' }, 502);
    }
  });
  app.post('/api/billing/portal', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    try {
      return c.json({ url: await services.billing.portal(claims.sub) });
    } catch (error) {
      observer.error('billing.portal', error);
      return c.json({ error: 'BILLING_FAILED', message: 'No billing account yet.' }, 404);
    }
  });
  app.post('/api/billing/webhook', async (c) => {
    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'MISSING_SIGNATURE' }, 400);
    try {
      const result = await services.billing.webhook(await c.req.text(), signature);
      return c.json(result);
    } catch (error) {
      observer.error('billing.webhook', error);
      return c.json({ error: 'WEBHOOK_REJECTED' }, 400);
    }
  });

  app.get('/api/admin/costs', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json({ costs: services.costs.snapshot() });
  });

  // ── room socket ──────────────────────────────────────────────────────────
  app.get(
    '/ws/room',
    upgradeWebSocket(() => {
      let claims: Claims | null = null;
      let sessionId: string | null = null;
      let authTimer: NodeJS.Timeout | null = null;
      // Messages are processed strictly in order per socket (auth before join, join before control).
      let chain: Promise<void> = Promise.resolve();
      /** Server-side STT for this participant; created on their first utterance. */
      let stt: RecognizerRouter | null = null;
      let sttUnavailableSent = false;

      const fail = (ws: { send(data: string): void }, code: ServerErrorCode, message: string) =>
        ws.send(
          JSON.stringify({ kind: 'error', code, message, spoken: false } satisfies ServerMessage),
        );

      const recognizerFor = (
        ws: WSContext<WebSocket>,
        live: LiveRoom,
        participantId: string,
      ): RecognizerRouter | null => {
        const factory = services.recognizer;
        if (!factory) return null;
        stt ??= new RecognizerRouter({
          factory,
          language: () => live.room.getState().language,
          onTranscript: (utteranceId, text, final) =>
            live.room.handle(participantId, {
              kind: 'transcript',
              utteranceId,
              text: text.slice(0, 4000),
              final,
            }),
          onError: (code, error, ctx) => {
            const ref = observer.error('stt.session', error, {
              code,
              provider: factory.id,
              participantId,
              utteranceId: ctx.utteranceId,
              sessionId: live.record.id,
              expertId: live.record.expertId,
              plan: live.plan,
              stage: 'stt',
            });
            live.metrics.error({ code, stage: 'stt', ref: ref ?? null });
            fail(ws, 'STT_UNAVAILABLE', "We couldn't hear that clearly. Please say it again.");
          },
          onUtteranceDone: (info) => {
            // Endpoint → final is the STT share of the turn; the audio seconds are what the provider bills.
            if (info.finalMs !== null)
              live.metrics.sample({
                stage: 'stt',
                ms: info.finalMs,
                ok: true,
                meta: { provider: factory.id, audioMs: info.audioMs, chars: info.chars },
              });
            const seconds = info.audioMs / 1000;
            live.metrics.cost({
              component: 'stt',
              unit: 'seconds',
              units: seconds,
              usd: sttUsd(factory.id, seconds),
              meta: { provider: factory.id },
            });
          },
          onEvent: (name, data) => observer.event(name, { ...data, participantId }),
        });
        return stt;
      };

      async function handle(evt: MessageEvent, ws: WSContext<WebSocket>): Promise<void> {
        const raw = ws.raw;
        if (!raw) return;
        try {
          if (typeof evt.data !== 'string') {
            // Upstream audio: routed to server-side STT when configured. Browser STT sends text instead.
            if (!claims || !sessionId) return;
            const bytes =
              evt.data instanceof ArrayBuffer
                ? new Uint8Array(evt.data)
                : evt.data instanceof Blob
                  ? new Uint8Array(await evt.data.arrayBuffer())
                  : null;
            if (!bytes) return;
            const { header, pcm } = decodeAudioFrame(bytes);
            if (header.dir !== 'up') return;
            if (!services.recognizer) {
              // Once per socket: the client streams many frames per utterance.
              if (!sttUnavailableSent) {
                sttUnavailableSent = true;
                fail(
                  ws,
                  'STT_UNAVAILABLE',
                  'Speech recognition is not available here; questions can be typed.',
                );
              }
              return;
            }
            stt?.audio(header.utteranceId, pcm);
            return;
          }
          const parsed = ClientMessage.safeParse(JSON.parse(evt.data));
          if (!parsed.success) {
            fail(ws, 'INTERNAL', 'Malformed message.');
            return;
          }
          const msg = parsed.data;
          if (msg.kind === 'auth') {
            claims = await bearer(`Bearer ${msg.token}`);
            if (!claims) {
              fail(ws, 'UNAUTHORIZED', 'Sign in again.');
              ws.close(4001, 'unauthorized');
            } else if (authTimer) clearTimeout(authTimer);
            return;
          }
          if (!claims) {
            fail(ws, 'UNAUTHORIZED', 'Authenticate first.');
            return;
          }
          if (msg.kind === 'join') {
            const attached = rooms.attach(msg.sessionId, raw, {
              id: claims.sub,
              name: msg.name ? safeName(msg.name) : claims.name,
            });
            if (!attached.ok) {
              ws.send(JSON.stringify(attached.message));
              return;
            }
            sessionId = msg.sessionId;
            const ready: ServerMessage = {
              kind: 'ready',
              participantId: claims.sub,
              state: attached.live.room.getState(),
              backlog: attached.live.room.backlog(),
            };
            ws.send(JSON.stringify(ready));
            return;
          }
          if (!sessionId) return;
          const live = rooms.get(sessionId);
          if (!live) return;
          if (msg.kind === 'control' && msg.action === 'end') {
            live.room.handle(claims.sub, msg);
            await rooms.end(sessionId);
            return;
          }
          if (msg.kind === 'utterance_start' || msg.kind === 'utterance_end') {
            live.room.handle(claims.sub, msg);
            const router = recognizerFor(ws, live, claims.sub);
            if (msg.kind === 'utterance_start') router?.utteranceStart(msg.utteranceId);
            else router?.utteranceEnd(msg.utteranceId);
            return;
          }
          live.room.handle(claims.sub, msg);
        } catch (error) {
          observer.error('ws.message', error);
          fail(ws, 'INTERNAL', 'Something went wrong on our side.');
        }
      }

      return {
        onOpen(_evt, ws) {
          // The bearer must arrive in the first frame within 10 s (never in the URL).
          authTimer = setTimeout(() => {
            if (!claims) ws.close(4001, 'auth timeout');
          }, 10_000);
        },
        onMessage(evt, ws) {
          chain = chain
            .then(() => handle(evt, ws))
            .catch((error) => {
              observer.error('ws.chain', error);
            });
        },
        onClose(_evt, ws) {
          if (authTimer) clearTimeout(authTimer);
          stt?.close();
          stt = null;
          if (sessionId && ws.raw) rooms.detach(sessionId, ws.raw);
        },
        onError(evt) {
          logger.warn({ evt: 'ws.error', detail: String((evt as ErrorEvent).message ?? '') });
        },
      };
    }),
  );

  return { app, rooms, injectWebSocket };
}
