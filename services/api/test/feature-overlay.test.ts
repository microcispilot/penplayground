import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * `PEN_FEATURE_OVERLAY`, the way the Playwright servers use it (ADR-0040):
 * a document laid over the stored one that may speak for the signed-out
 * visitor, and says nothing about the features it leaves out — those keep
 * the compiled-in rule, visitor rule included.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-overlay-'));
let services: Services;
let app: Hono;
const on = { default: true, plans: {}, platforms: {}, cells: {}, anonymous: true };

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'x'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    // Answers on, preparation left to the compiled-in rule: off for a visitor.
    PEN_FEATURE_OVERLAY: JSON.stringify({ ask_questions: on, history: on }),
  });
  services = await buildServices(cfg);
  ({ app } = buildApp(services));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  await services.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function visitor() {
  const res = await app.request('/api/auth/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Visitor' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; participant: { id: string } };
  return { id: body.participant.id, headers: { authorization: `Bearer ${body.token}` } };
}

describe('the overlay', () => {
  it('speaks for the visitor where it speaks, and keeps the compiled-in rule where it does not', async () => {
    const v = await visitor();
    const res = await app.request('/api/me/features', { headers: v.headers });
    const body = (await res.json()) as { anonymous: boolean; features: Record<string, boolean> };
    expect(body.anonymous).toBe(true);
    expect(body.features.ask_questions).toBe(true);
    expect(body.features.history).toBe(true);
    expect(body.features.prepare_new_topics).toBe(false);
    expect(body.features.lists).toBe(false);
  });

  it('refuses a visitor a topic nobody has prepared, with the way in', async () => {
    const v = await visitor();
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...v.headers },
      body: JSON.stringify({ topic: 'Reading an ECG strip' }),
    });
    expect(res.status, await res.clone().text()).toBe(402);
    expect((await res.json()) as object).toMatchObject({
      error: 'PREPARATION_REQUIRED',
      upgrade: 'SignIn',
    });
  });
});
