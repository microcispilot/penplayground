import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';
import { PREPARE_FOR_EVERYONE } from './flags.js';

let services: Services;
let app: Hono;
let rooms: ReturnType<typeof buildApp>['rooms'];

interface Participant {
  token: string;
  id: string;
  name: string;
}
interface SessionJson {
  id: string;
  hostId: string;
  hostName: string;
  visibility: string;
  endedAt: number | null;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pen-anon-'));
  const cfg = loadConfig({
    // Every session here is a topic miss (no packs are seeded); the free plan's allowance is not the subject.
    PEN_FREE_CUSTOM_SESSIONS: '1000',
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    PEN_STT_PROVIDER: 'browser',
  });
  services = await buildServices(cfg, { flags: PREPARE_FOR_EVERYONE });
  ({ app, rooms } = buildApp(services));
}, 60_000);

afterAll(async () => {
  await services.db.close();
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const auth = (p: Participant | null) => (p ? { authorization: `Bearer ${p.token}` } : {});

async function anonymous(name: string): Promise<Participant> {
  const r = await app.request('/api/auth/anonymous', json({ name }));
  expect(r.status).toBe(200);
  const body = (await r.json()) as { token: string; participant: { id: string; name: string } };
  return { token: body.token, id: body.participant.id, name: body.participant.name };
}

/** An account (ADR-0040): the recording and the shelf are an account's, so the hosts here have one. */
async function account(name: string): Promise<Participant> {
  const p = await anonymous(name);
  const r = await app.request('/api/dev/me/google', {
    ...json({ name }),
    headers: { 'content-type': 'application/json', ...auth(p) },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { token: string; participant: { id: string; name: string } };
  return { token: body.token, id: body.participant.id, name: body.participant.name };
}

async function createEnded(host: Participant, visibility: 'public' | 'private'): Promise<string> {
  const r = await app.request('/api/sessions', {
    ...json({ topic: 'How Transformers work in LLMs', visibility }),
    headers: { 'content-type': 'application/json', ...auth(host) },
  });
  expect(r.status).toBe(201);
  const { session } = (await r.json()) as { session: SessionJson };
  expect(session.hostId).toBe(host.id);
  expect(session.hostName).toBe(host.name);
  const end = await app.request(`/api/sessions/${session.id}/end`, {
    method: 'POST',
    headers: auth(host),
  });
  expect(end.status).toBe(200);
  return session.id;
}

async function getSession(id: string, as: Participant | null): Promise<SessionJson> {
  const r = await app.request(`/api/sessions/${id}`, { headers: auth(as) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { session: SessionJson }).session;
}

async function getLedger(id: string, as: Participant | null) {
  const r = await app.request(`/api/sessions/${id}/ledger`, { headers: auth(as) });
  expect(r.status).toBe(200);
  return (await r.json()) as {
    session: SessionJson;
    entries: Array<{ kind: string; name?: string; participantId?: string }>;
  };
}

async function ledgerStatus(id: string, as: Participant | null): Promise<number> {
  return (await app.request(`/api/sessions/${id}/ledger`, { headers: auth(as) })).status;
}

describe('public listing anonymisation', () => {
  it('hides the host from everyone but the host across the catalog, the record and the ledger', async () => {
    const hostA = await account('Host A');
    const other = await account('Someone Else');
    const id = await createEnded(hostA, 'public');
    const privateId = await createEnded(hostA, 'private');

    // The public catalog lists the ended public session with the creator stripped.
    const list = await app.request('/api/sessions');
    expect(list.status).toBe(200);
    const { sessions } = (await list.json()) as { sessions: SessionJson[] };
    const listed = sessions.find((s) => s.id === id);
    expect(listed).toBeDefined();
    expect(listed).toMatchObject({ hostId: '', hostName: '', visibility: 'public' });
    expect(listed?.endedAt).not.toBeNull();
    expect(sessions.some((s) => s.id === privateId)).toBe(false);
    for (const s of sessions) expect([s.hostId, s.hostName]).toEqual(['', '']);

    // The record: host fields for the host's bearer only.
    expect(await getSession(id, hostA)).toMatchObject({ hostId: hostA.id, hostName: 'Host A' });
    expect(await getSession(id, null)).toMatchObject({ hostId: '', hostName: '' });
    expect(await getSession(id, other)).toMatchObject({ hostId: '', hostName: '' });
    expect(await getSession(id, { ...hostA, token: 'not-a-token' })).toMatchObject({
      hostId: '',
      hostName: '',
    });

    // The recording is the host's alone (ADR-0035): the host reads it whole,
    // with real names; everyone else — signed in or not, a public session or
    // a private one — is refused outright, and so is its audio. A recording
    // holds the learner's own questions, and a public *lesson* is not a
    // public *hour*.
    const asHost = await getLedger(id, hostA);
    const joins = asHost.entries.filter((e) => e.kind === 'join');
    expect(joins.length).toBeGreaterThan(0);
    expect(joins.map((e) => e.name)).toEqual(['Host A']);
    expect(asHost.session).toMatchObject({ hostId: hostA.id, hostName: 'Host A' });
    expect(await ledgerStatus(id, null)).toBe(401);
    expect(await ledgerStatus(id, other)).toBe(403);
    expect(await ledgerStatus(privateId, other)).toBe(403);
    expect(
      (await app.request(`/api/sessions/${id}/audio/L0.s1.0.pcm`, { headers: auth(other) })).status,
    ).toBe(403);

    // The host's own list keeps the host fields (it is theirs).
    const mine = await app.request('/api/sessions/mine', { headers: auth(hostA) });
    const { sessions: own } = (await mine.json()) as { sessions: SessionJson[] };
    expect(own.map((s) => s.id).sort()).toEqual([id, privateId].sort());
    for (const s of own) expect(s).toMatchObject({ hostId: hostA.id, hostName: 'Host A' });

    expect(rooms.get(id)?.room.getState().phase).toBe('ended');
  });
});
