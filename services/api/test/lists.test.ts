import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type GoogleProfile, GoogleTokenError, type GoogleTokenVerifier } from '../src/google.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

/** Tokens are looked up by value; anything unknown is invalid. */
class FakeVerifier implements GoogleTokenVerifier {
  constructor(private readonly known: Record<string, GoogleProfile>) {}
  async verify(idToken: string): Promise<GoogleProfile> {
    const profile = this.known[idToken];
    if (!profile) throw new GoogleTokenError('invalid', 'Invalid token signature');
    return profile;
  }
}

const ada: GoogleProfile = {
  sub: '3000-ada',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada Lovelace',
  avatarUrl: null,
};

const dataDir = mkdtempSync(join(tmpdir(), 'pen-lists-'));
let services: Services;
let app: Hono;

interface Participant {
  token: string;
  id: string;
}
interface SessionJson {
  id: string;
  hostId: string;
  likes: number;
  visit?: { role: string; at: number };
}

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
    GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
  });
  services = await buildServices(cfg, {
    flags: PREPARE_FOR_EVERYONE,
    googleVerifier: new FakeVerifier({ 'ok:ada-0123456789abcdef': ada }),
  });
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = (p: Participant | null) => (p ? { authorization: `Bearer ${p.token}` } : {});
const call = (method: string, path: string, as: Participant | null, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...auth(as) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function anonymous(name: string): Promise<Participant> {
  const r = await call('POST', '/api/auth/anonymous', null, { name });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { token: string; participant: { id: string } };
  return { token: body.token, id: body.participant.id };
}

async function createEnded(host: Participant): Promise<string> {
  const r = await call('POST', '/api/sessions', host, { topic: 'How Transformers work in LLMs' });
  expect(r.status).toBe(201);
  const { session } = (await r.json()) as { session: SessionJson };
  expect((await call('POST', `/api/sessions/${session.id}/end`, host)).status).toBe(200);
  return session.id;
}

async function summary(as: Participant) {
  const r = await call('GET', '/api/me/lists', as);
  expect(r.status).toBe(200);
  return (await r.json()) as {
    savedIds: string[];
    likedIds: string[];
    counts: { hosted: number; history: number; saved: number; liked: number };
  };
}

async function listed(path: string, as: Participant): Promise<SessionJson[]> {
  const r = await call('GET', path, as);
  expect(r.status).toBe(200);
  return ((await r.json()) as { sessions: SessionJson[] }).sessions;
}

describe('lists API (ADR-0015)', () => {
  it('every list route wants a bearer', async () => {
    for (const [method, path] of [
      ['GET', '/api/me/lists'],
      ['GET', '/api/me/history'],
      ['GET', '/api/me/saved'],
      ['GET', '/api/me/liked'],
      ['GET', '/api/me/downloads'],
      ['PUT', '/api/sessions/s_00000000/save'],
      ['DELETE', '/api/sessions/s_00000000/save'],
      ['PUT', '/api/sessions/s_00000000/like'],
      ['DELETE', '/api/sessions/s_00000000/like'],
    ] as const) {
      const r = await call(method, path, null);
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it('a fresh participant has empty lists; unknown or malformed session ids are 404', async () => {
    const p = await anonymous('Fresh');
    expect(await summary(p)).toEqual({
      savedIds: [],
      likedIds: [],
      counts: { hosted: 0, history: 0, saved: 0, liked: 0 },
    });
    expect((await call('PUT', '/api/sessions/s_does_not_exist/save', p)).status).toBe(404);
    expect((await call('PUT', '/api/sessions/x/like', p)).status).toBe(404);
    expect((await call('PUT', '/api/sessions/../../etc/like', p)).status).toBe(404);
  });

  it('save and like are idempotent pairs; the public like count is one per person', async () => {
    const host = await anonymous('Host');
    const fan = await anonymous('Fan');
    const id = await createEnded(host);

    expect(await (await call('PUT', `/api/sessions/${id}/save`, fan)).json()).toEqual({
      saved: true,
    });
    expect(await (await call('PUT', `/api/sessions/${id}/save`, fan)).json()).toEqual({
      saved: true,
    });
    expect(await (await call('PUT', `/api/sessions/${id}/like`, fan)).json()).toEqual({
      liked: true,
      likes: 1,
    });
    // Liking twice does not count twice.
    expect(await (await call('PUT', `/api/sessions/${id}/like`, fan)).json()).toEqual({
      liked: true,
      likes: 1,
    });
    expect(await (await call('PUT', `/api/sessions/${id}/like`, host)).json()).toEqual({
      liked: true,
      likes: 2,
    });
    const s = await summary(fan);
    expect(s.savedIds).toEqual([id]);
    expect(s.likedIds).toEqual([id]);
    expect(s.counts).toMatchObject({ saved: 1, liked: 1, hosted: 0 });

    // The public catalog and the record carry the count; the host is still hidden.
    const list = await call('GET', '/api/sessions', null);
    const { sessions } = (await list.json()) as { sessions: SessionJson[] };
    const card = sessions.find((x) => x.id === id);
    expect(card).toMatchObject({ likes: 2, hostId: '' });
    const saved = await listed('/api/me/saved', fan);
    expect(saved.map((x) => x.id)).toEqual([id]);
    expect(saved[0]).toMatchObject({ hostId: '', likes: 2 });
    expect((await listed('/api/me/liked', host))[0]).toMatchObject({ hostId: host.id });

    expect(await (await call('DELETE', `/api/sessions/${id}/like`, fan)).json()).toEqual({
      liked: false,
      likes: 1,
    });
    expect(await (await call('DELETE', `/api/sessions/${id}/like`, fan)).json()).toEqual({
      liked: false,
      likes: 1,
    });
    expect(await (await call('DELETE', `/api/sessions/${id}/save`, fan)).json()).toEqual({
      saved: false,
    });
    expect((await summary(fan)).counts).toMatchObject({ saved: 0, liked: 0 });
    // Only the fan's own rows moved: the host's like is intact.
    expect((await summary(host)).likedIds).toEqual([id]);
  });

  it('history is what you sat in, most recent seat first, and the host role is kept', async () => {
    const host = await anonymous('Historian');
    const guest = await anonymous('Guest');
    const first = await createEnded(host);
    const second = await createEnded(host);
    // Seats are recorded by the room registry when a socket attaches; simulate the guest's seat.
    await services.lists.visit(guest.id, first, 'guest', Date.now() + 1);
    const asHost = await listed('/api/me/history', host);
    expect(asHost.map((s) => s.id)).toEqual([second, first]);
    expect(asHost[0]?.visit?.role).toBe('host');
    expect(asHost[0]?.hostId).toBe(host.id);
    const asGuest = await listed('/api/me/history', guest);
    expect(asGuest.map((s) => [s.id, s.visit?.role, s.hostId])).toEqual([[first, 'guest', '']]);
    expect((await summary(host)).counts).toMatchObject({ hosted: 2, history: 2 });
    expect((await summary(guest)).counts).toMatchObject({ hosted: 0, history: 1 });
  });

  it('a Google sign-in onto an existing account adopts the anonymous lists', async () => {
    // The account: Ada's first device, upgraded in place, with one like of her own.
    const device1 = await anonymous('Ada');
    const own = await createEnded(device1);
    const signedIn = await call('POST', '/api/identity/google', device1, {
      idToken: 'ok:ada-0123456789abcdef',
    });
    expect(signedIn.status).toBe(200);
    const account = (await signedIn.json()) as { token: string; participant: { id: string } };
    expect(account.participant.id).toBe(device1.id);
    const ada1: Participant = { token: account.token, id: account.participant.id };
    await call('PUT', `/api/sessions/${own}/like`, ada1);

    // A second device, anonymous: saved + liked the same session, hosted another, sat in a third.
    const device2 = await anonymous('Learner');
    const hostedAnon = await createEnded(device2);
    const someone = await anonymous('Someone');
    const visited = await createEnded(someone);
    await services.lists.visit(device2.id, visited, 'guest');
    await call('PUT', `/api/sessions/${own}/save`, device2);
    await call('PUT', `/api/sessions/${own}/like`, device2);
    await call('PUT', `/api/sessions/${visited}/like`, device2);
    expect(
      (await (await call('GET', `/api/sessions/${own}`, null)).json()) as object,
    ).toMatchObject({ session: { likes: 2 } });

    const again = await call('POST', '/api/identity/google', device2, {
      idToken: 'ok:ada-0123456789abcdef',
    });
    expect(again.status).toBe(200);
    const merged = (await again.json()) as {
      token: string;
      outcome: string;
      participant: { id: string };
    };
    expect(merged.outcome).toBe('existing');
    expect(merged.participant.id).toBe(ada1.id);
    const ada2: Participant = { token: merged.token, id: merged.participant.id };

    const s = await summary(ada2);
    expect(s.savedIds).toEqual([own]);
    expect(s.likedIds.sort()).toEqual([own, visited].sort());
    // Sessions hosted anonymously came along (existing behaviour) and so did the visits.
    expect(s.counts).toMatchObject({ hosted: 2, saved: 1, liked: 2 });
    expect((await listed('/api/me/history', ada2)).map((x) => x.id)).toEqual(
      expect.arrayContaining([own, hostedAnon, visited]),
    );
    // The duplicate like (both devices liked `own`) is counted once in public.
    expect(
      (await (await call('GET', `/api/sessions/${own}`, null)).json()) as object,
    ).toMatchObject({ session: { likes: 1 } });
    // Nothing stays on the abandoned anonymous row.
    expect(await summary(device2)).toMatchObject({ savedIds: [], likedIds: [] });
  });

  it('downloads lists only hosted, ended sessions with a rendered MP4', async () => {
    const host = await anonymous('Downloader');
    await createEnded(host);
    // No renderer has run in this process: nothing is ready.
    expect(await listed('/api/me/downloads', host)).toEqual([]);
  });

  it('the dev sign-in hook upgrades the caller in place and is bearer-only', async () => {
    expect((await call('POST', '/api/dev/me/google', null, {})).status).toBe(401);
    const p = await anonymous('Sam');
    const r = await call('POST', '/api/dev/me/google', p, { name: 'Sam Dev' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      token: string;
      participant: { id: string; anonymous: boolean; name: string; email: string | null };
    };
    expect(body.participant).toMatchObject({ id: p.id, anonymous: false, name: 'Sam Dev' });
    expect(body.participant.email).toContain('@example.test');
    const me = await call('GET', '/api/me', { token: body.token, id: p.id });
    expect(
      ((await me.json()) as { participant: { anonymous: boolean } }).participant.anonymous,
    ).toBe(false);
    expect((await call('POST', '/api/dev/me/google', p, { email: 'nope' })).status).toBe(400);
  });
});
