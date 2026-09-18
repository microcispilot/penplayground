import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanCode } from '@pen/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * The teaching pace, kept on the account (ADR-0010).
 *
 * A learner sets the pace inside a session, the way they set a playback speed
 * inside a video, and it holds for the next one. That promise only means
 * anything if the server keeps it: the row remembers, `/api/me` hands it back,
 * and a new room is *born* at that pace rather than being corrected to it a
 * beat after the first sentence. An anonymous participant is nobody the server
 * can remember, so their device keeps the preference and their room starts at
 * the default.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-pace-'));
let services: Services;
let app: Hono;
let identity: Identity;

interface Caller {
  id: string;
  headers: Record<string, string>;
}

async function participant(anonymous: boolean, plan: PlanCode = 'free'): Promise<Caller> {
  const issued = await identity.issue({ name: 'Ada', plan, anonymous });
  await services.participants.ensure({ id: issued.claims.sub, name: 'Ada', plan, anonymous });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const patch = (body: unknown, caller: Caller) =>
  app.request('/api/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...caller.headers },
    body: JSON.stringify(body),
  });

const startSession = (caller: Caller) =>
  app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...caller.headers },
    body: JSON.stringify({ topic: 'How Transformers work in LLMs' }),
  });

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
  });
  services = await buildServices(cfg);
  identity = new Identity(cfg.PEN_JWT_SECRET);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PATCH /api/me — the teaching pace', () => {
  it('starts at 1x and is handed back with the participant', async () => {
    const me = await participant(false);
    const res = await app.request('/api/me', { headers: me.headers });
    expect(res.status).toBe(200);
    const { participant: p } = (await res.json()) as { participant: { pace: number } };
    expect(p.pace).toBe(1);
  });

  it('remembers what was chosen, in the row and on the next read', async () => {
    const me = await participant(false);
    const res = await patch({ pace: 1.3 }, me);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { participant: { pace: number } }).participant.pace).toBe(1.3);
    expect((await services.participants.get(me.id))?.pace).toBe(1.3);

    const again = await app.request('/api/me', { headers: me.headers });
    expect(((await again.json()) as { participant: { pace: number } }).participant.pace).toBe(1.3);
  });

  it('clamps a pace outside the range the board and the voice accept', async () => {
    const me = await participant(false);
    expect((await patch({ pace: 9 }, me)).status).toBe(400);
    expect((await patch({ pace: 0 }, me)).status).toBe(400);
    expect((await services.participants.get(me.id))?.pace).toBe(1);
  });

  it('still refuses a body that asks for nothing', async () => {
    const me = await participant(false);
    const res = await patch({}, me);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID');
  });

  it('leaves the name alone, and the name change leaves the pace alone', async () => {
    const me = await participant(false);
    await patch({ pace: 0.9 }, me);
    const res = await patch({ name: 'Grace' }, me);
    const { participant: p } = (await res.json()) as {
      participant: { name: string; pace: number };
    };
    expect(p.name).toBe('Grace');
    expect(p.pace).toBe(0.9);
  });
});

describe('POST /api/sessions — the room is born at the learner’s pace', () => {
  it('opens a signed-in learner’s session at the pace they kept', async () => {
    const me = await participant(false);
    await patch({ pace: 0.75 }, me);
    const res = await startSession(me);
    expect(res.status).toBe(201);
    const { state } = (await res.json()) as { state: { pace: number } };
    expect(state.pace).toBe(0.75);
  });

  it('opens an anonymous learner’s session at the default; their device decides', async () => {
    const me = await participant(true);
    await patch({ pace: 1.3 }, me);
    const res = await startSession(me);
    expect(res.status).toBe(201);
    const { state } = (await res.json()) as { state: { pace: number } };
    expect(state.pace).toBe(1);
  });
});
