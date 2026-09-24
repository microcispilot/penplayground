import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNodeWebSocket } from '@hono/node-ws';
import {
  BoardPreference,
  ClientMessage,
  CommentBody,
  clampPace,
  decodeAudioFrame,
  FeatureFlagsMutation,
  FeatureFlagsRollback,
  PACE_DEFAULT,
  Pace,
  ParticipantId,
  PLAN_LIMITS,
  PLAN_NAME,
  PLATFORM_HEADER,
  PlanCode,
  type Platform,
  planAllowsExpert,
  platformFromHeader,
  RuntimeConfigMutation,
  RuntimeConfigRollback,
  recordingIsPrivateTo,
  requiredPlanFor,
  type ServerErrorCode,
  type ServerMessage,
  SessionId,
  sessionsRemaining,
  sttUsd,
  utcDayStart,
} from '@pen/contracts';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { WSContext } from 'hono/ws';
import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { Admissions } from './admissions.js';
import { createChallengeStore } from './auth/challenges.js';
import { createAuthRateLimiter } from './auth/rate-limit.js';
import { registerAuthRoutes } from './auth/routes.js';
import { ExportRefused, type ExportVariant, exportFilename } from './export/index.js';
import { FeatureFlagsConflict, FeatureFlagsInvalid } from './features/index.js';
import { GoogleTokenError } from './google.js';
import type { Claims } from './identity.js';
import { Identity, safeName } from './identity.js';
import { logger } from './logger.js';
import { observer } from './observability.js';
import { clientKey, RateLimiter } from './rate-limit.js';
import { ReadinessProbe } from './readiness.js';
import { RecognizerRouter } from './recognizer-router.js';
import { type LiveRoom, PreparationRefused, RoomRegistry } from './rooms.js';
import { RuntimeConfigConflict, RuntimeConfigInvalid } from './runtime-config/index.js';
import {
  learningResourceJsonLd,
  robotsTxt,
  SITEMAP_MAX_SESSIONS,
  SITEMAP_TTL_MS,
  sitemapXml,
} from './seo.js';
import { DATA_DIR, type Services } from './services.js';
import { registerStatsRoutes } from './stats/routes.js';
import { aggregateReuse, computeTelemetry } from './telemetry.js';
import { THUMB_CONTENT_TYPE, THUMB_FILES, THUMB_SIZES, type ThumbnailKind } from './thumbnails.js';
import { publicUrl } from './urls.js';

export interface App {
  app: Hono;
  rooms: RoomRegistry;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
}

const CreateSession = z.union([
  z.object({
    topic: z.string().trim().min(2).max(200),
    band: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
    expertId: z.string().optional(),
    visibility: z.enum(['public', 'private']).default('public'),
    /** BCP-47; detected from the topic when omitted. */
    language: z.string().min(2).max(12).optional(),
  }),
  /**
   * Start a prepared lesson again (ADR-0035): the topic, the expert, the band
   * and the language are the saved session's, so the memo and the voice store
   * that lesson already filled are the ones this session reuses. The new
   * session is the caller's own — their questions, their recording.
   */
  z.object({
    replayOf: SessionId,
    visibility: z.enum(['public', 'private']).default('public'),
  }),
]);

const Anonymous = z.object({ name: z.string().max(60).optional() });
/** An ID token from Google's own button, or the popup code from ours (ADR-0042). */
const GoogleBody = z.union([
  z.object({ idToken: z.string().min(16).max(4096) }),
  z.object({ code: z.string().min(16).max(2048) }),
]);
const DevGoogleBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().optional(),
  /** Development only: sign in on a paid plan, so a gated screen can be exercised. */
  plan: PlanCode.optional(),
});

/** Everything a participant may change about themselves. Every field is optional; at least one must be present. */
const UpdateMe = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    /** Privacy choices: stop counting me, here and on the server (ADR-0018). */
    analyticsOptOut: z.boolean().optional(),
    /**
     * How fast this learner likes to be taught (ADR-0010). Set from the
     * session's own settings; it holds for their next session the way a
     * playback speed holds for the next video.
     */
    pace: Pace.optional(),
    /** The expert who starts every search for this account (ADR-0040); null clears it. */
    defaultExpertId: z.string().min(1).max(80).nullable().optional(),
    /**
     * The board this learner chose (ADR-0034). Validated here rather than
     * taken as free-form JSON: this column is read back into the UI, and an
     * unvalidated object would let one account write a shape every later read
     * has to defend against.
     */
    board: BoardPreference.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.analyticsOptOut !== undefined ||
      v.pace !== undefined ||
      v.board !== undefined,
    { message: 'nothing to change' },
  );

/** The participant as the client sees it; `anonymous` decides whether the account chip offers sign-in or sign-out. */
function participantView(row: {
  id: string;
  name: string;
  plan: Claims['plan'];
  anonymous: boolean;
  email?: string | null;
  avatarUrl?: string | null;
  pace?: number | null;
  board?: unknown;
  defaultExpertId?: string | null;
}) {
  // Parsed, never trusted: a row written by a newer build naming a board this
  // one has never heard of degrades to the default rather than failing the
  // whole `/api/me` response, which is a sign-in that does not complete.
  const board = BoardPreference.safeParse(row.board);
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    anonymous: row.anonymous,
    email: row.email ?? null,
    avatarUrl: row.avatarUrl ?? null,
    pace: clampPace(row.pace ?? PACE_DEFAULT),
    board: board.success ? board.data : null,
    defaultExpertId: row.defaultExpertId ?? null,
  };
}

/** Strip the creator from a session record for anyone but the host. */
function anonymise<T extends { hostId: string; hostName: string }>(record: T): T {
  return { ...record, hostId: '', hostName: '' };
}

/**
 * Per-socket message budgets. A room is chatty by design — board reports, live
 * transcripts, ad steps — so these are set well above what the product
 * produces and only catch a client that has stopped behaving like one.
 */
/**
 * Every message family a socket can send, and how many of them a minute.
 *
 * Exported so `ws-limits.test.ts` can assert that the table covers the whole
 * of `ClientMessage`: a family with no entry here is not rate limited at
 * all, and the ones that were missing — `auth`, `join`, `progress`,
 * `utterance_start`/`end`, and the binary audio branch — each reach a JWT
 * verification, a database read, the TTS lookahead or a paid recogniser.
 */
export const WS_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  report: { limit: 240, windowMs: 60_000 },
  ad_event: { limit: 60, windowMs: 60_000 },
  /** Interim transcripts stream while someone speaks. */
  transcript: { limit: 900, windowMs: 60_000 },
  /** A question or a check-in answer: one per turn, and a turn takes seconds. */
  question: { limit: 30, windowMs: 60_000 },
  control: { limit: 60, windowMs: 60_000 },
  set_pace: { limit: 60, windowMs: 60_000 },
  interrupt: { limit: 90, windowMs: 60_000 },
  /**
   * The room already drops anything faster than one per 600 ms, in silence
   * (`reactions.ts`). This is the flood behind that: a hundred a minute is the
   * most the product's own rule can produce, so reaching this is a client that
   * has stopped behaving like one.
   */
  reaction: { limit: 120, windowMs: 60_000 },
  /**
   * Chat between participants. The room already drops anything faster than
   * one per 400 ms in silence (`SessionRoom.chat`); this is the flood behind
   * that. It reaches no model and costs nothing, so the ceiling is about the
   * broadcast rather than about spend.
   */
  chat: { limit: 150, windowMs: 60_000 },
  /** A hand goes up or down a few times in a class, not a few times a second (ADR-0037). */
  hand: { limit: 60, windowMs: 60_000 },
  /** The host removing people: a handful in a class at most. */
  remove_participant: { limit: 30, windowMs: 60_000 },
  /**
   * The rest of the protocol, which had no bucket at all until every family
   * was checked against this table. Each of these reaches something that
   * costs: `auth` verifies a JWT, `join` reads the session row and builds a
   * seat, `progress` walks every lesson sentence between reports and moves
   * the TTS lookahead, and `utterance_start`/`end` open and close a
   * server-side recognition — which is a paid provider.
   *
   * The numbers are "far more than the product can produce, far less than a
   * loop": one authentication per socket becomes sixty, one join becomes
   * sixty, and progress is reported a few times a second at most.
   */
  auth: { limit: 60, windowMs: 60_000 },
  join: { limit: 60, windowMs: 60_000 },
  progress: { limit: 600, windowMs: 60_000 },
  utterance_start: { limit: 300, windowMs: 60_000 },
  utterance_end: { limit: 300, windowMs: 60_000 },
  resumed: { limit: 120, windowMs: 60_000 },
  /**
   * Upstream audio, which is not a `kind` at all — it is the binary branch,
   * and it was the one family that could reach a paid recogniser with no
   * ceiling whatever. 20 ms frames at 50 a second is 3,000 a minute; this is
   * four times that, so a client streaming normally never sees it and one
   * replaying a capture as fast as it can does.
   */
  audio: { limit: 12_000, windowMs: 60_000 },
};
/** Frames that fail Zod before the socket is closed. One is a bug; ten is a client to stop talking to. */
const MAX_BAD_FRAMES = 10;
/** Recognised speech one participant may send in a session. Hours of talking; a script hits it, a learner never does. */
const MAX_TRANSCRIPT_CHARS = 200_000;
/** Stripe events are bigger than anything the product posts, and are signed. */
const WEBHOOK_MAX_BYTES = 256 * 1024;

