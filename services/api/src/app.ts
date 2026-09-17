import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNodeWebSocket } from '@hono/node-ws';
import {
  ClientMessage,
  decodeAudioFrame,
  type ServerErrorCode,
  type ServerMessage,
} from '@pen/contracts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { WSContext } from 'hono/ws';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Claims } from './identity.js';
import { Identity, safeName } from './identity.js';
import { logger } from './logger.js';
import { observer } from './observability.js';
import { RoomRegistry } from './rooms.js';
import { DATA_DIR, type Services } from './services.js';

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

/** Strip the creator from a session record for anyone but the host. */
function anonymise<T extends { hostId: string; hostName: string }>(record: T): T {
  return { ...record, hostId: '', hostName: '' };
}

/** In-memory token-bucket per key; enough for one node, replaced by Redis behind the same function. */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) return false;
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}

export function buildApp(services: Services): App {
  const app = new Hono();
  const identity = new Identity(services.cfg.PEN_JWT_SECRET);
  const rooms = new RoomRegistry(services);
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const allowSession = rateLimiter(20, 60_000);
  const allowAuth = rateLimiter(30, 60_000);

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
      ? { ...claims, name: row.name, plan: services.cfg.PEN_DEV_PLAN ?? row.plan }
      : claims;
  };

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      tts: services.synthesizer.id,
      llm: services.cfg.PEN_LLM_PROVIDER,
      stt: services.cfg.PEN_STT_PROVIDER,
      acquirer: services.acquirer !== null,
    }),
  );

  app.post('/api/auth/anonymous', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (!allowAuth(ip)) return c.json({ error: 'RATE_LIMITED' }, 429);
    const body = Anonymous.safeParse(await c.req.json().catch(() => ({})));
    const name = safeName(body.success ? body.data.name : undefined);
    const plan = services.cfg.PEN_DEV_PLAN ?? 'free';
    const issued = await identity.issue({ name, plan, anonymous: true });
    await services.participants.ensure({ id: issued.claims.sub, name, plan, anonymous: true });
    return c.json({
      token: issued.token,
      participant: { id: issued.claims.sub, name: issued.claims.name, plan: issued.claims.plan },
    });
  });

  app.get('/api/me', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    return c.json({ participant: { id: claims.sub, name: claims.name, plan: claims.plan } });
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
  app.post('/api/sessions/:id/end', async (c) => {
    const claims = await bearer(c.req.header('authorization'));
    if (!claims) return c.json({ error: 'UNAUTHORIZED' }, 401);
    const live = rooms.get(c.req.param('id'));
    if (!live) return c.json({ error: 'NOT_FOUND' }, 404);
    if (live.record.hostId !== claims.sub) return c.json({ error: 'NOT_HOST' }, 403);
    await rooms.end(live.record.id);
    return c.json({ ok: true, state: live.room.getState() });
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
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(record.title)} · Pen Academy</title>
<meta property="og:title" content="${esc(record.title)}"><meta property="og:description" content="${esc(record.promise || `A session with ${expert?.displayName ?? 'an AI expert'} on Pen Academy`)}">
<meta property="og:type" content="video.other"><meta property="og:url" content="${esc(target)}">${record.thumbnail ? `<meta property="og:image" content="${esc(record.thumbnail)}">` : ''}
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head><body><a href="${esc(target)}">Open the session</a></body></html>`);
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

      const fail = (ws: { send(data: string): void }, code: ServerErrorCode, message: string) =>
        ws.send(
          JSON.stringify({ kind: 'error', code, message, spoken: false } satisfies ServerMessage),
        );

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
            const { header } = decodeAudioFrame(bytes);
            if (header.dir !== 'up') return;
            if (services.cfg.PEN_STT_PROVIDER === 'browser')
              fail(
                ws,
                'STT_UNAVAILABLE',
                'Server-side transcription is not enabled; use on-device speech recognition.',
              );
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
            .catch((error) => observer.error('ws.chain', error));
        },
        onClose(_evt, ws) {
          if (authTimer) clearTimeout(authTimer);
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
