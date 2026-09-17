import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { LiveKitRooms, type RoomServicePort } from '../src/livekit.js';
import type { LiveRoom } from '../src/rooms.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The room-audio routes against a real `Services` (PGlite in memory, fake
 * model, silent synthesizer) with LiveKit's HTTP API replaced by a fake. Tokens
 * are real (signed by the SDK) and decoded here to check every grant.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-rooms-audio-'));
const API_KEY = 'devkey';
const API_SECRET = 'secret-with-enough-bytes-for-hs256!!';
let services: Services;
let built: App;
let identity: Identity;
let fetchApp: (path: string, init?: RequestInit) => Promise<Response>;
const created: LiveRoom[] = [];

/** In-memory stand-in for LiveKit's RoomService: who is connected, what they publish, what got muted. */
class FakeRoomService implements RoomServicePort {
  readonly rooms = new Map<string, Map<string, string[]>>();
  readonly mutes: Array<{ room: string; identity: string; trackSid: string; muted: boolean }> = [];
  readonly deleted: string[] = [];
  connect(room: string, identity: string, audioTrackSids: string[]): void {
    const participants = this.rooms.get(room) ?? new Map<string, string[]>();
    participants.set(identity, audioTrackSids);
    this.rooms.set(room, participants);
  }
  async listParticipants(room: string) {
    return [...(this.rooms.get(room) ?? new Map<string, string[]>())].map(
      ([identity, audioTrackSids]) => ({ identity, audioTrackSids }),
    );
  }
  async getParticipant(room: string, identity: string) {
    const sids = this.rooms.get(room)?.get(identity);
    return sids ? { identity, audioTrackSids: sids } : null;
  }
  async muteTrack(room: string, identity: string, trackSid: string, muted: boolean) {
    this.mutes.push({ room, identity, trackSid, muted });
  }
  async deleteRoom(room: string) {
    this.deleted.push(room);
    this.rooms.delete(room);
  }
}
let roomService: FakeRoomService;

async function participant(plan: 'free' | 'standard' | 'professional', name = 'Ada') {
  const issued = await identity.issue({ name, plan, anonymous: true });
  await services.participants.ensure({ id: issued.claims.sub, name, plan, anonymous: true });
  return {
    id: issued.claims.sub,
    name,
    plan,
    auth: { authorization: `Bearer ${issued.token}` },
  };
}

async function liveSession(host: {
  id: string;
  name: string;
  plan: 'free' | 'standard' | 'professional';
}) {
  const live = await built.rooms.create({
    topic: 'How Transformers work in LLMs',
    host,
    band: 'beginner',
    visibility: 'public',
  });
  created.push(live);
  return live;
}

const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  fetchApp(path, {
    method: 'POST',
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    LIVEKIT_URL: 'wss://rooms.test/livekit',
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
  });
  services = await buildServices(cfg);
  roomService = new FakeRoomService();
  services.livekit = new LiveKitRooms({
    url: cfg.LIVEKIT_URL ?? '',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    roomService,
  });
  identity = new Identity(cfg.PEN_JWT_SECRET);
  built = buildApp(services);
  fetchApp = (path, init) => Promise.resolve(built.app.request(path, init));
}, 60_000);

afterAll(async () => {
  for (const live of created) await built.rooms.end(live.record.id);
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports rooms:true when LiveKit is configured and rooms:false otherwise', async () => {
    expect((await (await fetchApp('/api/health')).json()).rooms).toBe(true);
    const off = buildApp({ ...services, livekit: null });
    expect((await (await off.app.request('/api/health')).json()).rooms).toBe(false);
  });
});

describe('POST /api/rooms/:id/token', () => {
  it('503 ROOMS_UNAVAILABLE when the feature is off', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const off = buildApp({ ...services, livekit: null });
    const res = await off.app.request(`/api/rooms/${live.record.id}/token`, {
      method: 'POST',
      headers: host.auth,
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('ROOMS_UNAVAILABLE');
  });

  it('401 without a bearer, 404 for a session that is not live', async () => {
    expect((await post('/api/rooms/s_not_live_0/token', {})).status).toBe(401);
    const host = await participant('professional');
    const res = await post('/api/rooms/s_not_live_0/token', host.auth);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('SESSION_NOT_LIVE');
  });

  it('mints a host token: identity, name, room, publish + subscribe + roomAdmin, bounded ttl', async () => {
    const host = await participant('professional', 'Grace');
    const live = await liveSession(host);
    const res = await post(`/api/rooms/${live.record.id}/token`, host.auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('wss://rooms.test/livekit');
    expect(body).toMatchObject({ canPublish: true, roomAdmin: true });
    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe(host.id);
    expect(claims.iss).toBe(API_KEY);
    expect(claims.name).toBe('Grace');
    expect(claims.video).toMatchObject({
      room: live.record.id,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: true,
    });
    const ttl = (claims.exp ?? 0) - (claims.nbf ?? claims.iat ?? 0);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3 * 60 * 60);
  });

  it('mints a guest token that can publish and subscribe but is not roomAdmin', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const guest = await participant('free', 'Linus');
    expect(live.room.join({ id: guest.id, name: guest.name }).ok).toBe(true);
    const res = await post(`/api/rooms/${live.record.id}/token`, guest.auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ canPublish: true, roomAdmin: false });
    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe(guest.id);
    expect(claims.name).toBe('Linus');
    expect(claims.video).toMatchObject({
      room: live.record.id,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      roomAdmin: false,
    });
  });

  it('403 NOT_MEMBER for a signed-in participant who has not joined the room', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const stranger = await participant('professional');
    const res = await post(`/api/rooms/${live.record.id}/token`, stranger.auth);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('NOT_MEMBER');
  });

  it('402 ENTITLEMENT_REQUIRED for a free host, naming the Professional plan', async () => {
    const host = await participant('free');
    const live = await liveSession(host);
    expect(live.room.getState().participantAudio).toBe(false);
    const res = await post(`/api/rooms/${live.record.id}/token`, host.auth);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('ENTITLEMENT_REQUIRED');
    expect(body.message).toMatch(/Professional/);
  });

  it('the room state advertises participant audio for a Professional host', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    expect(live.room.getState().participantAudio).toBe(true);
  });
});

