import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ClientMessage, ServerMessage } from '@pen/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import type { RoomRegistry } from '../src/rooms.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';

/**
 * Who may close a room, proved over a real socket.
 *
 * The room itself has always been right about this: `SessionRoom.control`
 * refuses a guest with `NOT_HOST` and changes nothing. The socket handler then
 * ended the registry's room on the very next line, unconditionally — so the
 * refusal was answered and the session ended anyway. The REST twin
 * (`POST /api/sessions/:id/end`) checks `record.hostId`; this path did not.
 *
 * It needs no privilege beyond a seat: a guest in a Professional host's room
 * sends one frame and everybody's lesson stops, the recap is paid for, and the
 * session is written as ended.
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
  dataDir = mkdtempSync(join(tmpdir(), 'pen-room-authority-'));
  apiUrl = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_PORT: String(port),
    PEN_JWT_SECRET: 'room-authority-secret-'.repeat(3),
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

async function caller(name: string, plan: 'free' | 'professional') {
  const issued = await identity.issue({ name, plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name, plan, anonymous: true });
  return {
    id: issued.claims.sub,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
  };
}

/** A socket that has authenticated and taken its seat in `sessionId`. */
function seat(
  token: string,
  sessionId: string,
): Promise<{ ws: WebSocket; send: (m: ClientMessage) => void; errors: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${apiUrl.replace('http', 'ws')}/ws/room`);
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    const errors: ServerMessage[] = [];
    const timer = setTimeout(() => reject(new Error('never took a seat')), 20_000);
    ws.on('open', () => {
      send({ kind: 'auth', token });
      send({ kind: 'join', sessionId });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.kind === 'error') errors.push(msg);
      if (msg.kind === 'ready') {
        clearTimeout(timer);
        resolve({ ws, send, errors });
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 400));

describe('ending a room over the socket', () => {
  it("is the host's alone: a guest is refused and the lesson goes on", async () => {
    const hostCaller = await caller('Ada', 'professional');
    const guestCaller = await caller('Kim', 'free');
    const created = await fetch(`${apiUrl}/api/sessions`, {
      method: 'POST',
      headers: hostCaller.headers,
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const hostSeat = await seat(hostCaller.token, session.id);
    const guestSeat = await seat(guestCaller.token, session.id);
    expect(rooms.get(session.id)?.room.getState().phase).not.toBe('ended');

    guestSeat.send({ kind: 'control', action: 'end' });
    await settle();

    // The room told the guest no …
    expect(guestSeat.errors.map((e) => (e.kind === 'error' ? e.code : ''))).toContain('NOT_HOST');
    // … and the session is still the host's to end.
    expect(rooms.get(session.id)?.room.getState().phase).not.toBe('ended');

    // Which the host then does, and it ends.
    hostSeat.send({ kind: 'control', action: 'end' });
    await settle();
    expect(rooms.get(session.id)?.room.getState().phase).toBe('ended');

    hostSeat.ws.close();
    guestSeat.ws.close();
  }, 60_000);
});

/**
 * A frame that is not JSON at all.
 *
 * The bad-frame counter and `close(4002)` lived only in the branch that
 * handles a frame which *parsed* and did not match the protocol. `JSON.parse`
 * sat outside it, inside the handler's `try`, so `{` threw straight past the
 * counter into the outer catch: one `observer.error('ws.message')` — a Sentry
 * issue — and one `INTERNAL` per frame, for as long as an authenticated
 * socket cared to keep sending. Nothing ever closed it.
 */
describe('a socket that sends nonsense', () => {
  it('is counted and closed, not reported as our own failure', async () => {
    const hostCaller = await caller('Ada', 'professional');
    const created = await fetch(`${apiUrl}/api/sessions`, {
      method: 'POST',
      headers: hostCaller.headers,
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const taken = await seat(hostCaller.token, session.id);
    const closed = new Promise<number>((resolve) => taken.ws.on('close', resolve));

    // Well past MAX_BAD_FRAMES, so a counter that never counts is obvious.
    for (let i = 0; i < 20; i++) taken.ws.send('{');
    const code = await Promise.race([
      closed,
      new Promise<number>((r) => setTimeout(() => r(0), 5_000)),
    ]);

    expect(code, 'the socket is closed with the bad-frame code').toBe(4002);
    const codes = taken.errors.map((e) => (e.kind === 'error' ? e.code : ''));
    // The client's mistake, told to the client as such …
    expect(codes).toContain('BAD_MESSAGE');
    // … and never as ours, which is what filed a Sentry issue per frame.
    expect(codes).not.toContain('INTERNAL');

    // The lesson is untouched: one socket misbehaving is not the room's problem.
    expect(rooms.get(session.id)?.room.getState().phase).not.toBe('ended');
    await fetch(`${apiUrl}/api/sessions/${session.id}/end`, {
      method: 'POST',
      headers: hostCaller.headers,
    });
  }, 60_000);
});
