import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildServices, type Services } from '../src/services.js';

/**
 * `GET /api/ready` against a real API: the compose healthcheck, the edge and
 * the uptime monitor all read this status code, so both sides of it are
 * locked — 200 while the stack can serve, 503 (with the failing check named)
 * the moment its database is gone.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'pen-ready-route-'));
let services: Services;
let fetchApp: (path: string) => Promise<Response>;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'r'.repeat(40),
    PEN_DATA_DIR: dataDir,
    DATABASE_URL: 'pglite://memory',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
  });
  services = await buildServices(cfg);
  const { app } = buildApp(services);
  fetchApp = (path) => Promise.resolve(app.request(path));
}, 60_000);

afterAll(async () => {
  services.exports.close();
  services.meta.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/ready', () => {
  it('is 200 with every check green while the stack can serve a lesson', async () => {
    const res = await fetchApp('/api/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: { db: { ok: boolean }; dataDir: { ok: boolean }; providers: { ok: boolean } };
      ms: number;
    };
    expect(body.ok).toBe(true);
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.dataDir.ok).toBe(true);
    expect(body.checks.providers.ok).toBe(true);
    expect(body.ms).toBeGreaterThanOrEqual(0);
  });

  it('never needs a bearer: it is read by machines, and it carries nothing private', async () => {
    const body = await fetchApp('/api/ready').then((r) => r.text());
    expect(body).not.toMatch(/secret|token|password|postgres:\/\//i);
  });

  it('is 503 naming the failed check once the database is gone, while /api/health stays 200', async () => {
    await services.db.close();
    // The good answer is cached for a moment; wait it out so this is the live probe.
    await new Promise((r) => setTimeout(r, 1_100));

    const res = await fetchApp('/api/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: { db: { ok: boolean } } };
    expect(body.ok).toBe(false);
    expect(body.checks.db.ok).toBe(false);

    // Health is the human's "what is this process" answer and must not flap with a dependency.
    const health = await fetchApp('/api/health');
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
  }, 15_000);
});