export function buildApp(services: Services): App {
  const app = new Hono();
  const identity = new Identity(services.cfg.PEN_JWT_SECRET);
  const rooms = new RoomRegistry(services);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const sessionLimiter = new RateLimiter(20, 60_000);
  /** Ten comments a minute per account (ADR-0044): a conversation, not a flood. */
  const commentLimiter = new RateLimiter(10, 60_000);
  const authLimiter = new RateLimiter(30, 60_000);
  const allowSession = (key: string) => sessionLimiter.allow(key);
  const allowAuth = (key: string) => authLimiter.allow(key);
  const readiness = new ReadinessProbe({
    db: services.db,
    cfg: services.cfg,
    providers: {
      PEN_LLM_PROVIDER: services.llmProvider,
      PEN_TTS_PROVIDER: services.config.get('PEN_TTS_PROVIDER'),
      PEN_STT_PROVIDER: services.config.get('PEN_STT_PROVIDER'),
    },
  });
  /** Live sessions hosted from each address, so one machine cannot open rooms without bound. */
  const liveByIp = new Map<string, Set<string>>();
  /**
   * Free sessions started from each address today (`PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY`).
   * In memory on purpose: it is a ceiling against a script, not a ledger, and a
   * restart forgiving it is the right failure. The map is swept when the day turns.
   */
  const freeStartsByIp = new Map<string, { day: number; count: number }>();
  const freeStartsToday = (ip: string): number => {
    const day = utcDayStart(Date.now());
    const row = freeStartsByIp.get(ip);
    if (!row || row.day !== day) return 0;
    return row.count;
  };
  const countFreeStart = (ip: string): void => {
    const day = utcDayStart(Date.now());
    const row = freeStartsByIp.get(ip);
    if (row && row.day === day) row.count += 1;
    else {
      // The day turned: everything older is forgotten in one pass.
      for (const [key, r] of freeStartsByIp) if (r.day !== day) freeStartsByIp.delete(key);
      freeStartsByIp.set(ip, { day, count: 1 });
    }
  };
  /**
   * Every way a start is turned away, as one event with a reason, so the
   * conversion that did not happen is on the same dashboard as the ones that
   * did. Content-free like everything else here.
   */
  const refusalNoted = new Map<string, number>();
  const REFUSAL_EVENT_INTERVAL_MS = 60_000;
  const refuseSession = (
    claims: Claims,
    reason: string,
    extra: Record<string, string | number | boolean | null> = {},
  ): void => {
    // One event per participant, per reason, per minute. A refusal is a
    // fact about a person, not about a request: a script hammering the route
    // is refused every time and recorded once, so analytics volume cannot be
    // made to grow with the hammering.
    const key = `${claims.sub}:${reason}`;
    const now = Date.now();
    const last = refusalNoted.get(key);
    if (last !== undefined && now - last < REFUSAL_EVENT_INTERVAL_MS) return;
    if (refusalNoted.size > 10_000)
      for (const [k, at] of refusalNoted)
        if (now - at >= REFUSAL_EVENT_INTERVAL_MS) refusalNoted.delete(k);
    refusalNoted.set(key, now);
    services.analytics.capture(claims.sub, 'session_refused', {
      reason,
      plan: claims.plan,
      ...extra,
    });
  };
  /** Sessions admitted but not yet built: see `admissions.ts` for why both ceilings need it. */
  const admissions = new Admissions();
  const dev = services.cfg.NODE_ENV !== 'production';

  app.use(
    '*',
    secureHeaders({
      // TLS terminates at the edge, so HSTS is added below only for requests
      // that actually arrived over it — announcing it on a plain-HTTP dev
      // origin would lock `localhost` to https in the developer's browser.
      strictTransportSecurity: false,
      // An API that hands out JSON, one share page and media has no reason to
      // leak the page a caller came from, even to itself.
      referrerPolicy: 'no-referrer',
      // The room needs the microphone on this origin and nothing else needs
      // anything: `microphone=(self)`, the rest denied outright.
      permissionsPolicy: {
        microphone: ['self'],
        camera: [],
        geolocation: [],
        payment: [],
        usb: [],
        displayCapture: [],
        browsingTopics: false,
      },
      xFrameOptions: 'DENY',
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    const https = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://');
    if (https) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  /**
   * Only the origins this deployment actually serves. In development the web
   * host moves ports between checkouts (`PEN_WEB_PORT`), so any loopback port
   * is allowed there and nowhere else. A request with no `Origin` (curl, the
   * desktop shell, a server-to-server call) is left alone: CORS is a browser
   * rule, and the bearer is what actually guards these routes.
   */
  const allowedOrigins = new Set(
    [services.cfg.PEN_PUBLIC_URL, services.cfg.PEN_API_URL].map((u) => new URL(u).origin),
  );
  const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  app.use(
    '/api/*',
    cors({
      origin: (origin) =>
        allowedOrigins.has(origin) || (dev && LOOPBACK.test(origin)) ? origin : null,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['authorization', 'content-type', PLATFORM_HEADER],
      credentials: false,
      maxAge: 600,
    }),
  );

  /**
   * Nothing this API accepts is large. The one exception is Stripe's signed
   * webhook, which carries whole event objects.
   */
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize:
        c.req.path === '/api/billing/webhook'
          ? WEBHOOK_MAX_BYTES
          : services.config.get('PEN_MAX_BODY_BYTES'),
      onError: (ctx) =>
        ctx.json({ error: 'TOO_LARGE', message: 'That request was too large.' }, 413),
    })(c, next),
  );

  /**
   * The last net. A route that throws used to become Hono's own plain-text
   * 500 and nothing else: no Sentry event, no log line with the path, and a
   * client reading JSON got a parse error instead of a code. Now it is one
   * captured error per throw, tagged with the route so the issue groups by
   * where, and a JSON answer the client already knows how to read.
   */
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const ref = observer.error('http.unhandled', error, {
      route: c.req.routePath,
      method: c.req.method,
    });
    return c.json(
      { error: 'INTERNAL', message: 'Something went wrong on our side.', ref: ref ?? null },
      500,
    );
  });

  /** Verify the token, then take the plan from the participant row so billing changes apply at once. */
  const bearer = async (header: string | undefined): Promise<Claims | null> => {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? await identity.verify(token) : null;
    if (!claims) return null;
    const row = await services.participants.get(claims.sub);
    // No row, no participant. A token outlives the account it names — 30 days —
    // so falling back to its own claims would let a deleted account keep
    // starting sessions on the plan baked into it. The client treats the 401
    // the way it treats any expired bearer: it mints a fresh anonymous one.
    if (!row) return null;
    // The row is the truth about this participant's analytics choice; reading it
    // here keeps the server-side sink honest without an extra query per capture.
    services.analytics.setOptOut(row.id, row.analyticsOptOut);
    return {
      ...claims,
      name: row.name,
      plan: services.cfg.PEN_DEV_PLAN ?? row.plan,
      anonymous: row.anonymous,
    };
  };

  /**
   * A record with how many guests took a seat in it (ADR-0035): what makes a
   * session a room, and a room is a recording rather than a lesson to replay.
   */
  type Guested<T> = T & { guests: number };
  const withGuests = async <T extends { id: string }>(records: T[]): Promise<Guested<T>[]> => {
    const counts = await services.sessions.guestCounts(records.map((r) => r.id));
    return records.map((r) => ({ ...r, guests: counts.get(r.id) ?? 0 }));
  };

  /**
   * Where the caller is: the platform header, or the web when there is none
   * (ADR-0036). A client that lies about its platform gets that platform's
   * flags, which is a choice about its own experience and nothing else —
   * every cell of the matrix is one the owner already offers to someone.
   */
  const platformOf = (c: { req: { header(name: string): string | undefined } }): Platform =>
    platformFromHeader(c.req.header(PLATFORM_HEADER));

  /**
   * What stands between this participant and a new session right now: their
   * plan's daily allowance, and the day's spend cap (ADR-0016). Both answers
   * are numbers the client can show plainly — "1 session left today" — rather
   * than a refusal it has to guess the reason for.
   */
  /**
   * How many topics may still be prepared for this caller (ADR-0040): none
   * without an account, the configured allowance on the free plan, no limit
   * when paying. `null` is unlimited.
   */
  const customSessionsFor = (claims: Claims): { allowance: number | null } => {
    // A visitor without an account is decided by the flag alone
    // (`prepare_new_topics` is off for them unless a test deployment says
    // otherwise); the counter is an account's.
    if (claims.anonymous) return { allowance: null };
    return {
      allowance:
        PLAN_LIMITS[claims.plan].customSessions === null
          ? null
          : services.config.get('PEN_FREE_CUSTOM_SESSIONS'),
    };
  };
  const usageFor = async (claims: Claims) => {
    const dayStart = utcDayStart(Date.now());
    const limits = PLAN_LIMITS[claims.plan];
    const sessionsToday = await services.sessions.countSince(claims.sub, dayStart);
    const remaining = sessionsRemaining(claims.plan, sessionsToday);
    const spend = services.spend.check(claims.plan);
    const reason = remaining === 0 ? 'daily_limit' : spend.ok ? null : 'capacity';
    const me = await services.participants.get(claims.sub);
    return {
      plan: claims.plan,
      sessionsToday,
      sessionsPerDay: limits.sessionsPerDay,
      remaining,
      maxSessionMinutes: limits.maxSessionMinutes,
      resetsAt: dayStart + 86_400_000,
      canStart: reason === null,
      reason,
      customSessionsUsed: me?.customSessions ?? 0,
      customSessions: customSessionsFor(claims).allowance,
    } as const;
  };
  /**
   * The routes that are a shelf — history, saves, likes, your sessions,
   * your recording — belong to an account (ADR-0040). A visitor without one
   * is told so in one calm sentence, with the way in; never a wall.
   */
  const accountRequired = (
    claims: Claims,
    feature: 'history' | 'lists',
    platform: Platform,
  ): Response | null => {
    if (
      services.features.enabled(feature, {
        plan: claims.plan,
        platform,
        anonymous: claims.anonymous,
      })
    )
      return null;
    return Response.json(
      {
        error: 'ACCOUNT_REQUIRED',
        message:
          feature === 'lists'
            ? 'Sign in to keep the lessons you like and save.'
            : 'Sign in to keep your sessions and your history.',
        upgrade: 'SignIn',
      },
      { status: 403 },
    );
  };

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      tts: services.synthesizer.id,
      llm: services.llmProvider,
      stt: services.recognizer?.id ?? 'browser',
      // What a room being built right now would actually classify with — not
      // what the setting asks for, which can be `jev` with no key behind it.
      intent: services.intentFor() ? 'jev' : 'model',
      grade: services.graderFor() ? 'jev' : 'model',
      configRevision: services.config.revision,
      featuresRevision: services.features.revision,
      acquirer: services.acquirer !== null,
      render: services.renderUnavailable === null,
      google: services.google !== null,
      /** The app's own Continue with Google needs the secret as well (ADR-0042). */
      googleCode: services.google?.exchangesCodes ?? false,
      rooms: services.livekit !== null,
      ads: services.ads.demand.source,
      ttsCache: services.ttsCache !== null,
      spendCap: services.spend.enabled,
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
    // The first thing known about a visitor: that they arrived, and on what.
    // Everything they do afterwards hangs off this id.
    services.analytics.capture(issued.claims.sub, 'participant_issued', {
      plan,
      platform: platformOf(c),
    });
    return c.json({
      token: issued.token,
      participant: participantView({ ...row, plan: issued.claims.plan }),
    });
  });

  /*
   * Email and password (ADR-pending; the flow is Simurgh's, see auth/routes.ts).
   *
   * Everything the routes need is passed in rather than reached for, so the
   * whole surface can be exercised against fakes — which matters more here
   * than anywhere else in this file, because the interesting cases are the
   * ones that must NOT be distinguishable from outside.
   */
  registerAuthRoutes(app, {
    enabled: async (c) => {
      const claims = await bearer(c.req.header('authorization'));
      return services.features.enabled('email_sign_in', {
        plan: claims?.plan ?? 'free',
        platform: platformOf(c),
      });
    },
    challenges: createChallengeStore(
      services.authChallenges,
      // A secret of its own where one is configured, so a leaked JWT secret
      // does not also make stored verification codes forgeable.
      services.cfg.PEN_AUTH_HMAC_SECRET ?? services.cfg.PEN_JWT_SECRET,
    ),
    mailer: services.mailer,
    limiter: createAuthRateLimiter(
      services.cfg.PEN_AUTH_HMAC_SECRET ?? services.cfg.PEN_JWT_SECRET,
    ),
    signInUrl: `${services.cfg.PEN_PUBLIC_URL.replace(/\/$/, '')}/`,
    clientIp: (c) => clientKey(c.req),
    findByEmail: (email) => services.participants.findByEmail(email),
    callerId: async (authorization) => {
      const claims = await bearer(authorization);
      // Only an anonymous caller is upgraded in place. A signed-in one
      // registering a second address must not silently overwrite the account
      // they are already holding.
      if (!claims) return null;
      const row = await services.participants.get(claims.sub);
      return row && row.anonymous ? row.id : null;
    },
    attachPassword: (id, account) => services.participants.attachPassword(id, account),
    createBlank: async (name) => {
      const issued = await identity.issue({ name, plan: 'free', anonymous: true });
      const row = await services.participants.ensure({
        id: issued.claims.sub,
        name,
        plan: 'free',
        anonymous: true,
      });
      return { id: row.id };
    },
    setPassword: (id, hash, at) => services.participants.setPassword(id, hash, at),
    issue: async (account) => {
      const plan = services.cfg.PEN_DEV_PLAN ?? account.plan;
      const issued = await identity.issue({
        sub: account.id,
        name: account.name,
        plan,
        anonymous: false,
      });
      const row = await services.participants.get(account.id);
      return {
        token: issued.token,
        // The row is the source; `account` is only the fallback for the
        // vanishingly rare case where it was removed between the write and
        // here, and it has to carry `anonymous` because a password account
        // never is one.
        participant: participantView({ ...account, anonymous: false, ...(row ?? {}), plan }),
      };
    },
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
    const claims = await bearer(c.req.header('authorization'));
    // Judged for the caller's own plan (an anonymous caller is free) on their
    // platform, exactly as `/api/me/features` answers them (ADR-0036).
    if (
      !services.features.enabled('google_sign_in', {
        plan: claims?.plan ?? 'free',
        platform: platformOf(c),
      })
    )
      return c.json(
        { error: 'GOOGLE_DISABLED', message: 'Google sign-in is not available here.' },
        503,
      );
    if (!services.google)
      return c.json(
        { error: 'GOOGLE_DISABLED', message: 'Google sign-in is not available here.' },
        503,
      );
    const body = GoogleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    if ('code' in body.data && !services.google.exchangesCodes)
      return c.json(
        { error: 'GOOGLE_DISABLED', message: 'Google sign-in is not configured here.' },
        503,
      );
    const caller = claims ? await services.participants.get(claims.sub) : null;
    try {
      const result =
        'code' in body.data
          ? await services.google.signInWithCode(body.data.code, caller)
          : await services.google.signIn(body.data.idToken, caller);
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

  /** Rename, or set the analytics choice or the teaching pace, in place: the id, sessions and bearer are untouched. */
  app.patch('/api/me', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const body = UpdateMe.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    let row = await services.participants.get(claims.sub);
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404);
    if (body.data.name !== undefined)
      row = await services.participants.rename(claims.sub, safeName(body.data.name));
    if (body.data.analyticsOptOut !== undefined) {
      row = await services.participants.setAnalyticsOptOut(claims.sub, body.data.analyticsOptOut);
      services.analytics.setOptOut(claims.sub, body.data.analyticsOptOut);
      // Turning it off erases the visits already counted, not only the next
      // ones: "not counted at all" cannot mean "counted until you noticed"
      // (ADR-0018, ADR-0027). Never fatal to the setting itself.
      const removed = body.data.analyticsOptOut
        ? await services.stats.removeVisits(claims.sub).catch((error: unknown) => {
            observer.error('stats.remove_visits', error);
            return 0;
          })
        : 0;
      observer.event('privacy.analytics_choice', {
        optOut: body.data.analyticsOptOut,
        visitsRemoved: removed,
      });
    }
    if (body.data.pace !== undefined)
      row = await services.participants.setPace(claims.sub, clampPace(body.data.pace));
    if (body.data.defaultExpertId !== undefined) {
      // A default is a paying learner's (ADR-0040): the free plan's expert is
      // the visit's random one of its two, and a visitor without an account
      // has nowhere to keep a choice.
      const id = body.data.defaultExpertId;
      if (id !== null) {
        if (claims.anonymous)
          return c.json(
            { error: 'ACCOUNT_REQUIRED', message: 'Sign in to keep a default expert.' },
            403,
          );
        if (!services.experts.get(id)) return c.json({ error: 'NOT_FOUND' }, 404);
        if (!planAllowsExpert(claims.plan, id))
          return c.json(
            {
              error: 'ENTITLEMENT_REQUIRED',
              message: `${services.experts.get(id)?.displayName ?? 'This expert'} teaches on ${PLAN_NAME[requiredPlanFor(id) ?? 'standard']}.`,
              upgrade: 'Pricing',
            },
            402,
          );
      }
      row = await services.participants.setDefaultExpert(claims.sub, id);
    }
    if (body.data.board !== undefined)
      row = await services.participants.setBoard(claims.sub, body.data.board);
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json({ participant: participantView({ ...row, plan: claims.plan }) });
  });

  // ── the participant's lists (ADR-0015) ───────────────────────────────────
  /** Membership ids + the counts beside the sidebar rows, in one read. */
  app.get('/api/me/lists', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const refused = accountRequired(claims, 'lists', platformOf(c));
    if (refused) return refused;
    return c.json(await services.lists.summary(claims.sub));
  });
  /** Every session this participant sat in (host or guest), most recent seat first. */
  app.get('/api/me/history', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const refused = accountRequired(claims, 'history', platformOf(c));
    if (refused) return refused;
    const history = await services.lists.historyFor(claims.sub);
    const counts = await services.sessions.guestCounts(history.map((h) => h.session.id));
    return c.json({
      sessions: history.map((h) => ({
        ...(h.session.hostId === claims.sub ? h.session : anonymise(h.session)),
        guests: counts.get(h.session.id) ?? 0,
        visit: { role: h.role, at: h.at },
      })),
    });
  });
  app.get('/api/me/saved', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const refused = accountRequired(claims, 'lists', platformOf(c));
    if (refused) return refused;
    const saved = await withGuests(await services.lists.savedFor(claims.sub));
    return c.json({ sessions: saved.map((r) => (r.hostId === claims.sub ? r : anonymise(r))) });
  });
  app.get('/api/me/liked', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const refused = accountRequired(claims, 'lists', platformOf(c));
    if (refused) return refused;
    const liked = await withGuests(await services.lists.likedFor(claims.sub));
    return c.json({ sessions: liked.map((r) => (r.hostId === claims.sub ? r : anonymise(r))) });
  });
  /** Hosted sessions whose MP4 is rendered and on disk (the Downloads screen). */
  app.get('/api/me/downloads', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const hosted = await services.sessions.listForHost(claims.sub);
    const downloads = hosted.flatMap((record) => {
      if (record.endedAt === null) return [];
      const job =
        [services.exports.status(record.id, 'full'), services.exports.status(record.id, 'lesson')]
          .filter((j) => j?.status === 'ready')
          .sort((a, b) => (b?.finishedAt ?? 0) - (a?.finishedAt ?? 0))[0] ?? null;
      return job && job.status === 'ready'
        ? [
            {
              ...record,
              export: { bytes: job.bytes, renderedAt: job.finishedAt, variant: job.variant },
            },
          ]
        : [];
    });
    return c.json({ sessions: downloads });
  });

  // ── data rights (ADR-0018) ───────────────────────────────────────────────
  /**
   * Everything this deployment holds about the caller, as JSON: their row, and
   * the sessions they host with the numbers each one recorded. Audio is left
   * out on purpose — it is large, and the session pages already play it.
   */
  app.get('/api/me/export', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const row = await services.participants.get(claims.sub);
    const sessions = await services.sessions.listForHost(claims.sub);
    c.header('Content-Disposition', 'attachment; filename="pen-playground-my-data.json"');
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      exportedAt: new Date().toISOString(),
      participant: row
        ? {
            ...participantView({ ...row, plan: claims.plan }),
            analyticsOptOut: row.analyticsOptOut,
            createdAt: row.createdAt,
            lastSeenAt: row.lastSeenAt,
            provider: row.provider,
          }
        : participantView({
            id: claims.sub,
            name: claims.name,
            plan: claims.plan,
            anonymous: claims.anonymous,
          }),
      sessions,
      // Everything the statistics hold about this person (ADR-0027). Their
      // sessions' derived rows are facts about the sessions above; these are
      // the rows about *them*, and a data export that left them out would be
      // an incomplete answer to "everything you hold about me".
      visits: await services.stats.visitsOf(claims.sub).catch(() => []),
      note: 'Recorded audio is not included; open a session to replay it.',
    });
  });

  /**
   * Delete the account. Every session this participant hosts goes with it —
   * index row, recording ledger, audio, thumbnails and any rendered video —
   * and the bearer stops identifying anyone, because the row it names is gone.
   * Stripe is deliberately untouched: a subscription is cancelled through the
   * billing portal, and silently dropping the record of one would be worse
   * than leaving it.
   */
  app.delete('/api/me', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const ids = await services.sessions.idsForHost(claims.sub);
    for (const id of ids) await endAndErase(id);
    // Visits and the subscription's history are theirs as well; the sessions
    // above took their derived rows with them (ADR-0027).
    await services.stats
      .removeParticipant(claims.sub)
      .catch((error: unknown) => observer.error('stats.remove_participant', error));
    const removed = await services.participants.remove(claims.sub);
    services.analytics.setOptOut(claims.sub, true);
    observer.event('privacy.account_deleted', { sessions: ids.length, removed });
    return c.json({ ok: true, sessionsDeleted: ids.length });
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
    const refused = accountRequired(claims, 'history', platformOf(c));
    if (refused) return refused;
    return c.json({ sessions: await withGuests(await services.sessions.listForHost(claims.sub)) });
  });
  app.post('/api/sessions', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    if (!allowSession(claims.sub)) {
      refuseSession(claims, 'rate_limited');
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const body = CreateSession.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    // Every read this decision needs, taken before the decision: from the
    // first check below to `admissions.hold` there is no `await`, because a
    // suspension point anywhere in there is the race this guards against.
    // `me` used to be read after the checks, which was one such point.
    const usage = await usageFor(claims);
    const me = await services.participants.get(claims.sub);
    const ip = clientKey(c.req);

    // ── no await past here until the hold is taken ──────────────────────
    const inFlight = admissions.pendingForHost(claims.sub);
    if (
      usage.reason === 'daily_limit' ||
      (usage.remaining !== null && usage.remaining <= inFlight)
    ) {
      refuseSession(claims, 'daily_limit', { sessionsToday: usage.sessionsToday });
      return c.json(
        {
          error: 'ENTITLEMENT_REQUIRED',
          // The same voice as the banner on Home, which is where the learner
          // already is and which carries the button. This one names the way
          // out without naming a plan it has no room to link to.
          message: `That is your ${usage.sessionsPerDay ?? 0} sessions for today. They are back at midnight UTC — or upgrade to continue.`,
          usage,
          upgrade: 'Pricing',
        },
        402,
      );
    }
    if (usage.reason === 'capacity') {
      // Honest, not alarming: the lights are on, the day's budget is simply spent.
      observer.event('spend.capacity', { plan: claims.plan, ...services.spend.snapshot() });
      refuseSession(claims, 'capacity');
      return c.json(
        {
          error: 'CAPACITY',
          message:
            'We have reached today’s limit for free sessions. They are back at midnight UTC — or start one now on any paid plan.',
          usage,
          upgrade: 'Pricing',
        },
        503,
      );
    }
    // The floor under the three-a-day promise: however many participants
    // one address mints, its free sessions for the day are bounded. Said in
    // the allowance's own voice, because to the learner it is the same fact.
    // Counted with what this address is starting right now, for the same
    // reason the live cap below is: a burst that arrives together must not
    // all pass a check that only sees what has already finished.
    const ipDayCap = services.config.get('PEN_MAX_FREE_SESSIONS_PER_IP_PER_DAY');
    if (
      claims.plan === 'free' &&
      ipDayCap > 0 &&
      freeStartsToday(ip) + admissions.pendingForAddress(ip) >= ipDayCap
    ) {
      observer.event('rooms.ip_day_cap', { started: freeStartsToday(ip), cap: ipDayCap });
      refuseSession(claims, 'ip_daily_limit', { started: freeStartsToday(ip) });
      return c.json(
        {
          error: 'ENTITLEMENT_REQUIRED',
          message:
            'That is all the free sessions for today from this connection. They are back at midnight UTC — or upgrade to continue.',
          usage: { ...usage, canStart: false, reason: 'daily_limit' },
          upgrade: 'Pricing',
        },
        402,
      );
    }
    const platform = platformOf(c);
    /**
     * A replay (ADR-0035) is the saved session's lesson started again as this
     * caller's own: same topic, expert, band and language, so the memo and
     * the voice store already filled for it are what this session reuses.
     * Resolved here, before the checks, because from here on it is an
     * ordinary session and every rule below applies to it as to any other.
     */
    let create: {
      topic: string;
      band: 'beginner' | 'intermediate' | 'advanced';
      expertId?: string;
      visibility: 'public' | 'private';
      language?: string;
      origin: 'search' | 'replay';
    };
    if ('replayOf' in body.data) {
      if (
        !services.features.enabled('quick_start', {
          plan: claims.plan,
          platform,
          anonymous: claims.anonymous,
        })
      ) {
        refuseSession(claims, 'feature_off', { feature: 'quick_start', platform });
        return c.json(
          {
            error: 'FEATURE_OFF',
            message: 'Starting a saved lesson again is not available here yet.',
          },
          403,
        );
      }
      const source = await services.sessions.resolve(body.data.replayOf);
      if (!source) {
        refuseSession(claims, 'replay_not_found');
        return c.json({ error: 'NOT_FOUND', message: 'That lesson is gone.' }, 404);
      }
      // A private session is its host's: nobody else may start from its card,
      // because nobody else was ever shown it.
      if (source.visibility !== 'public' && source.hostId !== claims.sub) {
        refuseSession(claims, 'replay_private', { sessionId: source.id });
        return c.json({ error: 'NOT_FOUND', message: 'That lesson is gone.' }, 404);
      }
      // A room — a session with guests — is a recording, not a lesson to
      // replay (ADR-0035). The lesson it taught is still one search away,
      // through the memo, for anyone who asks for the topic.
      const [room] = await withGuests([source]);
      if (room && room.guests > 0) {
        refuseSession(claims, 'not_replayable', { sessionId: source.id });
        return c.json(
          {
            error: 'NOT_REPLAYABLE',
            message:
              'That was a room, and a room is a recording. Search the topic to have the lesson yourself.',
          },
          409,
        );
      }
      create = {
        topic: source.topic,
        band: source.band,
        expertId: source.expertId,
        visibility: body.data.visibility,
        language: source.language,
        origin: 'replay',
      };
    } else {
      create = {
        topic: body.data.topic,
        band: body.data.band,
        visibility: body.data.visibility,
        ...(body.data.expertId ? { expertId: body.data.expertId } : {}),
        ...(body.data.language ? { language: body.data.language } : {}),
        origin: 'search',
      };
    }
    // A legend recreation is part of a plan (expert-access.ts). The client
    // already draws the lock from the served `requiredPlan`; this is the answer
    // that actually decides, and it names the plan rather than refusing blankly.
    const asked = create.expertId;
    // A replay keeps the lesson's own expert whatever the plan (ADR-0040):
    // the lesson exists, the voice is stored, and re-teaching it through
    // another persona would be the generation the free plan does not get.
    // The expert gate is for a session the learner is asking to be taught.
    if (asked && create.origin !== 'replay' && !planAllowsExpert(claims.plan, asked)) {
      const needed = requiredPlanFor(asked);
      const who = services.experts.get(asked);
      refuseSession(claims, 'expert_plan', { expertId: asked, needed: needed ?? 'standard' });
      return c.json(
        {
          error: 'ENTITLEMENT_REQUIRED',
          message: `${who?.displayName ?? 'This expert'} teaches on ${PLAN_NAME[needed ?? 'standard']}. Every other expert is ready now.`,
          upgrade: 'Pricing',
        },
        402,
      );
    }
    // One machine may host a handful of rooms at a time, not a farm of them.
    const hosted = liveByIp.get(ip);
    if (hosted) {
      // A room lingers in the registry for a minute after it ends so late reads
      // still work; it stops occupying a slot the moment it is over.
      for (const id of [...hosted]) {
        const room = rooms.get(id);
        if (!room || room.room.getState().phase === 'ended') hosted.delete(id);
      }
    }
    // Outside the `if`, deliberately. The sweep above only makes sense when
    // there is a set to sweep, but the *count* has to include what is
    // starting whether or not this address has finished starting anything
    // yet — and on the first burst from a new address there is no set at all,
    // which is exactly the moment the cap is easiest to walk through.
    const starting = admissions.pendingForAddress(ip);
    if ((hosted?.size ?? 0) + starting >= services.config.get('PEN_MAX_SESSIONS_PER_IP')) {
      observer.event('rooms.ip_cap', { live: hosted?.size ?? 0, starting });
      refuseSession(claims, 'ip_live_cap', { live: hosted?.size ?? 0, starting });
      return c.json(
        {
          error: 'RATE_LIMITED',
          message: 'A few sessions are already running here. End one and this will start.',
        },
        429,
      );
    }
    // Admitted. The place is taken here and given back below, so the next
    // request in this same window counts this one.
    const admission = admissions.hold(claims.sub, ip);
    // ── awaits are safe again ───────────────────────────────────────────
    // Whether a topic nobody has prepared may be prepared for this caller
    // (ADR-0040): the flag for their plan and platform, then the free
    // plan's allowance over the life of the account.
    const custom = customSessionsFor(claims);
    const used = me?.customSessions ?? 0;
    const allowPreparation =
      services.features.enabled('prepare_new_topics', {
        plan: claims.plan,
        platform,
        anonymous: claims.anonymous,
      }) &&
      (custom.allowance === null || used < custom.allowance);
    try {
      // The room is born at the pace this learner last chose, so a signed-in
      // learner never hears the first sentence at someone else's speed (ADR-0010).
      let live: LiveRoom;
      try {
        live = await rooms.create({
          topic: create.topic,
          host: {
            id: claims.sub,
            name: claims.name,
            plan: claims.plan,
            anonymous: claims.anonymous,
          },
          allowPreparation,
          band: create.band,
          visibility: create.visibility,
          platform,
          origin: create.origin,
          ...(create.expertId ? { expertId: create.expertId } : {}),
          ...(create.language ? { language: create.language } : {}),
          ...(me && !me.anonymous ? { pace: clampPace(me.pace) } : {}),
        });
      } catch (error) {
        if (!(error instanceof PreparationRefused)) throw error;
        /**
         * Nobody has prepared this topic and this plan may not have it
         * prepared (ADR-0036). Nothing was spent and nothing was counted.
         * The answer names the way forward and brings the lessons that are
         * ready — the same catalogue Home draws — so the learner has
         * somewhere to go from here rather than a closed door.
         */
        refuseSession(claims, 'preparation_required', {
          platform,
          origin: create.origin,
          anonymous: claims.anonymous,
          used,
        });
        /**
         * Three doors, one voice (ADR-0040). A visitor without an account is
         * asked to sign in: an account brings one custom session. A free
         * account that has had it is asked to upgrade: the way to more custom
         * sessions is a paid plan. A plan whose flag is simply off is told so.
         */
        const anonymous = claims.anonymous;
        const spent = !anonymous && custom.allowance !== null && used >= custom.allowance;
        return c.json(
          {
            error: 'PREPARATION_REQUIRED',
            message: anonymous
              ? 'Nobody has prepared that topic yet. Sign in to have a lesson prepared for you, or start one of the lessons that are ready now.'
              : spent
                ? 'That would be a new lesson, prepared just for you — and your free one is used. Upgrade to keep learning anything you can name, or start one of the lessons that are ready now.'
                : 'Nobody has prepared that topic yet. Upgrade to have it prepared for you, or start one of the lessons that are ready now.',
            upgrade: anonymous ? 'SignIn' : 'Pricing',
            ready: (await services.sessions.listPublic(12)).map(anonymise),
          },
          402,
        );
      }
      const hostedByIp = liveByIp.get(ip) ?? new Set<string>();
      hostedByIp.add(live.record.id);
      liveByIp.set(ip, hostedByIp);
      if (claims.plan === 'free') countFreeStart(ip);
      return c.json({ session: live.record, state: live.room.getState() }, 201);
    } finally {
      // After the await, so by the time the place is free the row this
      // session counts as is written and `countSince` can see it. Releasing
      // any earlier would reopen the window it was taken to close.
      admission.release();
    }
  });

  /**
   * The caller's own cell of the feature matrix (ADR-0036): their plan, on
   * the platform they said they are on. What a client shows and hides; the
   * server checks every one of these again where it matters.
   */
  app.get('/api/me/features', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const platform = platformOf(c);
    return c.json({
      plan: claims.plan,
      platform,
      anonymous: claims.anonymous,
      features: services.features.featuresFor(claims.plan, platform, {
        anonymous: claims.anonymous,
      }),
    });
  });

  /** The caller's own allowance, for the Home screen's "2 sessions left today". */
  app.get('/api/me/usage', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json(await usageFor(claims));
  });
  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    // `resolve`, not `get`: an id collapsed into another telling of the same
    // lesson still opens that lesson rather than a 404 (ADR-0031).
    const record = await services.sessions.resolve(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const claims = await bearer(c.req.header('authorization'));
    const live = rooms.get(record.id);
    // A view is somebody else opening the saved page (ADR-0035): the host
    // looking at their own is not an audience, and the recording route that
    // used to count views is now the host's alone.
    if (claims?.sub !== record.hostId) {
      await services.sessions.recordView(record.id);
      if (claims)
        services.analytics.capture(claims.sub, 'session_viewed', {
          sessionId: record.id,
          live: live !== null,
        });
    }
    const [guested] = await withGuests([record]);
    const shown = guested ?? { ...record, guests: 0 };
    return c.json({
      session: claims?.sub === record.hostId ? shown : anonymise(shown),
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
    | { ok: false; status: 401 | 403 | 404; body: { error: string; message?: string } }
  > => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } };
    if (
      !services.features.enabled('lists', {
        plan: claims.plan,
        platform: platformOf(c),
        anonymous: claims.anonymous,
      })
    )
      return {
        ok: false,
        status: 403,
        body: {
          error: 'ACCOUNT_REQUIRED',
          message: 'Sign in to keep the lessons you like and save.',
        },
      };
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
  /**
   * Comments under a saved session (ADR-0044), the way YouTube has them.
   * Everyone who can open the session reads the thread; an account writes;
   * the author and the host delete. Newest first, cut by `before` so a
   * comment posted mid-scroll never shifts the page.
   */
  app.get('/api/sessions/:id/comments', async (c) => {
    const record = await services.sessions.resolve(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const before = Number(c.req.query('before'));
    const limit = Number(c.req.query('limit'));
    const page = await services.comments.list(record.id, {
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });
    const last = page.comments.at(-1);
    return c.json({
      comments: page.comments,
      total: page.total,
      nextBefore: last && page.comments.length < page.total ? last.createdAt : null,
    });
  });
  app.post('/api/sessions/:id/comments', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    if (
      !services.features.enabled('comments', {
        plan: claims.plan,
        platform: platformOf(c),
        anonymous: claims.anonymous,
      })
    )
      return c.json(
        { error: 'ACCOUNT_REQUIRED', message: 'Sign in to comment.', upgrade: 'SignIn' },
        403,
      );
    const record = await services.sessions.resolve(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (!commentLimiter.allow(claims.sub))
      return c.json(
        { error: 'RATE_LIMITED', message: 'That is a lot of comments at once. Give it a minute.' },
        429,
      );
    const body = CommentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const comment = await services.comments.create({
      id: `c_${nanoid(16)}`,
      sessionId: record.id,
      authorId: claims.sub,
      body: body.data.body,
    });
    if (!comment) return c.json({ error: 'SIGN_IN_FAILED', message: 'Could not post that.' }, 500);
    observer.event('session.comment', { sessionId: record.id, length: body.data.body.length });
    services.analytics.capture(claims.sub, 'comment_posted', {
      sessionId: record.id,
      length: body.data.body.length,
    });
    return c.json({ comment });
  });
  app.delete('/api/sessions/:id/comments/:commentId', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const record = await services.sessions.resolve(c.req.param('id'));
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const row = await services.comments.row(c.req.param('commentId'));
    if (!row || row.sessionId !== record.id || row.deletedAt !== null)
      return c.json({ error: 'NOT_FOUND' }, 404);
    const own = row.authorId === claims.sub;
    if (!own && record.hostId !== claims.sub)
      return c.json(
        { error: 'NOT_ALLOWED', message: 'Only its author or the host can delete a comment.' },
        403,
      );
    await services.comments.remove(row.id);
    observer.event('session.comment_deleted', { sessionId: record.id, own });
    services.analytics.capture(claims.sub, 'comment_deleted', { sessionId: record.id, own });
    return c.json({ ok: true });
  });

  /**
   * Who may read a recording (ADR-0035): its host, and only its host. The
   * questions in it are theirs, the answers were composed for them, and a
   * caption is their own words. Everyone else starts the lesson again as a
   * fresh session of their own (`replayOf`), which is what "replay" means
   * here. The headless renderer and the `<a download>` link present the same
   * short-lived token a download does, minted in the host's name; a bearer
   * works too. The flag `recording_playback` is the host's own switch on top.
   *
   * Returns the record, or the response that says why not.
   */
  const recordingAccess = async (c: {
    req: {
      header(name: string): string | undefined;
      param(name: string): string;
      query(name: string): string | undefined;
    };
  }): Promise<
    | {
        ok: true;
        record: NonNullable<Awaited<ReturnType<typeof services.sessions.resolve>>>;
        viewer: string;
      }
    | { ok: false; status: 401 | 403 | 404; body: { error: string; message?: string } }
  > => {
    const record = await services.sessions.resolve(c.req.param('id'));
    if (!record) return { ok: false, status: 404, body: { error: 'NOT_FOUND' } };
    const token = c.req.query('token');
    let viewer: string | null = token
      ? await services.downloadTokens.verify(token, record.id)
      : null;
    let plan: PlanCode | null = null;
    let anonymous = false;
    if (!viewer) {
      const claims = await bearer(c.req.header('authorization'));
      if (claims) {
        viewer = claims.sub;
        plan = claims.plan;
        anonymous = claims.anonymous;
      }
    }
    if (!viewer) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } };
    if (!recordingIsPrivateTo(record, viewer))
      return {
        ok: false,
        status: 403,
        body: {
          error: 'NOT_HOST',
          message: 'A recording is only ever yours. Start this lesson to have your own.',
        },
      };
    // The flag is about *watching* in the app. A token is the renderer or a
    // download link, which `session_download` already decided, so it is not
    // asked again here — otherwise a plan with downloads and no playback
    // could never render the file it is allowed to have.
    if (
      plan !== null &&
      !services.features.enabled('recording_playback', { plan, platform: platformOf(c), anonymous })
    )
      return {
        ok: false,
        status: 403,
        body: anonymous
          ? { error: 'ACCOUNT_REQUIRED', message: 'Sign in to keep and watch your recordings.' }
          : { error: 'FEATURE_OFF', message: 'Recordings are not available on this plan here.' },
      };
    return { ok: true, record, viewer };
  };
  app.get('/api/sessions/:id/ledger', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const access = await recordingAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    const { record } = access;
    return c.json({
      session: record,
      entries: services.ledger.read(record.id),
      expert: services.experts.get(record.expertId),
    });
  });
  app.get('/api/sessions/:id/audio/:file', async (c) => {
    const access = await recordingAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    // The ledger above may have answered from a session this id was collapsed
    // into; its audio has to come from the same recording.
    const p = services.ledger.audioPath(access.record.id, c.req.param('file'));
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
   * Development only: a VAST ad this deployment serves itself.
   *
   * The ad path is worth exercising end to end — the real IMA SDK, a real
   * creative, the real player — but Google's public sample tag answers over
   * the open internet and does not always fill within the eight seconds
   * `AD_RULES.requestTimeoutMs` allows. This is the deterministic creative
   * that replaces it: the same SDK, the same player, the same measurement.
   *
   * It is not yet what the suite runs, and the reason is a browser rule rather
   * than anything here. The SDK requests the tag from inside its own frame,
   * that frame mirrors the page's scheme, and Chrome refuses an insecure
   * public origin reaching a loopback address at all — "the request client is
   * not a secure context and the resource is in more-private address space
   * `loopback`", surfacing as IMA error 1005 (FAILED_TO_REQUEST_ADS). Serving
   * the e2e page over https makes the SDK's frame a secure context and this
   * usable; until then `PEN_E2E_AD_FIXTURE=1` is how to try it, and
   * tasks/todo.md carries the finding.
   *
   * Never mounted in production, where a self-served ad would earn nothing and
   * mean nothing.
   */
  if (services.cfg.NODE_ENV !== 'production') {
    const adFixture = join(DATA_DIR, 'dev', 'ad-fixture.mp4');
    app.get('/api/dev/ad/vast.xml', (c) => {
      // The creative is fetched from the origin the page is on, so the policy
      // that governs it is the product's own (`media-src 'self'`).
      const media = `${services.cfg.PEN_PUBLIC_URL}/api/dev/ad/media.mp4`;
      c.header('Content-Type', 'application/xml; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      // The SDK asks for the tag from inside its own imasdk.googleapis.com
      // frame, so this answer is cross-origin to it and needs to say so. A
      // development-only test creative is public by nature.
      c.header('Access-Control-Allow-Origin', '*');
      return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="pen-dev-ad">
    <InLine>
      <AdSystem>Pen Playground (development)</AdSystem>
      <AdTitle>Pen Playground test creative</AdTitle>
      <Impression><![CDATA[${services.cfg.PEN_PUBLIC_URL}/api/dev/ad/impression]]></Impression>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:05">
            <Duration>00:00:08</Duration>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="640" height="480" scalable="true" maintainAspectRatio="true"><![CDATA[${media}]]></MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>
`);
    });
    /** The creative itself. Range requests matter: a video element asks for them. */
    app.get('/api/dev/ad/media.mp4', (c) => {
      if (!existsSync(adFixture)) return c.json({ error: 'NOT_FOUND' }, 404);
      const size = statSync(adFixture).size;
      c.header('Content-Type', 'video/mp4');
      c.header('Accept-Ranges', 'bytes');
      c.header('Cache-Control', 'no-store');
      c.header('Access-Control-Allow-Origin', '*');
      const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
      if (range?.[1]) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size || start > end) {
          c.header('Content-Range', `bytes */${size}`);
          return c.body(null, 416);
        }
        c.header('Content-Range', `bytes ${start}-${end}/${size}`);
        c.header('Content-Length', String(end - start + 1));
        return c.body(
          Readable.toWeb(createReadStream(adFixture, { start, end })) as ReadableStream,
          206,
        );
      }
      c.header('Content-Length', String(size));
      return c.body(Readable.toWeb(createReadStream(adFixture)) as ReadableStream);
    });
    /** The impression beacon the VAST above declares; counted by the SDK, ignored here. */
    app.get('/api/dev/ad/impression', (c) => c.body(null, 204));
  }

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
      const plan = body.data.plan ?? claims.plan;
      if (plan !== claims.plan) await services.participants.setPlan(row.id, plan);
      const issued = await identity.issue({ sub: row.id, name, plan, anonymous: false });
      return c.json({
        token: issued.token,
        participant: participantView({ ...row, plan }),
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

  // ── thumbnails (ADR-0013, ADR-0021) ──────────────────────────────────────
  /**
   * The generated picture, at each size we render it. Public sessions are
   * public assets with a long cache; a private session's thumbnail is only for
   * its host, uncached by proxies. A missing thumbnail is a 404 the client
   * treats as "not ready".
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
    const asked = c.req.param('id');
    if (!SessionId.safeParse(asked).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const record = await services.sessions.resolve(asked);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    const id = record.id;
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
  app.get('/api/sessions/:id/thumb.webp', (c) => thumbnail(c, 'card'));
  app.get('/api/sessions/:id/og.jpg', (c) => thumbnail(c, 'og'));
  /**
   * What earlier sessions have on disk and their records still point at: the
   * PNG pair from ADR-0021, and the hand-drawn sketch from before it. Both are
   * served as they are and neither is ever written again — a missing one is a
   * 404 rather than a re-derivation, because the file the card wants now is
   * `thumb.webp`. `thumbnails:backfill --redraw` moves a session forward.
   */
  app.get('/api/sessions/:id/thumb.png', (c) => thumbnail(c, 'cardPng'));
  app.get('/api/sessions/:id/og.png', (c) => thumbnail(c, 'ogPng'));
  app.get('/api/sessions/:id/thumb.svg', (c) => thumbnail(c, 'svg'));

  /**
   * Stop a session if it is live and erase everything it left behind: the
   * index row, and the whole session directory (ledger, audio, thumbnails,
   * rendered video). Used by both deletion routes, so one session and a whole
   * account clean up identically.
   */
  const endAndErase = async (sessionId: string): Promise<void> => {
    if (rooms.get(sessionId)) await rooms.end(sessionId);
    services.exports.forget(sessionId);
    services.ledger.remove(sessionId);
    // Saves, likes and history are (participant, session) pairs with no
    // foreign key to take them along. The lists inner-join `sessions`, so a
    // leftover pair is invisible rather than harmless: it stays for ever and
    // would attach itself to a reused id (ADR-0031).
    await services.lists
      .forgetSession(sessionId)
      .catch((error: unknown) => observer.error('lists.forget_session', error, { sessionId }));
    await services.comments
      .forgetSession(sessionId)
      .catch((error: unknown) => observer.error('comments.forget_session', error, { sessionId }));
    await services.sessions.remove(sessionId);
    // The statistics are derived from what was just erased, so they go too
    // (ADR-0027). A failure here must not turn a deletion into an error the
    // learner sees: the row is orphaned, and the backfill's own cleanup
    // catches it.
    await services.stats
      .removeSession(sessionId)
      .catch((error: unknown) => observer.error('stats.remove_session', error, { sessionId }));
  };

  const Visibility = z.object({ visibility: z.enum(['public', 'private']) });

  /**
   * Public or private. A private session disappears from the catalogue and its
   * share page and thumbnail stop answering anyone but its host — the checks
   * that already read `record.visibility` simply start saying no.
   */
  app.patch('/api/sessions/:id', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.hostId !== claims.sub)
      return c.json({ error: 'NOT_HOST', message: 'Only the host can change this.' }, 403);
    // A paid host's choice (ADR-0044): the page does not draw the control below
    // Standard, and the API says the same thing to a call that arrives anyway.
    if (
      !services.features.enabled('session_visibility', {
        plan: claims.plan,
        platform: platformOf(c),
        anonymous: claims.anonymous,
      })
    )
      return c.json(
        {
          error: 'PLAN_REQUIRED',
          message: 'Making a session private is part of Standard.',
          upgrade: 'Pricing',
        },
        403,
      );
    const body = Visibility.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    const updated = await services.sessions.patch(id, { visibility: body.data.visibility });
    if (!updated) return c.json({ error: 'NOT_FOUND' }, 404);
    observer.event('session.visibility', { sessionId: id, visibility: body.data.visibility });
    return c.json({ session: updated });
  });

  /** Delete one session and everything it recorded. Host only, live or ended. */
  app.delete('/api/sessions/:id', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const id = c.req.param('id');
    if (!SessionId.safeParse(id).success) return c.json({ error: 'NOT_FOUND' }, 404);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.hostId !== claims.sub)
      return c.json({ error: 'NOT_HOST', message: 'Only the host can delete this session.' }, 403);
    await endAndErase(id);
    observer.event('session.deleted', { sessionId: id });
    return c.json({ ok: true });
  });

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
    if (
      !services.features.enabled('session_download', { plan: claims.plan, platform: platformOf(c) })
    )
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
  /**
   * Which recording (ADR-0035): `interactions=0` on the request is the lesson
   * alone; anything else is the session as the host lived it. The client
   * asks for one or the other and every answer names which it is about.
   */
  const exportVariantOf = (c: {
    req: { query(name: string): string | undefined };
  }): ExportVariant => (c.req.query('interactions') === '0' ? 'lesson' : 'full');
  const exportView = async (
    job: ReturnType<typeof services.exports.status>,
    claims: Claims,
    sessionId: string,
    variant: ExportVariant,
  ) => {
    if (!job || job.status === 'stale')
      return {
        status: 'none' as const,
        variant,
        progress: 0,
        error: null,
        downloadUrl: null,
        bytes: null,
        durationMs: null,
      };
    const downloadUrl =
      job.status === 'ready'
        ? publicUrl(
            services.cfg.PEN_API_URL,
            `/api/sessions/${encodeURIComponent(sessionId)}/export.mp4?interactions=${variant === 'full' ? '1' : '0'}&token=${encodeURIComponent(await services.downloadTokens.issue(claims.sub, sessionId))}`,
          )
        : null;
    return {
      status: job.status,
      variant,
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
    const variant = exportVariantOf(c);
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
      job = services.exports.request(access.record.id, variant);
    } catch (error) {
      if (!(error instanceof ExportRefused)) throw error;
      const status = error.code === 'QUEUE_FULL' ? 503 : error.code === 'TOO_LONG' ? 413 : 409;
      return c.json({ error: `EXPORT_${error.code}`, message: error.message }, status);
    }
    services.analytics.capture(access.claims.sub, 'export_requested', {
      status: job.status,
      variant,
    });
    return c.json(
      await exportView(job, access.claims, access.record.id, variant),
      job.status === 'ready' ? 200 : 202,
    );
  });
  app.get('/api/sessions/:id/export', async (c) => {
    const access = await exportAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    const variant = exportVariantOf(c);
    return c.json(
      await exportView(
        services.exports.status(access.record.id, variant),
        access.claims,
        access.record.id,
        variant,
      ),
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
      if (
        claims &&
        services.features.enabled('session_download', {
          plan: claims.plan,
          platform: platformOf(c),
        })
      )
        participantId = claims.sub;
    }
    if (!participantId) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const record = await services.sessions.get(id);
    if (!record) return c.json({ error: 'NOT_FOUND' }, 404);
    if (record.hostId !== participantId) return c.json({ error: 'NOT_HOST' }, 403);
    const job = services.exports.status(id, exportVariantOf(c));
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
    // A link somebody already has outlives the session it was made from: when
    // that telling was collapsed into another, the card, the canonical URL and
    // the redirect below all name the one that was kept (ADR-0031).
    const record = await services.sessions.resolve(c.req.param('id'));
    if (!record) return c.notFound();
    const expert = services.experts.get(record.expertId);
    const target = publicUrl(services.cfg.PEN_PUBLIC_URL, `/sessions/${record.id}`);
    const esc = (s: string) =>
      s.replace(
        /[&<>"]/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
      );
    const description =
      record.description ||
      record.promise ||
      `A session with ${expert?.displayName ?? 'an AI expert'} on Pen Playground`;
    // Open Graph gets the 1200 × 630 downscale of the session's generated
    // picture; only public sessions can be fetched without a bearer, so only
    // they advertise an image.
    const image =
      record.thumbnail && record.visibility === 'public'
        ? publicUrl(
            services.cfg.PEN_API_URL,
            `/api/sessions/${encodeURIComponent(record.id)}/${THUMB_FILES.og}`,
          )
        : null;
    const imageTags = image
      ? `<meta property="og:image" content="${esc(image)}"><meta property="og:image:type" content="${THUMB_CONTENT_TYPE.og}"><meta property="og:image:width" content="${THUMB_SIZES.og.width}"><meta property="og:image:height" content="${THUMB_SIZES.og.height}"><meta property="og:image:alt" content="${esc(record.title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(image)}"><meta name="twitter:image:alt" content="${esc(record.title)}">`
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
  app.post('/api/rooms/:id/token', async (c) => {
    const access = await roomAudioAccess(c);
    if (!access.ok) return c.json(access.body, access.status);
    const livekit = services.livekit;
    if (!livekit) return c.json({ error: 'ROOMS_UNAVAILABLE' }, 503);
    if (!access.live.features.rooms)
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

  const unreachable = 'The settings store cannot be reached right now. Nothing was changed.';
  /**
   * The three ways a save can end, in one place: somebody else got there
   * first, the value is not one this setting accepts, or the store is down.
   * Each is a different status so the console can say which without guessing.
   */
  const runtimeConfigWrite = async (c: Context, run: () => Promise<unknown>): Promise<Response> => {
    c.header('cache-control', 'no-store');
    try {
      return c.json((await run()) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof RuntimeConfigConflict)
        return c.json({ error: 'CONFLICT', message: error.message, current: error.current }, 409);
      if (error instanceof RuntimeConfigInvalid)
        return c.json({ error: 'INVALID', message: error.message }, 422);
      observer.error('runtime_config.write', error);
      return c.json({ error: 'UNAVAILABLE', message: unreachable }, 503);
    }
  };

  /**
   * Who may change how the product runs (ADR-0025). An allow-list of Google
   * addresses in `PEN_ADMIN_EMAILS`, checked against the participant's own
   * row rather than against anything in the bearer, so revoking access is one
   * environment variable and does not wait for a token to expire.
   *
   * Unset means nobody: a deployment that never configures this cannot have
   * its providers switched by whoever happens to hold a signed-in token.
   * Anonymous participants never qualify, whatever the list says.
   */
  const adminEmails = new Set(
    (services.cfg.PEN_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const admin = async (
    header: string | undefined,
  ): Promise<{ id: string; name: string; email: string } | null> => {
    if (adminEmails.size === 0) return null;
    const claims = await bearer(header);
    if (!claims || claims.anonymous) return null;
    const row = await services.participants.get(claims.sub);
    if (!row) return null;
    // Only an address Google verified. `POST /api/dev/me/google` writes this
    // column from the request body on non-production boxes, so without this
    // any staging deployment with `PEN_ADMIN_EMAILS` set would hand the
    // console to whoever posted the owner's address.
    if (row.provider !== 'google' || !row.googleSub) return null;
    const email = row.email?.trim().toLowerCase();
    if (!email || !adminEmails.has(email)) return null;
    return { id: row.id, name: row.name, email };
  };

  /**
   * Statistics and reports (ADR-0027): the visit beacon, and every admin-only
   * aggregate behind the same allow-list as the console above. Registered
   * here rather than beside the other routes so it shares that one `admin`
   * check, and `bearer` — which is what keeps the analytics opt-out current.
   */
  registerStatsRoutes(app, {
    services,
    bearer,
    isAdmin: async (header) => (await admin(header)) !== null,
  });

  /**
   * Whether this bearer may open the admin app, and who it belongs to. The
   * admin app calls it on load: one answer decides between the console and
   * the sign-in screen, and it never leaks the allow-list to anyone else.
   */
  app.get('/api/admin/session', async (c) => {
    c.header('cache-control', 'no-store');
    const actor = await admin(c.req.header('authorization'));
    if (!actor) return c.json({ admin: false }, 200);
    return c.json({ admin: true, id: actor.id, name: actor.name, email: actor.email });
  });

  app.get('/api/admin/runtime-config', async (c) => {
    c.header('cache-control', 'no-store');
    if (!(await admin(c.req.header('authorization')))) return c.json({ error: 'FORBIDDEN' }, 403);
    return c.json(await services.runtimeConfig.document());
  });

  app.put('/api/admin/runtime-config', async (c) => {
    const actor = await admin(c.req.header('authorization'));
    if (!actor) return c.json({ error: 'FORBIDDEN' }, 403);
    const body = RuntimeConfigMutation.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    return runtimeConfigWrite(c, () => services.runtimeConfig.mutate(actor, body.data));
  });

  app.get('/api/admin/runtime-config/history', async (c) => {
    c.header('cache-control', 'no-store');
    if (!(await admin(c.req.header('authorization')))) return c.json({ error: 'FORBIDDEN' }, 403);
    const before = Number(c.req.query('beforeRevision'));
    const limit = Number(c.req.query('limit'));
    try {
      return c.json(
        await services.runtimeConfig.history({
          beforeRevision: Number.isFinite(before) && before > 0 ? before : null,
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        }),
      );
    } catch (error) {
      observer.error('runtime_config.history', error);
      return c.json({ error: 'UNAVAILABLE', message: unreachable }, 503);
    }
  });

  app.post('/api/admin/runtime-config/rollback', async (c) => {
    const actor = await admin(c.req.header('authorization'));
    if (!actor) return c.json({ error: 'FORBIDDEN' }, 403);
    const body = RuntimeConfigRollback.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    return runtimeConfigWrite(c, () => services.runtimeConfig.rollback(actor, body.data));
  });

  /**
   * The Features screen's own routes (ADR-0036): the same shape as the
   * settings above — document, save with a reason, history, rollback — and
   * the same three ways a write can end.
   */
  const featuresWrite = async (c: Context, run: () => Promise<unknown>): Promise<Response> => {
    c.header('cache-control', 'no-store');
    try {
      return c.json((await run()) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof FeatureFlagsConflict)
        return c.json({ error: 'CONFLICT', message: error.message, current: error.current }, 409);
      if (error instanceof FeatureFlagsInvalid)
        return c.json({ error: 'INVALID', message: error.message }, 422);
      observer.error('features.write', error);
      return c.json({ error: 'UNAVAILABLE', message: unreachable }, 503);
    }
  };
  app.get('/api/admin/features', async (c) => {
    c.header('cache-control', 'no-store');
    if (!(await admin(c.req.header('authorization')))) return c.json({ error: 'FORBIDDEN' }, 403);
    return c.json(await services.featureFlags.document());
  });
  app.put('/api/admin/features', async (c) => {
    const actor = await admin(c.req.header('authorization'));
    if (!actor) return c.json({ error: 'FORBIDDEN' }, 403);
    const body = FeatureFlagsMutation.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    return featuresWrite(c, () => services.featureFlags.mutate(actor, body.data));
  });
  app.get('/api/admin/features/history', async (c) => {
    c.header('cache-control', 'no-store');
    if (!(await admin(c.req.header('authorization')))) return c.json({ error: 'FORBIDDEN' }, 403);
    const before = Number(c.req.query('beforeRevision'));
    const limit = Number(c.req.query('limit'));
    try {
      return c.json(
        await services.featureFlags.history({
          beforeRevision: Number.isFinite(before) && before > 0 ? before : null,
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        }),
      );
    } catch (error) {
      observer.error('features.history', error);
      return c.json({ error: 'UNAVAILABLE', message: unreachable }, 503);
    }
  });
  app.post('/api/admin/features/rollback', async (c) => {
    const actor = await admin(c.req.header('authorization'));
    if (!actor) return c.json({ error: 'FORBIDDEN' }, 403);
    const body = FeatureFlagsRollback.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID', issues: body.error.issues }, 400);
    return featuresWrite(c, () => services.featureFlags.rollback(actor, body.data));
  });

  app.get('/api/admin/costs', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json({
      costs: services.costs.snapshot(),
      // What the circuit breaker is looking at, and what the synthesis cache
      // has saved from having to be bought twice.
      spend: services.spend.snapshot(),
      tts: services.ttsCache?.snapshot() ?? null,
    });
  });

  // ── room socket ──────────────────────────────────────────────────────────
  app.get(
    '/ws/room',
    upgradeWebSocket(() => {
      let claims: Claims | null = null;
      let sessionId: string | null = null;
      let authTimer: NodeJS.Timeout | null = null;
      /** Frames this socket sent that were not valid protocol. */
      let badFrames = 0;
      /** Said once per socket: a flood is frames, and one report per frame is another flood. */
      let audioFloodReported = false;
      /** Characters of recognised speech this socket has sent. */
      let transcriptChars = 0;
      /** One token bucket per message family, per socket (the socket is one participant). */
      const buckets = new Map<string, RateLimiter>();
      const allow = (family: keyof typeof WS_LIMITS | string): boolean => {
        const rule = WS_LIMITS[family];
        if (!rule) return true;
        let bucket = buckets.get(family);
        if (!bucket) {
          bucket = new RateLimiter(rule.limit, rule.windowMs);
          buckets.set(family, bucket);
        }
        return bucket.allow(family);
      };
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
            if (!allow('audio')) {
              // Quietly: an audio flood is frames, not sentences, and one
              // `fail` per frame would be its own flood.
              if (!audioFloodReported) {
                audioFloodReported = true;
                observer.event('ws.audio_flood', { sessionId });
              }
              return;
            }
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
          // Parsed safely, not by `JSON.parse` inside the `try` below. A
          // frame that is not JSON at all used to throw past this branch into
          // the outer catch, which files a Sentry error and answers
          // `INTERNAL` — so `badFrames` never counted it and `close(4002)`
          // never fired. One authenticated socket sending `{` was one issue
          // per frame, for as long as it cared to keep sending. A malformed
          // frame is the client's mistake either way, so it takes the same
          // path as one that parsed and did not match the protocol.
          let payload: unknown;
          try {
            payload = JSON.parse(String(evt.data));
          } catch {
            payload = null;
          }
          const parsed = ClientMessage.safeParse(payload);
          if (!parsed.success) {
            badFrames += 1;
            fail(ws, 'BAD_MESSAGE', 'That message did not match the protocol.');
            if (badFrames >= MAX_BAD_FRAMES) {
              observer.event('ws.too_many_bad_frames', { frames: badFrames });
              ws.close(4002, 'bad messages');
            }
            return;
          }
          const msg = parsed.data;
          // Chatty by design, but bounded: a client that floods one kind of
          // message is told to slow down rather than growing the ledger.
          const family =
            msg.kind === 'check_answer'
              ? 'question'
              : msg.kind === 'transcript' && msg.final
                ? 'question'
                : msg.kind;
          if (!allow(family)) {
            fail(ws, 'RATE_LIMITED', 'That is a lot at once — give it a second.');
            return;
          }
          if (msg.kind === 'transcript') {
            transcriptChars += msg.text.length;
            if (transcriptChars > MAX_TRANSCRIPT_CHARS) {
              observer.event('ws.transcript_cap', { chars: transcriptChars });
              fail(ws, 'RATE_LIMITED', 'That is more speech than one session can hold.');
              return;
            }
          }
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
            // Only the host's frame closes the room. `SessionRoom.control`
            // has always refused a guest with `NOT_HOST` and changed nothing
            // — and this line then ended the session anyway, so the refusal
            // was answered and the lesson stopped regardless. Any guest in a
            // Professional host's room could close it with one frame. The
            // REST twin (`POST /api/sessions/:id/end`) checks the same thing.
            if (live.record.hostId === claims.sub) await rooms.end(sessionId);
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
