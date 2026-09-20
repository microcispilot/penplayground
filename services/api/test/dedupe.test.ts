import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * A telling of a lesson that was collapsed into another (ADR-0031): the link
 * somebody already has, and the rows a deletion used to leave behind.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-dedupe-'));
let services: Services;
let app: Hono;

interface Participant {
  token: string;
  id: string;
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
  });
  services = await buildServices(cfg);
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

async function createEnded(host: Participant, topic: string): Promise<string> {
  const r = await call('POST', '/api/sessions', host, { topic });
  expect(r.status).toBe(201);
  const { session } = (await r.json()) as { session: { id: string } };
  expect((await call('POST', `/api/sessions/${session.id}/end`, host)).status).toBe(200);
  return session.id;
}

describe('a link to a session that was collapsed into another', () => {
  it('opens the lesson that was kept instead of answering 404', async () => {
    const host = await anonymous('Grace');
    const kept = await createEnded(host, 'How Transformers work in LLMs');
    const gone = await createEnded(host, 'How Transformers work in LLMs');

    // Before the collapse both links answer with their own session.
    const before = await call('GET', `/api/sessions/${gone}`, null);
    expect(((await before.json()) as { session: { id: string } }).session.id).toBe(gone);

    await services.sessions.remove(gone);
    await services.sessions.redirect(gone, kept, 'duplicate');

    const after = await call('GET', `/api/sessions/${gone}`, null);
    expect(after.status).toBe(200);
    expect(((await after.json()) as { session: { id: string } }).session.id).toBe(kept);

    // The replay reads the kept session's recording, not an empty one.
    const ledger = await call('GET', `/api/sessions/${gone}/ledger`, null);
    expect(ledger.status).toBe(200);
    const replay = (await ledger.json()) as {
      session: { id: string };
      entries: Array<{ kind: string }>;
    };
    expect(replay.session.id).toBe(kept);
    expect(replay.entries.length).toBeGreaterThan(0);

    // And the share page carries the kept session's canonical URL, so a
    // crawler and a human both land on the lesson rather than on nothing.
    const share = await app.request(`/s/${gone}`);
    expect(share.status).toBe(200);
    expect(await share.text()).toContain(`/sessions/${kept}`);
  });

  it('still says 404 for an id that never existed', async () => {
    expect((await call('GET', '/api/sessions/AAAAAAAAAAAA', null)).status).toBe(404);
    expect((await app.request('/s/AAAAAAAAAAAA')).status).toBe(404);
  });
});

describe('deleting a session', () => {
  it('takes its saves, likes and history with it instead of orphaning them', async () => {
    const host = await anonymous('Ada');
    const reader = await anonymous('Sam');
    const id = await createEnded(host, 'Swift fundamentals');
    expect((await call('PUT', `/api/sessions/${id}/save`, reader)).status).toBe(200);
    expect((await call('PUT', `/api/sessions/${id}/like`, reader)).status).toBe(200);

    // The pairs exist: the reader's shelves name this session.
    expect(await services.lists.summary(reader.id)).toMatchObject({
      savedIds: [id],
      likedIds: [id],
    });
    expect(existsSync(join(dataDir, 'sessions', id))).toBe(true);

    expect((await call('DELETE', `/api/sessions/${id}`, host)).status).toBe(200);

    // The lists inner-join `sessions`, so a leftover pair would be invisible
    // rather than gone. Ask the table itself.
    expect(await services.lists.forgetSession(id)).toBe(0);
    expect(await services.lists.summary(reader.id)).toMatchObject({
      savedIds: [],
      likedIds: [],
      counts: { saved: 0, liked: 0, history: 0 },
    });
    expect(existsSync(join(dataDir, 'sessions', id))).toBe(false);
  });
});
