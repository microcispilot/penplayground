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
import { ABSENT_ROOM_MS, type RoomRegistry } from '../src/rooms.js';
import { seedPacks } from '../src/seed-packs.js';
import { buildServices, DATA_DIR, type Services } from '../src/services.js';

/**
 * A closed tab (ADR-0049), over a real socket: the room pauses the moment
 * the host's socket goes, a reconnect within the grace finds the same
 * lesson waiting, and the sweeper ends a room by how long it has been
 * empty, not by how old it is.
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
  dataDir = mkdtempSync(join(tmpdir(), 'pen-abandoned-'));
  apiUrl = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_PORT: String(port),
    PEN_JWT_SECRET: 'abandoned-room-secret-'.repeat(3),
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

async function host() {
  const issued = await identity.issue({ name: 'Ada', plan: 'professional', anonymous: false });
  await services.participants.ensure({
    id: issued.claims.sub,
    name: 'Ada',
    plan: 'professional',
    anonymous: false,
  });
  return {
    id: issued.claims.sub,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
  };
}

function seat(
  token: string,
  sessionId: string,
): Promise<{ ws: WebSocket; send: (m: ClientMessage) => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${apiUrl.replace('http', 'ws')}/ws/room`);
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    const timer = setTimeout(() => reject(new Error('never took a seat')), 20_000);
    ws.on('open', () => {
      send({ kind: 'auth', token });
      send({ kind: 'join', sessionId });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.kind === 'ready') {
        clearTimeout(timer);
        resolve({ ws, send });
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('a room whose host closed the tab', () => {
  it('pauses at once, waits through the grace, and is ended by absence rather than age', async () => {
    const ada = await host();
    const created = await fetch(`${apiUrl}/api/sessions`, {
      method: 'POST',
      headers: ada.headers,
      body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    const live = rooms.get(session.id);
    expect(live).toBeDefined();
    // Nobody seated yet: the clock started at birth.
    expect(live?.emptySince).not.toBeNull();

    const first = await seat(ada.token, session.id);
    expect(live?.emptySince).toBeNull();
    await until(() => live?.room.getState().mode === 'teaching');

    // The tab closes: no message, just the socket.
    first.ws.close();
    await until(() => live?.emptySince !== null);
    await until(() => live?.room.getState().mode === 'paused');
    const emptySince = live?.emptySince as number;

    // Well within the grace, the sweeper leaves it alone, however old the room is.
    rooms.sweep(emptySince + ABSENT_ROOM_MS - 1_000);
    expect(live?.room.getState().phase).not.toBe('ended');

    // Back before the grace runs out: the same room, waiting.
    const second = await seat(ada.token, session.id);
    expect(live?.emptySince).toBeNull();
    expect(live?.room.getState().mode).toBe('paused');
    second.send({ kind: 'control', action: 'resume' });
    await until(() => live?.room.getState().mode === 'teaching');

    // Gone again, and this time for good.
    second.ws.close();
    await until(() => live?.emptySince !== null);
    rooms.sweep((live?.emptySince as number) + ABSENT_ROOM_MS + 1);
    await until(() => live?.room.getState().phase === 'ended');
    // The registry lets an ended room go on its own schedule; ended is what matters here.
  }, 60_000);
});
