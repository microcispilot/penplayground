import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ClientMessage, RoomInvite, ServerMessage } from '@pen/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import type { RoomRegistry } from '../src/rooms.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';

/**
 * A seat in a room is a paid plan's (ADR-0058). The owner: "the invited
 * person should be a paid member, either of the plans … showing the owner of
 * the room, details about the session, a, b and 5 others in the session
 * learning together, and then a proper message that in order to join the
 * session a subscription is required, then the CTA saying Upgrade … if the
 * person is not already a paid person, otherwise they should be able to
 * directly join."
 *
 * Proved over the real API: the invite view says who is in the room and
 * whether this caller may come in, and the socket refuses the seat the page
 * refused, so the page never promises what the door denies.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

let services: Services;
let identity: Identity;
let rooms: RoomRegistry;
let apiUrl: string;
let dataDir: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'pen-room-invite-'));
  apiUrl = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_PORT: String(port),
    PEN_JWT_SECRET: 'room-invite-secret-'.repeat(3),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
    PEN_API_URL: apiUrl,
  });
  services = await buildServices(cfg);
  await seedPacks(services.onten, join(DATA_DIR, 'packs'));
  identity = new Identity(cfg.PEN_JWT_SECRET);
  const built = buildApp(services);
  rooms = built.rooms;
  const server = serve({ fetch: built.app.fetch, port, hostname: '127.0.0.1' });
  built.injectWebSocket(server);
  stop = async () => {
    rooms.sweep(Number.MAX_SAFE_INTEGER);
    await new Promise<void>((r) => server.close(() => r()));
    await services.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}, 60_000);

afterAll(async () => {
  await stop?.();
});

async function caller(name: string, plan: 'free' | 'standard' | 'professional', anonymous = false) {
  const issued = await identity.issue({ name, plan, anonymous });
  await services.participants.ensure({ id: issued.claims.sub, name, plan, anonymous });
  return {
    id: issued.claims.sub,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
  };
}

/** Ask for a seat and report the first thing the room says back: `ready`, or an error code. */
function knock(
  token: string,
  sessionId: string,
): Promise<{ ws: WebSocket; send: (m: ClientMessage) => void; answer: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${apiUrl.replace('http', 'ws')}/ws/room`);
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    const timer = setTimeout(() => reject(new Error('the room never answered')), 20_000);
    ws.on('open', () => {
      send({ kind: 'auth', token });
      send({ kind: 'join', sessionId });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.kind === 'ready' || msg.kind === 'error') {
        clearTimeout(timer);
        resolve({ ws, send, answer: msg.kind === 'ready' ? 'ready' : msg.code });
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function invite(sessionId: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${apiUrl}/api/sessions/${sessionId}/invite`, { headers });
  return { status: res.status, body: (await res.json()) as RoomInvite & { error?: string } };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("a seat in a room is a paid plan's (ADR-0058)", () => {
  it('the invite view names the room and its people, and answers each caller for themselves', async () => {
    const host = await caller('Sam', 'professional');
    const ana = await caller('Ana', 'standard');
    const ben = await caller('Ben', 'professional');
    const kim = await caller('Kim', 'free');
    const created = await fetch(`${apiUrl}/api/sessions`, {
      method: 'POST',
      headers: host.headers,
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const hostSeat = await knock(host.token, session.id);
    expect(hostSeat.answer).toBe('ready');
    // Two paid guests take their seats directly.
    const anaSeat = await knock(ana.token, session.id);
    const benSeat = await knock(ben.token, session.id);
    expect(anaSeat.answer).toBe('ready');
    expect(benSeat.answer).toBe('ready');
    await settle();

    // A free account is shown the room and told what it takes.
    const forKim = await invite(session.id, kim.headers);
    expect(forKim.status).toBe(200);
    expect(forKim.body).toMatchObject({
      sessionId: session.id,
      topic: 'How Transformers work in LLMs',
      host: { name: 'Sam' },
      seats: { taken: 3, total: 12 },
      access: { canJoin: false, reason: 'subscription_required' },
    });
    expect(forKim.body.guests.map((g) => g.name)).toEqual(['Ana', 'Ben']);
    expect(forKim.body.phase).not.toBe('ended');
    // Nothing that is not a name and a colour leaves with the roster.
    for (const person of [forKim.body.host, ...forKim.body.guests])
      expect(Object.keys(person).sort()).toEqual(['hue', 'name']);

    // A visitor with no bearer at all sees the same room and the same answer.
    const forVisitor = await invite(session.id);
    expect(forVisitor.status).toBe(200);
    expect(forVisitor.body.access).toEqual({ canJoin: false, reason: 'subscription_required' });
    expect(forVisitor.body.host.name).toBe('Sam');

    // An anonymous participant is a visitor, whatever plan its row claims.
    const anon = await caller('Guest', 'standard', true);
    expect((await invite(session.id, anon.headers)).body.access.reason).toBe(
      'subscription_required',
    );

    // The host is the host; a seated guest may come back in; a paid newcomer may come in.
    expect((await invite(session.id, host.headers)).body.access).toEqual({
      canJoin: true,
      reason: 'host',
    });
    expect((await invite(session.id, ana.headers)).body.access).toEqual({
      canJoin: true,
      reason: null,
    });
    const lee = await caller('Lee', 'standard');
    expect((await invite(session.id, lee.headers)).body.access).toEqual({
      canJoin: true,
      reason: null,
    });

    // And the door says what the page said: the free account is refused, in words.
    const kimSeat = await knock(kim.token, session.id);
    expect(kimSeat.answer).toBe('SUBSCRIPTION_REQUIRED');
    expect(rooms.get(session.id)?.room.getState().participants).toHaveLength(3);

    hostSeat.send({ kind: 'control', action: 'end' });
    await settle();
    // Over, the page says so instead of offering a plan.
    expect((await invite(session.id, kim.headers)).body.access).toEqual({
      canJoin: false,
      reason: 'ended',
    });
    for (const s of [hostSeat, anaSeat, benSeat, kimSeat]) s.ws.close();
  }, 60_000);

  it('an unknown session is a 404, not an empty invitation', async () => {
    const res = await fetch(`${apiUrl}/api/sessions/s_nobody_00000000/invite`);
    expect(res.status).toBe(404);
  });
});
