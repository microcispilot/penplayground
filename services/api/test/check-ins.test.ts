import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Identity } from '../src/identity.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * Quick checks are an account's to turn off (ADR-0050): on by default, kept
 * on the account, refused to a visitor who has no account to keep it on.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-check-ins-'));
let services: Services;
let app: Hono;
let identity: Identity;

async function caller(anonymous: boolean) {
  const issued = await identity.issue({ name: 'Ada', plan: 'free', anonymous });
  await services.participants.ensure({
    id: issued.claims.sub,
    name: 'Ada',
    plan: 'free',
    anonymous,
  });
  return { id: issued.claims.sub, headers: { authorization: `Bearer ${issued.token}` } };
}

const patch = (headers: Record<string, string>, body: unknown) =>
  app.request('/api/me', {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

describe('the quick-check preference', () => {
  it('is on by default, turns off and on for an account, and is read back with the account', async () => {
    const ada = await caller(false);
    const me = await app.request('/api/me', { headers: ada.headers });
    expect(((await me.json()) as { participant: { checkIns: boolean } }).participant.checkIns).toBe(
      true,
    );
    const off = await patch(ada.headers, { checkIns: false });
    expect(off.status, await off.clone().text()).toBe(200);
    expect(
      ((await off.json()) as { participant: { checkIns: boolean } }).participant.checkIns,
    ).toBe(false);
    expect((await services.participants.get(ada.id))?.checkIns).toBe(false);
    const on = await patch(ada.headers, { checkIns: true });
    expect(((await on.json()) as { participant: { checkIns: boolean } }).participant.checkIns).toBe(
      true,
    );
  });

  it('is refused to a visitor, who has no account to keep it on', async () => {
    const visitor = await caller(true);
    const res = await patch(visitor.headers, { checkIns: false });
    expect(res.status).toBe(403);
    expect((await res.json()) as object).toMatchObject({ error: 'ACCOUNT_REQUIRED' });
  });
});