describe('POST /api/rooms/:id/mute', () => {
  it('403 NOT_HOST for a guest', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const guest = await participant('free');
    live.room.join({ id: guest.id, name: guest.name });
    const res = await post(`/api/rooms/${live.record.id}/mute`, guest.auth, {
      participantId: host.id,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('NOT_HOST');
  });

  it('mutes one guest: every audio track they publish on the media server', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const guest = await participant('free');
    live.room.join({ id: guest.id, name: guest.name });
    roomService.connect(live.record.id, host.id, ['TR_host']);
    roomService.connect(live.record.id, guest.id, ['TR_guest_a', 'TR_guest_b']);
    const res = await post(`/api/rooms/${live.record.id}/mute`, host.auth, {
      participantId: guest.id,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).muted).toEqual([guest.id]);
    expect(roomService.mutes.filter((m) => m.room === live.record.id)).toEqual([
      { room: live.record.id, identity: guest.id, trackSid: 'TR_guest_a', muted: true },
      { room: live.record.id, identity: guest.id, trackSid: 'TR_guest_b', muted: true },
    ]);
  });

  it('404 NOT_MEMBER for a target outside the room; an empty result for a member not connected to media', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const guest = await participant('free');
    live.room.join({ id: guest.id, name: guest.name });
    const outside = await participant('free');
    const res = await post(`/api/rooms/${live.record.id}/mute`, host.auth, {
      participantId: outside.id,
    });
    expect(res.status).toBe(404);
    const quiet = await post(`/api/rooms/${live.record.id}/mute`, host.auth, {
      participantId: guest.id,
    });
    expect(quiet.status).toBe(200);
    expect((await quiet.json()).muted).toEqual([]);
  });

  it('mutes everyone but the host when no participant is named', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const a = await participant('free', 'A');
    const b = await participant('free', 'B');
    live.room.join({ id: a.id, name: a.name });
    live.room.join({ id: b.id, name: b.name });
    roomService.connect(live.record.id, host.id, ['TR_host']);
    roomService.connect(live.record.id, a.id, ['TR_a']);
    roomService.connect(live.record.id, b.id, []);
    const res = await post(`/api/rooms/${live.record.id}/mute`, host.auth);
    expect(res.status).toBe(200);
    expect((await res.json()).muted).toEqual([a.id]);
    const mutes = roomService.mutes.filter((m) => m.room === live.record.id);
    expect(mutes).toEqual([
      { room: live.record.id, identity: a.id, trackSid: 'TR_a', muted: true },
    ]);
  });

  it('ending the session deletes the media room', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    roomService.connect(live.record.id, host.id, ['TR_host']);
    await built.rooms.end(live.record.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(roomService.deleted).toContain(live.record.id);
    // And nobody can mint a token for it any more.
    const res = await post(`/api/rooms/${live.record.id}/token`, host.auth);
    expect(res.status).toBe(404);
  });

  it('502 ROOMS_FAILED when the media server cannot be reached', async () => {
    const host = await participant('professional');
    const live = await liveSession(host);
    const broken: RoomServicePort = {
      listParticipants: async () => {
        throw new Error('ECONNREFUSED');
      },
      getParticipant: async () => {
        throw new Error('ECONNREFUSED');
      },
      muteTrack: async () => undefined,
      deleteRoom: async () => undefined,
    };
    const app = buildApp({
      ...services,
      livekit: new LiveKitRooms({
        url: 'wss://rooms.test/livekit',
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        roomService: broken,
      }),
    });
    // The room registry is per app; reuse the live room by attaching through the same services.
    const res = await app.app.request(`/api/rooms/${live.record.id}/mute`, {
      method: 'POST',
      headers: host.auth,
    });
    // A fresh app has no live rooms: the failure surfaces as "not live" rather than a media error.
    expect(res.status).toBe(404);
    // Drive the failure through the shared app instead.
    const original = services.livekit;
    services.livekit = new LiveKitRooms({
      url: 'wss://rooms.test/livekit',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      roomService: broken,
    });
    try {
      const failed = await post(`/api/rooms/${live.record.id}/mute`, host.auth);
      expect(failed.status).toBe(502);
      expect((await failed.json()).error).toBe('ROOMS_FAILED');
    } finally {
      services.livekit = original;
    }
  });
});
